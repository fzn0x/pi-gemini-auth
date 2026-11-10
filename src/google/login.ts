// Interactive Google login: open the consent page, catch the redirect on
// localhost:51121, or let the user paste the redirect URL by hand.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import type { Account } from "../store.ts";
import type { GoogleConfig } from "./constants.ts";
import { buildAuthUrl, discoverProject, exchangeCode, generatePkce, generateState, getUserEmail } from "./oauth.ts";

export interface LoginOptions {
  openBrowser: boolean;
  /** Where progress lines go. */
  say: (line: string) => void;
  timeoutMs?: number;
}

interface CodeResult {
  code: string;
  state: string;
}

function page(title: string, message: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;margin:3rem"><h1>${esc(title)}</h1><p>${esc(message)}</p></body>`;
}

export function parseRedirect(input: string): Partial<CodeResult> & { error?: string } {
  try {
    const url = new URL(input.trim());
    const error = url.searchParams.get("error");
    return {
      ...(url.searchParams.get("code") ? { code: url.searchParams.get("code")! } : {}),
      ...(url.searchParams.get("state") ? { state: url.searchParams.get("state")! } : {}),
      ...(error ? { error } : {}),
    };
  } catch {
    return {};
  }
}

export function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // the URL is printed anyway
  }
}

/** Listen on both loopback families: browsers may resolve "localhost" to either. */
async function listenCallback(redirectUri: string, onResult: (r: Partial<CodeResult> & { error?: string }) => void): Promise<Server[]> {
  const redirect = new URL(redirectUri);
  if (!["localhost", "127.0.0.1"].includes(redirect.hostname)) return [];
  const port = Number(redirect.port || 80);
  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname !== redirect.pathname) {
      res.writeHead(404).end();
      return;
    }
    const result = parseRedirect(url.href);
    const ok = Boolean(result.code);
    res
      .writeHead(ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8" })
      .end(ok ? page("Signed in", "You can close this tab and go back to the terminal.") : page("Login failed", result.error ?? "No authorization code."));
    onResult(result);
  };
  const servers: Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer(handler);
    const ok = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, host, () => resolve(true));
    });
    if (ok) servers.push(server);
  }
  return servers;
}

async function waitForCode(cfg: GoogleConfig, expectedState: string, opts: LoginOptions, url: string): Promise<CodeResult> {
  return new Promise<CodeResult>((resolve, reject) => {
    let servers: Server[] = [];
    let rl: ReturnType<typeof createInterface> | undefined;
    let settled = false;
    const finish = (err: Error | undefined, value?: CodeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const s of servers) s.close();
      rl?.close();
      if (err) reject(err);
      else resolve(value!);
    };
    const accept = (r: Partial<CodeResult> & { error?: string }) => {
      if (r.error) return finish(new Error(`Google returned an error: ${r.error}`));
      if (!r.code) return;
      if (r.state !== expectedState) return finish(new Error("The login state did not match. Start the login again."));
      finish(undefined, { code: r.code, state: r.state });
    };
    const timer = setTimeout(() => finish(new Error("Login timed out after 5 minutes.")), opts.timeoutMs ?? 5 * 60_000);

    listenCallback(cfg.redirectUri, accept).then((list) => {
      servers = list;
      if (settled) for (const s of list) s.close();
      if (!list.length) opts.say(`Could not listen on ${cfg.redirectUri}; paste the redirect URL instead.`);
      opts.say("Open this URL to sign in with the Google account you want to add:");
      opts.say(url);
      if (opts.openBrowser) openUrl(url);
      if (process.stdin.isTTY) {
        opts.say("Waiting for the browser... or paste the final localhost URL here and press Enter.");
        rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.on("line", (line) => {
          const r = parseRedirect(line);
          if (r.code || r.error) accept(r);
          else if (line.trim()) opts.say("That is not the redirect URL. It starts with http://localhost:51121/oauth-callback?");
        });
      }
    });
  });
}

export async function login(cfg: GoogleConfig, opts: LoginOptions): Promise<Account> {
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const url = buildAuthUrl(cfg, state, challenge);
  const { code } = await waitForCode(cfg, state, opts, url);
  opts.say("Exchanging the authorization code...");
  const tokens = await exchangeCode(cfg, code, verifier);
  if (!tokens.refreshToken) throw new Error("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.");
  const email = await getUserEmail(cfg, tokens.accessToken);
  if (!email) throw new Error("Could not read the account email from Google.");
  opts.say(`Signed in as ${email}. Looking up the Cloud Code project...`);
  const projectId = await discoverProject(cfg, tokens.accessToken);
  return { email, refreshToken: tokens.refreshToken, projectId, addedAt: new Date().toISOString() };
}
