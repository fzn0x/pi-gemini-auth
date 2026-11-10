// The account pool. Each request goes to one Google account; a 429 puts that
// account on cooldown for that model and the request moves to the next one.

import { statSync } from "node:fs";
import { apiHeaders, type GoogleConfig } from "./google/constants.ts";
import { OAuthError, refreshAccessToken } from "./google/oauth.ts";
import { classify, errorMessage, HttpError, retryDelayMs, sleep } from "./retry.ts";
import { type Account, loadAccounts, patchAccount, type Strategy, storeFiles } from "./store.ts";

const DEFAULT_COOLDOWN_MS = 60_000;
const FORBIDDEN_COOLDOWN_MS = 30 * 60_000;
const TOKEN_SKEW_MS = 2 * 60_000;
/** Wait this long at most for a cooling account before telling the client to retry later. */
const MAX_WAIT_MS = 20_000;

export interface AccountState {
  account: Account;
  accessToken?: string;
  expiresAt: number;
  refreshing?: Promise<string>;
  /** model id (or "*") -> epoch ms when the account may be used again */
  cooldowns: Map<string, number>;
  lastError?: string;
  requests: number;
  rateLimits: number;
}

export interface RotatorOptions {
  google: GoogleConfig;
  /** Store folder. Accounts are re-read when its accounts.json changes. */
  dir?: string;
  strategy?: Strategy;
  log?: (line: string) => void;
  now?: () => number;
  maxWaitMs?: number;
}

export interface Attempt {
  response: Response;
  state: AccountState;
}

