// Replay data for Gemini thought signatures.
//
// Gemini 3 rejects a tool-call turn unless each function call comes back with the
// thoughtSignature it was sent with, and Claude needs its signed thinking block back
// before a tool_use. Chat Completions has no field for that, but Pi keeps any
// `reasoning_details` an assistant message carried and sends them back verbatim on
// the next request. So the rotator packs the exact part layout of each response
// into one opaque `reasoning.encrypted` entry and rebuilds the turn from it.

import { isRecord } from "../fsutil.ts";

export const RECIPE_FORMAT = "pi-gemini-auth.v1";

export type RecipeStep =
  | { t: "thought"; text: string; sig?: string }
  | { t: "text"; sig?: string }
  | { t: "call"; id: string; sig?: string };

export interface Recipe {
  model: string;
  steps: RecipeStep[];
}

export interface ReasoningDetail {
  type: "reasoning.encrypted";
  id: string;
  format: string;
  data: string;
}

export function recipeDetail(recipe: Recipe): ReasoningDetail {
  return { type: "reasoning.encrypted", id: "pga", format: RECIPE_FORMAT, data: JSON.stringify(recipe) };
}

function toStep(value: unknown): RecipeStep | undefined {
  if (!isRecord(value)) return undefined;
  const sig = typeof value.sig === "string" && value.sig ? value.sig : undefined;
  const withSig = <T extends object>(s: T) => (sig ? { ...s, sig } : s);
  if (value.t === "thought" && typeof value.text === "string") return withSig({ t: "thought" as const, text: value.text });
  if (value.t === "text") return withSig({ t: "text" as const });
  if (value.t === "call" && typeof value.id === "string") return withSig({ t: "call" as const, id: value.id });
  return undefined;
}

/** Find our recipe among an assistant message's reasoning_details. */
export function readRecipe(details: unknown): Recipe | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const d of details) {
    if (!isRecord(d) || d.type !== "reasoning.encrypted" || d.format !== RECIPE_FORMAT || typeof d.data !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(d.data);
      if (!isRecord(parsed) || typeof parsed.model !== "string" || !Array.isArray(parsed.steps)) continue;
      return { model: parsed.model, steps: parsed.steps.map(toStep).filter((s): s is RecipeStep => s !== undefined) };
    } catch {
      // ignore a damaged entry
    }
  }
  return undefined;
}

/** Collects steps while a response streams in. */
export class RecipeBuilder {
  readonly steps: RecipeStep[] = [];
  private textStep: Extract<RecipeStep, { t: "text" }> | undefined;

  thought(text: string, sig: string | undefined): void {
    const last = this.steps.at(-1);
    // Gemini streams one thought as many parts; a part that brings a new signature
    // after a signed one starts a new block.
    if (last?.t === "thought" && !(last.sig && sig && last.sig !== sig)) {
      last.text += text;
      if (sig) last.sig = sig;
    } else {
      this.steps.push(sig ? { t: "thought", text, sig } : { t: "thought", text });
    }
  }

  text(sig: string | undefined): void {
    if (!this.textStep) {
      this.textStep = { t: "text" };
      this.steps.push(this.textStep);
    }
    if (sig) this.textStep.sig = sig;
  }

  call(id: string, sig: string | undefined): void {
    this.steps.push(sig ? { t: "call", id, sig } : { t: "call", id });
  }

  /** Worth sending back only when it holds a signature or thought text. */
  get useful(): boolean {
    return this.steps.some((s) => s.sig || (s.t === "thought" && s.text.length > 0));
  }
}
