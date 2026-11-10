// Reads and edits Pi's ~/.pi/agent/{models,auth}.json.

import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, type JsonObject } from "../fsutil.ts";
import type { PiModel } from "./models.ts";

export const ANTIGRAVITY_PROVIDER = "google-antigravity";

export function piDir(override?: string): string {
  return override || process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function piFiles(dir: string) {
  return { models: join(dir, "models.json"), auth: join(dir, "auth.json") };
}

function providersOf(modelsJson: JsonObject): Record<string, JsonObject> {
  if (!isRecord(modelsJson.providers)) modelsJson.providers = {};
  return modelsJson.providers as Record<string, JsonObject>;
}

function isLoopback(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Put our provider into a models.json object (returns a new object). Known fields
 * are refreshed; extra keys a user added to a model or the provider are kept.
 */
export function applyProvider(
  modelsJson: JsonObject,
  providerId: string,
  { baseUrl, apiKey, models }: { baseUrl: string; apiKey: string; models: PiModel[] },
): JsonObject {
  const next = structuredClone(modelsJson ?? {});
  const providers = providersOf(next);
  const existing = providers[providerId] ?? {};
  const oldModels = Array.isArray(existing.models) ? (existing.models as JsonObject[]) : [];
  const oldById = new Map(oldModels.filter((m) => typeof m?.id === "string").map((m) => [m.id as string, m]));
  providers[providerId] = {
    ...existing,
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    apiKey,
    models: models.map((m) => ({ ...(oldById.get(m.id) ?? {}), ...m })),
  };
  return next;
}

export function removeProvider(modelsJson: JsonObject, providerId: string): { next: JsonObject; removed: boolean } {
  const next = structuredClone(modelsJson ?? {});
  const providers = isRecord(next.providers) ? (next.providers as Record<string, unknown>) : undefined;
  if (!providers?.[providerId]) return { next, removed: false };
  delete providers[providerId];
  return { next, removed: true };
}

/**
 * Remove the old placeholder setup that makes Pi ask for a Google login:
 * - models.json: a google-antigravity redirect to a local proxy
 * - auth.json:   the google-antigravity "proxy-managed" placeholder token
 */
export function cleanLegacy(modelsJson: JsonObject, authJson: JsonObject) {
  const models = structuredClone(modelsJson ?? {});
  const auth = structuredClone(authJson ?? {});
  const changes: string[] = [];
  const providers = isRecord(models.providers) ? (models.providers as Record<string, JsonObject>) : {};

  const legacy = providers[ANTIGRAVITY_PROVIDER];
  if (legacy && isLoopback(legacy.baseUrl)) {
    if (Object.keys(legacy).length === 1) delete providers[ANTIGRAVITY_PROVIDER];
    else delete legacy.baseUrl;
    changes.push(`models.json: removed the ${ANTIGRAVITY_PROVIDER} redirect to a local proxy`);
  }
  const a = auth[ANTIGRAVITY_PROVIDER];
  if (isRecord(a) && (a.refresh === "proxy-managed" || a.access === "proxy-managed")) {
    delete auth[ANTIGRAVITY_PROVIDER];
    changes.push(`auth.json: removed the ${ANTIGRAVITY_PROVIDER} "proxy-managed" placeholder`);
  }
  return { models, auth, changes };
}

/** Describe what Pi will see, for `status`. */
export function inspect(modelsJson: JsonObject, authJson: JsonObject, providerId: string) {
  const providers = isRecord(modelsJson?.providers) ? (modelsJson.providers as Record<string, JsonObject>) : {};
  const legacyAuth = authJson?.[ANTIGRAVITY_PROVIDER];
  return {
    provider: providers[providerId] as (JsonObject & { baseUrl?: string; apiKey?: string; models?: Array<{ id: string }> }) | undefined,
    legacyRedirect: isLoopback(providers[ANTIGRAVITY_PROVIDER]?.baseUrl),
    legacyPlaceholder: isRecord(legacyAuth) && legacyAuth.refresh === "proxy-managed",
  };
}