/** Thrown when no account could serve the request. Carries the status for the client. */
export class RotatorError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "RotatorError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class Rotator {
  states: AccountState[] = [];
  private readonly opts: RotatorOptions;
  private readonly cursor = new Map<string, number>();
  private fileStamp = 0;
  private lastStatAt = 0;

  constructor(accounts: Account[], opts: RotatorOptions) {
    this.opts = opts;
    this.setAccounts(accounts);
    if (opts.dir) this.fileStamp = this.stamp();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  setAccounts(accounts: Account[]): void {
    const old = new Map(this.states.map((s) => [s.account.email.toLowerCase(), s]));
    this.states = accounts.map((account) => {
      const prev = old.get(account.email.toLowerCase());
      if (prev && prev.account.refreshToken === account.refreshToken) {
        prev.account = account;
        return prev;
      }
      return { account, expiresAt: 0, cooldowns: new Map(), requests: 0, rateLimits: 0 };
    });
  }

  private stamp(): number {
    try {
      return statSync(storeFiles(this.opts.dir!).accounts).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Pick up `login` / `logout` done while the rotator runs. Checked at most every 2s. */
  async refreshAccountsIfChanged(): Promise<void> {
    if (!this.opts.dir || this.now() - this.lastStatAt < 2000) return;
    this.lastStatAt = this.now();
    const stamp = this.stamp();
    if (stamp === this.fileStamp) return;
    this.fileStamp = stamp;
    this.setAccounts(await loadAccounts(this.opts.dir));
    this.log(`Accounts reloaded: ${this.states.length}`);
  }

  private coolingUntil(s: AccountState, model: string): number {
    return Math.max(s.cooldowns.get(model) ?? 0, s.cooldowns.get("*") ?? 0);
  }

  usable(s: AccountState): boolean {
    return !s.account.disabled;
  }

  /** Next account for this model, or how long until one frees up. */
  pick(model: string, skip: Set<AccountState>): AccountState | { waitMs: number } | undefined {
    const now = this.now();
    const n = this.states.length;
    const start = this.cursor.get(model) ?? 0;
    let soonest = Infinity;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const s = this.states[i]!;
      if (!this.usable(s) || skip.has(s)) continue;
      const until = this.coolingUntil(s, model);
      if (until > now) {
        soonest = Math.min(soonest, until - now);
        continue;
      }
      // sticky keeps the cursor on this account; round-robin moves past it.
      this.cursor.set(model, this.opts.strategy === "round-robin" ? (i + 1) % n : i);
      return s;
    }
    return Number.isFinite(soonest) ? { waitMs: soonest } : undefined;
  }

  cooldown(s: AccountState, model: string, ms: number, reason: string): void {
    s.cooldowns.set(model, this.now() + ms);
    s.lastError = reason;
    this.log(`${s.account.email}: cooling down ${model === "*" ? "all models" : model} for ${Math.ceil(ms / 1000)}s (${reason})`);
  }

  private async disable(s: AccountState, reason: string): Promise<void> {
    s.account.disabled = true;
    s.account.lastError = reason;
    s.lastError = reason;
    this.log(`${s.account.email}: disabled (${reason}). Run: pi-gemini-auth login`);
    if (this.opts.dir) await patchAccount(this.opts.dir, s.account.email, { disabled: true, lastError: reason }).catch(() => {});
  }

  async token(s: AccountState, signal?: AbortSignal): Promise<string> {
    if (s.accessToken && s.expiresAt - TOKEN_SKEW_MS > this.now()) return s.accessToken;
    s.refreshing ??= (async () => {
      try {
        const t = await refreshAccessToken(this.opts.google, s.account.refreshToken, signal);
        s.accessToken = t.accessToken;
        s.expiresAt = this.now() + t.expiresIn * 1000;
        if (t.refreshToken && t.refreshToken !== s.account.refreshToken) {
          s.account.refreshToken = t.refreshToken;
          if (this.opts.dir) await patchAccount(this.opts.dir, s.account.email, { refreshToken: t.refreshToken }).catch(() => {});
        }
        return t.accessToken;
      } finally {
        s.refreshing = undefined;
      }
    })();
    return s.refreshing;
  }

  /** Run a call that needs any working account (model listing, quota). */
  async withAccount<T>(fn: (token: string, s: AccountState) => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.refreshAccountsIfChanged();
    let lastError: unknown = new RotatorError("No Google accounts. Run: pi-gemini-auth login", 503);
    for (const s of this.states.filter((x) => this.usable(x))) {
      try {
        return await fn(await this.token(s, signal), s);
      } catch (err) {
        lastError = err;
        if (err instanceof OAuthError && err.invalidGrant) await this.disable(s, "refresh token revoked");
        else if (err instanceof HttpError && err.status === 401) s.accessToken = undefined;
        if (signal?.aborted) break;
      }
    }
    throw lastError;
  }

  /**
   * POST a streamGenerateContent request, moving across accounts on rate limits,
   * auth failures and server errors. `body` builds the envelope for one account.
   */
  async generate(model: string, body: (s: AccountState) => unknown, signal?: AbortSignal): Promise<Attempt> {
    await this.refreshAccountsIfChanged();
    if (!this.states.some((s) => this.usable(s))) {
      throw new RotatorError("No usable Google accounts. Run: pi-gemini-auth login", 503);
    }
    const skip = new Set<AccountState>();
    const retried401 = new Set<AccountState>();
    let last: RotatorError | undefined;
    const maxWait = this.opts.maxWaitMs ?? MAX_WAIT_MS;
    let waited = 0;
    let serverErrors = 0;

    for (let attempt = 0; attempt < this.states.length * 2 + 2; attempt++) {
      const choice = this.pick(model, skip);
      if (!choice) break;
      if ("waitMs" in choice) {
        if (waited + choice.waitMs > maxWait) {
          throw new RotatorError(
            `All accounts are rate limited for ${model}. The next one frees up in ${Math.ceil(choice.waitMs / 1000)}s.`,
            429,
            choice.waitMs,
          );
        }
        this.log(`All accounts cooling for ${model}; waiting ${Math.ceil(choice.waitMs / 1000)}s`);
        await sleep(choice.waitMs, signal);
        waited += choice.waitMs;
        continue;
      }
      const s = choice;
      let token: string;
      try {
        token = await this.token(s, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof OAuthError && err.invalidGrant) await this.disable(s, "refresh token revoked");
        else this.cooldown(s, "*", DEFAULT_COOLDOWN_MS, err instanceof Error ? err.message : String(err));
        skip.add(s);
        last = new RotatorError(`Token refresh failed for ${s.account.email}: ${err instanceof Error ? err.message : err}`, 502);
        continue;
      }

      const result = await this.post(model, token, body(s), signal);
      s.requests++;
      if (result instanceof Response) return { response: result, state: s };

      const { status, text, headers } = result;
      const kind = classify(status, text);
      const msg = errorMessage(text);
      // Cooldowns keep a failed account out of pick(); `skip` is only for failures a wait cannot fix.
      if (kind === "rate_limit") {
        s.rateLimits++;
        const delay = retryDelayMs(text, headers, this.now());
        this.cooldown(s, model, delay ?? DEFAULT_COOLDOWN_MS, `429: ${msg.slice(0, 120)}`);
        last = new RotatorError(`Rate limited: ${msg}`, 429, delay ?? DEFAULT_COOLDOWN_MS);
      } else if (kind === "auth" && !retried401.has(s)) {
        retried401.add(s);
        s.accessToken = undefined;
      } else if (kind === "auth" || kind === "forbidden") {
        this.cooldown(s, "*", FORBIDDEN_COOLDOWN_MS, `${status}: ${msg.slice(0, 120)}`);
        last = new RotatorError(`Google refused ${s.account.email} (HTTP ${status}): ${msg}`, status);
      } else if (kind === "server") {
        serverErrors++;
        last = new RotatorError(`Google server error (HTTP ${status}): ${msg}`, 502);
        // Capacity errors are not tied to one account; retry a little, then give up.
        if (serverErrors >= 3) break;
        await sleep(500 * serverErrors, signal);
      } else {
        // A bad request fails the same way on every account.
        throw new RotatorError(msg || `HTTP ${status}`, status, undefined);
      }
    }
    const soonest = this.pick(model, new Set());
    const retryAfter = soonest && "waitMs" in soonest ? soonest.waitMs : last?.retryAfterMs;
    throw last ?? new RotatorError(`No account could serve ${model}.`, 503, retryAfter);
  }

  /** One account, endpoints in order. Returns the Response when OK, else the failure details. */
  private async post(
    model: string,
    token: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response | { status: number; text: string; headers?: Headers }> {
    const endpoints = this.opts.google.endpoints;
    let failure: { status: number; text: string; headers?: Headers } = { status: 502, text: "No endpoint reachable" };
    for (let i = 0; i < endpoints.length; i++) {
      const isLast = i === endpoints.length - 1;
      let res: Response;
      try {
        res = await fetch(`${endpoints[i]}/v1internal:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: { ...apiHeaders(this.opts.google, token, model), Accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const cause = (err as { cause?: { message?: string } })?.cause?.message;
        failure = { status: 502, text: `Network error: ${cause ?? (err as Error).message}` };
        continue;
      }
      if (res.ok) return res;
      const text = await res.text().catch(() => "");
      failure = { status: res.status, text, headers: res.headers };
      if (!isLast && (res.status === 403 || res.status === 404)) continue;
      return failure;
    }
    return failure;
  }

  snapshot(): Array<{ email: string; projectId: string; disabled: boolean; cooldowns: Record<string, string>; requests: number; rateLimits: number; lastError?: string }> {
    const now = this.now();
    return this.states.map((s) => ({
      email: s.account.email,
      projectId: s.account.projectId,
      disabled: Boolean(s.account.disabled),
      cooldowns: Object.fromEntries(
        [...s.cooldowns].filter(([, until]) => until > now).map(([m, until]) => [m, new Date(until).toISOString()]),
      ),
      requests: s.requests,
      rateLimits: s.rateLimits,
      ...(s.lastError ? { lastError: s.lastError } : {}),
    }));
  }
}
