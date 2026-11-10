// Talks to a running rotator the way Pi will: over its OpenAI-compatible API.

import { isRecord } from "../fsutil.ts";
import { SERVER_NAME } from "../version.ts";

export class ClientError extends Error {
  readonly hint: string | undefined;
  readonly status: number | undefined;
  constructor(message: string, hint?: string, status?: number) {
    super(message);
    this.name = "ClientError";
    this.hint = hint;
    this.status = status;
  }
}

/** Strip trailing slashes and a trailing /v1 so we always hold the bare origin. */
export function normalizeBaseUrl(url: string): string {
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/**
 * `localhost` can resolve to ::1 while the rotator binds IPv4 only,
 * so when given localhost we try 127.0.0.1 first.
 */
export function candidateUrls(url: string): string[] {
  const base = normalizeBaseUrl(url);
  const parsed = new URL(base);
  if (parsed.hostname === "localhost") {
    const v4 = new URL(base);
    v4.hostname = "127.0.0.1";
    return [v4.origin, base];
  }
  return [base];
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as { cause?: { code?: string; message?: string }; code?: string; name?: string; message?: string };
    const code = e?.cause?.code ?? e?.code ?? e?.name;
    const origin = new URL(url).origin;
    if (code === "ECONNREFUSED") throw new ClientError(`Nothing is listening at ${origin}.`, "Start the rotator: pi-gemini-auth start --detach");
    if (code === "TimeoutError" || code === "AbortError") throw new ClientError(`Timed out reaching ${origin}.`);
    throw new ClientError(`Could not reach ${origin}: ${e?.cause?.message ?? e?.message ?? code}`);
  }
}

async function errorFromResponse(res: Response, what: string): Promise<ClientError> {
  let message = "";
  try {
    const text = await res.text();
    const parsed: unknown = JSON.parse(text);
    message = isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string" ? parsed.error.message : text.slice(0, 300);
  } catch {
    // ignore
  }
  if (res.status === 401) return new ClientError(`${what} was rejected (HTTP 401).`, "The API key does not match the rotator's. Re-run setup without --api-key.", 401);
  if (res.status === 429) {
    return new ClientError(`${what} failed (HTTP 429): ${message || "all accounts are rate limited"}`, "Pi is configured; it will work once an account frees up. See: pi-gemini-auth accounts", 429);
  }
  return new ClientError(`${what} failed (HTTP ${res.status}). ${message}`.trim(), undefined, res.status);
}

export interface Health {
  baseUrl: string;
  version: string;
  accounts: number;
}

/** Confirm a pi-gemini-auth rotator (and not some other server) answers at the URL. */
export async function checkHealth(url: string, { timeoutMs = 3000 } = {}): Promise<Health> {
  let lastErr: unknown;
  for (const base of candidateUrls(url)) {
    try {
      const res = await request(`${base}/health`, {}, timeoutMs);
      const json: unknown = res.ok ? await res.json().catch(() => undefined) : undefined;
      if (!isRecord(json) || json.name !== SERVER_NAME) {
        throw new ClientError(
          `Something else is answering at ${base}.`,
          "Stop that server, or pass --url / --port for the pi-gemini-auth rotator.",
        );
      }
      return { baseUrl: base, version: String(json.version ?? "?"), accounts: Number(json.accounts ?? 0) };
    } catch (err) {
      lastErr = err;
      if (err instanceof ClientError && err.message.startsWith("Something else")) throw err;
    }
  }
  throw lastErr;
}

export async function fetchModels(baseUrl: string, apiKey: string, { timeoutMs = 30_000 } = {}): Promise<unknown[]> {
  const res = await request(`${baseUrl}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } }, timeoutMs);
  if (!res.ok) throw await errorFromResponse(res, "Listing models");
  const json: unknown = await res.json();
  return isRecord(json) && Array.isArray(json.data) ? json.data : [];
}

/** Send one tiny chat completion to prove the route works end to end. */
export async function testChat(baseUrl: string, apiKey: string, model: string, { timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  const res = await request(
    `${baseUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 1024,
        stream: false,
      }),
    },
    timeoutMs,
  );
  if (!res.ok) throw await errorFromResponse(res, `Test request to ${model}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  const text = json?.choices?.[0]?.message?.content ?? "";
  return { ms: Date.now() - started, text: String(text).trim().slice(0, 80) };
}

export async function fetchAccounts(baseUrl: string, apiKey: string): Promise<unknown[]> {
  const res = await request(`${baseUrl}/v1/accounts`, { headers: { Authorization: `Bearer ${apiKey}` } }, 5000);
  if (!res.ok) throw await errorFromResponse(res, "Listing accounts");
  const json: unknown = await res.json();
  return isRecord(json) && Array.isArray(json.accounts) ? json.accounts : [];
}
