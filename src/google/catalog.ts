// Live model list from Cloud Code Assist (v1internal:fetchAvailableModels).
// The same call reports each account's remaining quota per model.

import { isRecord } from "../fsutil.ts";
import { errorMessage, HttpError } from "../retry.ts";
import { apiHeaders, type GoogleConfig, isClaude } from "./constants.ts";

export interface CatalogModel {
  id: string;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  thinking: boolean;
  /** -1 means adaptive thinking. */
  thinkingBudget?: number;
  minThinkingBudget?: number;
  images: boolean;
}

export interface ModelQuota {
  remainingFraction?: number;
  resetTime?: string;
}

export interface CatalogSnapshot {
  models: CatalogModel[];
  quotas: Record<string, ModelQuota>;
  defaultModel?: string;
}

/**
 * Display names the request path must translate. Google lists the model under
 * the first name but serves it under the second.
 */
export const UPSTREAM_ALIASES: Record<string, string> = {
  "gemini-3.1-pro-high": "gemini-pro-agent",
  "gpt-oss-120b": "gpt-oss-120b-medium",
};

export function upstreamModel(id: string): string {
  return UPSTREAM_ALIASES[id.toLowerCase()] ?? id;
}

const SAFE_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;

/** Ids the catalog reports that are not chat models: quota pools, IDE internals, image models. */
export function isListedChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  if (!SAFE_ID.test(id) || id.length > 128) return false;
  if (lower === "gemini" || lower === "claude") return false;
  if (lower.startsWith("chat_") || lower.startsWith("tab_")) return false;
  if (/(^|-)image(-|$)/.test(lower) || /whisper|tts|embedding/.test(lower)) return false;
  // Gemini 3.5 entries are IDE internals except flash-lite.
  if (lower.startsWith("gemini-3.5-") && lower !== "gemini-3.5-flash-lite") return false;
  return true;
}

export function familyDefaults(id: string): Omit<CatalogModel, "id"> {
  const lower = id.toLowerCase();
  if (lower.startsWith("gpt-oss")) {
    return { contextWindow: 131_072, maxOutputTokens: 32_768, thinking: true, thinkingBudget: 8_192, images: false };
  }
  if (isClaude(lower)) {
    return { contextWindow: 1_000_000, maxOutputTokens: 64_000, thinking: true, thinkingBudget: 32_768, images: true };
  }
  if (lower.startsWith("gemini")) {
    return { contextWindow: 1_048_576, maxOutputTokens: 65_536, thinking: true, thinkingBudget: -1, images: true };
  }
  return { contextWindow: 128_000, maxOutputTokens: 32_768, thinking: false, images: false };
}

const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);

export function parseCatalog(raw: unknown): CatalogSnapshot {
  const out: CatalogSnapshot = { models: [], quotas: {} };
  if (!isRecord(raw) || !isRecord(raw.models)) return out;
  for (const [rawId, info] of Object.entries(raw.models)) {
    const id = rawId.trim();
    if (!isRecord(info) || !isListedChatModel(id)) continue;
    const base = familyDefaults(id);
    const model: CatalogModel = {
      id,
      ...base,
      contextWindow: positive(info.maxTokens) ?? base.contextWindow,
      maxOutputTokens: positive(info.maxOutputTokens) ?? base.maxOutputTokens,
    };
    if (typeof info.displayName === "string" && info.displayName.trim()) model.displayName = info.displayName.trim();
    if (typeof info.supportsThinking === "boolean") model.thinking = info.supportsThinking;
    if (typeof info.supportsImages === "boolean") model.images = info.supportsImages;
    if (typeof info.thinkingBudget === "number" && (info.thinkingBudget === -1 || info.thinkingBudget >= 0)) {
      model.thinkingBudget = info.thinkingBudget;
    }
    if (typeof info.minThinkingBudget === "number" && info.minThinkingBudget >= 0) model.minThinkingBudget = info.minThinkingBudget;
    if (!model.thinking) delete model.thinkingBudget;
    out.models.push(model);
    if (isRecord(info.quotaInfo)) {
      const q: ModelQuota = {};
      const f = info.quotaInfo.remainingFraction;
      if (typeof f === "number" && f >= 0 && f <= 1) q.remainingFraction = f;
      if (typeof info.quotaInfo.resetTime === "string") q.resetTime = info.quotaInfo.resetTime;
      out.quotas[id] = q;
    }
  }
  if (typeof raw.defaultAgentModelId === "string") out.defaultModel = raw.defaultAgentModelId;
  out.models.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function fetchCatalog(cfg: GoogleConfig, accessToken: string, projectId: string, signal?: AbortSignal): Promise<CatalogSnapshot> {
  let lastError: Error | undefined;
  for (const endpoint of cfg.endpoints) {
    let res: Response;
    try {
      res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: apiHeaders(cfg, accessToken),
        body: JSON.stringify({ project: projectId }),
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (signal?.aborted) throw lastError;
      continue;
    }
    if (res.ok) return parseCatalog(await res.json());
    const body = await res.text();
    lastError = new HttpError(`Listing models failed (HTTP ${res.status}): ${errorMessage(body)}`, res.status, body);
    if (res.status !== 403 && res.status !== 404) throw lastError;
  }
  throw lastError ?? new Error("No Cloud Code endpoint configured");
}
