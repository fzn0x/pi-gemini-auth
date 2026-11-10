// Google OAuth for Antigravity accounts: PKCE login, token refresh, and the
// Cloud Code companion project lookup every request is billed against.

import { createHash, randomBytes } from "node:crypto";
import { isRecord } from "../fsutil.ts";
import { type GoogleConfig, SCOPES } from "./constants.ts";

export class OAuthError extends Error {
  /** Google answered invalid_grant: the refresh token was revoked or expired. */
  readonly invalidGrant: boolean;
  readonly status: number;
  constructor(message: string, status: number, invalidGrant = false) {
    super(message);
    this.name = "OAuthError";
    this.status = status;
    this.invalidGrant = invalidGrant;
  }
}

export interface TokenResult {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export const generateState = () => randomBytes(24).toString("base64url");

export function buildAuthUrl(cfg: GoogleConfig, state: string, challenge: string): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline",
    prompt: "consent",
  });
  return `${cfg.authUrl}?${params}`;
}

async function tokenRequest(cfg: GoogleConfig, body: Record<string, string>, signal?: AbortSignal): Promise<TokenResult> {
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) json = parsed;
  } catch {
    // keep raw text for the message
  }
  if (!res.ok || typeof json.access_token !== "string") {
    const code = typeof json.error === "string" ? json.error : "";
    const detail = typeof json.error_description === "string" ? json.error_description : text.slice(0, 200);
    throw new OAuthError(`Google token request failed (HTTP ${res.status}${code ? `, ${code}` : ""}): ${detail}`, res.status, code === "invalid_grant");
  }
  return {
    accessToken: json.access_token,
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : 3600,
    ...(typeof json.refresh_token === "string" ? { refreshToken: json.refresh_token } : {}),
  };
}

export function exchangeCode(cfg: GoogleConfig, code: string, verifier: string): Promise<TokenResult> {
  return tokenRequest(cfg, {
    code,
    grant_type: "authorization_code",
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
}

export function refreshAccessToken(cfg: GoogleConfig, refreshToken: string, signal?: AbortSignal): Promise<TokenResult> {
  return tokenRequest(cfg, { refresh_token: refreshToken, grant_type: "refresh_token" }, signal);
}

export async function getUserEmail(cfg: GoogleConfig, accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(cfg.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const data: unknown = await res.json();
    return isRecord(data) && typeof data.email === "string" ? data.email : undefined;
  } catch {
    return undefined;
  }
}

function extractProjectId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (isRecord(value) && typeof value.id === "string" && value.id.trim()) return value.id.trim();
  }
  return undefined;
}

/** The tier the IDE would pick: the allowed tier marked default, then the current tier. */
function defaultTierId(data: unknown): string {
  if (!isRecord(data)) return "free-tier";
  const tiers = Array.isArray(data.allowedTiers) ? data.allowedTiers : [];
  for (const tier of tiers) {
    if (isRecord(tier) && tier.isDefault === true && typeof tier.id === "string" && tier.id) return tier.id;
  }
  if (isRecord(data.currentTier) && typeof data.currentTier.id === "string" && data.currentTier.id) return data.currentTier.id;
  return "free-tier";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Find the Cloud Code companion project bound to the account. A brand new account
 * has none until onboarded, so we run the same onboardUser call the IDE does.
 */
export async function discoverProject(cfg: GoogleConfig, accessToken: string): Promise<string> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": cfg.userAgent,
  };
  let lastLoad: unknown;
  for (const endpoint of cfg.endpoints) {
    try {
      lastLoad = await postJson(`${endpoint}/v1internal:loadCodeAssist`, headers, { metadata: { ideType: "ANTIGRAVITY" } });
      const projectId = extractProjectId(lastLoad);
      if (projectId) return projectId;
    } catch {
      // try the next endpoint
    }
  }
  if (lastLoad !== undefined) {
    const onboardUrl = `${cfg.endpoints[0]}/v1internal:onboardUser`;
    const body = {
      tier_id: defaultTierId(lastLoad),
      metadata: { ide_type: "ANTIGRAVITY", ide_version: cfg.antigravityVersion, ide_name: "antigravity" },
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await sleep(2000);
      try {
        const data = await postJson(onboardUrl, headers, body);
        if (isRecord(data) && data.done === true) {
          const projectId = extractProjectId(isRecord(data.response) ? data.response : data);
          if (projectId) return projectId;
          break;
        }
      } catch {
        break;
      }
    }
  }
  throw new Error(
    "Google did not return a Cloud Code project for this account. If the account is new, open it once in the Antigravity IDE and send a message, then log in again.",
  );
}
