// Google Cloud Code Assist (Antigravity) endpoints, OAuth client and request headers.
//
// These mirror what the Antigravity IDE sends. Every value can be overridden with an
// environment variable, so a change on Google's side does not need a new release.

const decode = (s: string) => Buffer.from(s, "base64").toString("utf8");
const env = (name: string) => process.env[name]?.trim() || undefined;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  /** Tried in order; the next one is used when one answers 403/404 or cannot be reached. */
  endpoints: string[];
  userAgent: string;
  apiClient: string;
  clientMetadata: string;
  antigravityVersion: string;
}

export const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

/** Documented placeholder for function calls that have no real thought signature. */
export const SKIP_SIGNATURE = "skip_thought_signature_validator";

export function googleConfig(overrides: Partial<GoogleConfig> = {}): GoogleConfig {
  const antigravityVersion = env("PGA_ANTIGRAVITY_VERSION") ?? "2.11.0";
  return {
    clientId:
      env("PGA_CLIENT_ID") ??
      decode("MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ=="),
    clientSecret: env("PGA_CLIENT_SECRET") ?? decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY="),
    redirectUri: env("PGA_REDIRECT_URI") ?? "http://localhost:51121/oauth-callback",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env("PGA_TOKEN_URL") ?? "https://oauth2.googleapis.com/token",
    userInfoUrl: env("PGA_USERINFO_URL") ?? "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    endpoints: (env("PGA_ENDPOINTS") ?? "https://daily-cloudcode-pa.googleapis.com,https://cloudcode-pa.googleapis.com")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean),
    userAgent: env("PGA_USER_AGENT") ?? `antigravity/ide/${antigravityVersion} (aidev_client; os_type=darwin; arch=arm64)`,
    apiClient: env("PGA_API_CLIENT") ?? "google-cloud-sdk vscode_cloudshelleditor/0.1",
    clientMetadata:
      env("PGA_CLIENT_METADATA") ?? JSON.stringify({ ideType: "ANTIGRAVITY", platform: "MACOS", pluginType: "GEMINI" }),
    antigravityVersion,
    ...overrides,
  };
}

export function apiHeaders(cfg: GoogleConfig, accessToken: string, model?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": cfg.userAgent,
    "X-Goog-Api-Client": cfg.apiClient,
    "Client-Metadata": cfg.clientMetadata,
  };
  // Claude on Cloud Code Assist only returns interleaved thinking with this beta flag.
  if (model && isClaude(model)) headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  return headers;
}

export const isClaude = (model: string) => /^claude-/i.test(model);

export function geminiMajor(model: string): number | undefined {
  const m = model.toLowerCase().match(/^gemini-(\d+)/);
  return m ? Number.parseInt(m[1]!, 10) : undefined;
}

/** Models behind Cloud Code Assist that need ids on functionCall/functionResponse parts. */
export function needsToolCallId(model: string): boolean {
  const major = geminiMajor(model);
  return isClaude(model) || /^gpt-oss-/i.test(model) || (major !== undefined && major >= 3);
}
