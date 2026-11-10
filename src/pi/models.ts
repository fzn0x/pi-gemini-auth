// Turns the rotator's /v1/models list into Pi's models.json model entries.

import { isRecord } from "../fsutil.ts";

export interface RotatorModel {
  id: string;
  context_window?: number;
  max_model_len?: number;
  meta?: {
    display_name?: string;
    context_length?: number;
    max_output_tokens?: number;
    thinking?: boolean;
    multimodal?: boolean;
    tool_calling?: boolean;
  };
}

export interface PiModel {
  id: string;
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  [extra: string]: unknown;
}

const NON_CHAT = /(whisper|tts|embedding|-image$|-image-)/i;

export function isChatModel(m: unknown): m is RotatorModel {
  if (!isRecord(m) || typeof m.id !== "string" || !m.id) return false;
  if (NON_CHAT.test(m.id)) return false;
  if (isRecord(m.meta) && m.meta.tool_calling === false) return false;
  return true;
}

const UPPER = new Set(["gpt", "oss", "glm", "ai"]);

/** "claude-opus-5-5-medium" -> "Claude Opus 5.5 Medium", "gemini-3.8-flash-high" -> "Gemini 3.8 Flash High". */
export function prettyName(id: string): string {
  const parts = id.split("-");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const next = parts[i + 1] ?? "";
    // Join runs of bare single digits into a version: 5-5 -> 5.5
    if (/^\d$/.test(p) && /^\d$/.test(next) && !/^\d+$/.test(out.at(-1) ?? "x")) {
      out.push(`${p}.${next}`);
      i++;
      continue;
    }
    if (UPPER.has(p.toLowerCase()) || /^\d+b$/i.test(p)) out.push(p.toUpperCase());
    else out.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(" ");
}

export function toPiModel(m: RotatorModel): PiModel {
  const meta = m.meta ?? {};
  // Google's displayName is not reliable (several gemini-2.5 ids report "Gemini 3.5 Flash Lite"), so name from the id.
  const model: PiModel = {
    id: m.id,
    name: prettyName(m.id),
    input: meta.multimodal === false ? ["text"] : ["text", "image"],
    reasoning: Boolean(meta.thinking),
  };
  const ctx = m.context_window ?? m.max_model_len ?? meta.context_length;
  if (typeof ctx === "number" && Number.isFinite(ctx)) model.contextWindow = ctx;
  if (typeof meta.max_output_tokens === "number" && Number.isFinite(meta.max_output_tokens)) model.maxTokens = meta.max_output_tokens;
  return model;
}

function globToRegex(glob: string): RegExp {
  const esc = glob.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

/** Filter by comma-separated globs ("gemini-*,claude-sonnet-*"). A pattern starting with "!" excludes. */
export function filterModels<T extends { id: string }>(models: T[], patterns: string | undefined): T[] {
  const list = String(patterns || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return models;
  const include = list.filter((p) => !p.startsWith("!")).map(globToRegex);
  const exclude = list.filter((p) => p.startsWith("!")).map((p) => globToRegex(p.slice(1)));
  return models.filter((m) => (!include.length || include.some((r) => r.test(m.id))) && !exclude.some((r) => r.test(m.id)));
}

/** Preference order for the verification request and the suggested default. */
const PREFERRED = [/^gemini-3\.8-flash-medium$/, /^gemini-3\.8-flash/, /^gemini-.*flash/, /^gemini-/, /./];

export function pickTestModel(piModels: Array<{ id: string }>): string | undefined {
  for (const re of PREFERRED) {
    const hit = piModels.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return undefined;
}

export function buildPiModels(rotatorModels: unknown[], patterns: string | undefined): PiModel[] {
  return filterModels(rotatorModels.filter(isChatModel), patterns).map(toPiModel);
}
