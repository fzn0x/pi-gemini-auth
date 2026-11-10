// OpenAI Chat Completions request -> Cloud Code Assist generateContent request.

import { isRecord, type JsonObject } from "../fsutil.ts";
import type { CatalogModel } from "../google/catalog.ts";
import { geminiMajor, isClaude, needsToolCallId, SKIP_SIGNATURE } from "../google/constants.ts";
import { readRecipe } from "./recipe.ts";
import { forClaudeParameters, forGeminiJsonSchema, forGeminiLegacyParameters } from "./schema.ts";

export interface ChatMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  reasoning_details?: unknown;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  tools?: unknown;
  tool_choice?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  reasoning_effort?: string;
}

export type Part = JsonObject;
export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface GeminiRequest {
  contents: Content[];
  systemInstruction?: { parts: Part[] };
  generationConfig: JsonObject;
  tools?: { functionDeclarations: JsonObject[] }[];
  toolConfig?: JsonObject;
  sessionId?: string;
}

export interface BuildOptions {
  /** Catalog entry for the model, for limits and thinking settings. */
  info: CatalogModel;
  /** Send Gemini tool schemas through the older `parameters` field. */
  legacySchemas?: boolean;
  sessionId?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class RequestError extends Error {
  readonly status = 400;
}

export function validateChatRequest(value: unknown): ChatRequest {
  if (!isRecord(value)) throw new RequestError("Request body must be a JSON object.");
  if (typeof value.model !== "string" || !value.model) throw new RequestError("`model` is required.");
  if (!Array.isArray(value.messages) || !value.messages.length) throw new RequestError("`messages` must be a non-empty array.");
  for (const m of value.messages) {
    if (!isRecord(m) || typeof m.role !== "string") throw new RequestError("Every message needs a `role`.");
  }
  return value as unknown as ChatRequest;
}

/** Tool call ids must be [A-Za-z0-9_-]{1,64} where Google checks them. */
export const cleanId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "call";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is JsonObject => isRecord(p) && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

function dataUrlPart(url: string): Part | undefined {
  const m = url.match(/^data:([^;,]+);base64,(.+)$/s);
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : undefined;
}

function userParts(content: unknown): Part[] {
  if (typeof content === "string") return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Part[] = [];
  for (const p of content) {
    if (!isRecord(p)) continue;
    if (p.type === "text" && typeof p.text === "string" && p.text) parts.push({ text: p.text });
    else if (p.type === "image_url") {
      const url = isRecord(p.image_url) ? p.image_url.url : p.image_url;
      const part = typeof url === "string" ? dataUrlPart(url) : undefined;
      // Remote image URLs would need a fetch; Pi always sends data URLs.
      parts.push(part ?? { text: "[image omitted: only data: URLs are supported]" });
    }
  }
  return parts;
}

function toolCallsOf(msg: ChatMessage): ToolCall[] {
  if (!Array.isArray(msg.tool_calls)) return [];
  const calls: ToolCall[] = [];
  for (const tc of msg.tool_calls) {
    if (!isRecord(tc) || !isRecord(tc.function) || typeof tc.function.name !== "string") continue;
    const args = tc.function.arguments;
    calls.push({
      id: typeof tc.id === "string" && tc.id ? tc.id : `call_${calls.length}`,
      name: tc.function.name,
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
    });
  }
  return calls;
}

function parseArgs(raw: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return {};
  }
}

/** Rebuild one assistant turn, putting signatures back where Google sent them. */
function modelParts(msg: ChatMessage, model: string): Part[] {
  const claude = isClaude(model);
  const withId = needsToolCallId(model);
  const recipe = readRecipe(msg.reasoning_details);
  const text = textOf(msg.content);
  const calls = toolCallsOf(msg);
  const callPart = (tc: ToolCall, sig?: string): Part => ({
    functionCall: { name: tc.name, args: parseArgs(tc.arguments), ...(withId ? { id: cleanId(tc.id) } : {}) },
    ...(sig ? { thoughtSignature: sig } : {}),
  });

  const parts: Part[] = [];
  const placed = new Set<string>();
  let textPlaced = false;
  const placeText = (sig?: string) => {
    if (textPlaced) return;
    textPlaced = true;
    if (text || sig) parts.push({ text, ...(sig ? { thoughtSignature: sig } : {}) });
  };

  for (const step of recipe?.steps ?? []) {
    if (step.t === "thought") {
      // Claude rejects thinking blocks without their signature.
      if (claude && !step.sig) continue;
      if (!step.text && !step.sig) continue;
      parts.push({ thought: true, text: step.text, ...(step.sig ? { thoughtSignature: step.sig } : {}) });
    } else if (step.t === "text") {
      placeText(step.sig);
    } else {
      const tc = calls.find((c) => c.id === step.id && !placed.has(c.id));
      if (!tc) continue;
      if (!textPlaced && text) placeText();
      placed.add(tc.id);
      parts.push(callPart(tc, step.sig));
    }
  }
  placeText();
  for (const tc of calls) if (!placed.has(tc.id)) parts.push(callPart(tc));

  // Gemini 3+ validates the signature on the first call of each step. When the
  // real one is gone (another model wrote this turn), send the documented skip value.
  const major = geminiMajor(model);
  if (major !== undefined && major >= 3) {
    const first = parts.find((p) => p.functionCall);
    if (first && !first.thoughtSignature) first.thoughtSignature = SKIP_SIGNATURE;
  }
  return parts;
}

function push(contents: Content[], role: Content["role"], parts: Part[]): void {
  if (!parts.length) return;
  const last = contents.at(-1);
  // Merge same-role turns, but keep function responses in their own user turn.
  const lastHasResponses = last?.parts.some((p) => p.functionResponse) ?? false;
  const newHasResponses = parts.some((p) => p.functionResponse);
  if (last && last.role === role && lastHasResponses === newHasResponses) last.parts.push(...parts);
  else contents.push({ role, parts });
}

function convertTools(tools: unknown, model: string, legacy: boolean): JsonObject[] {
  if (!Array.isArray(tools)) return [];
  const claude = isClaude(model);
  const out: JsonObject[] = [];
  for (const t of tools) {
    if (!isRecord(t) || t.type !== "function" || !isRecord(t.function) || typeof t.function.name !== "string") continue;
    const fn = t.function;
    const decl: JsonObject = { name: fn.name };
    if (typeof fn.description === "string" && fn.description) decl.description = fn.description;
    const params = isRecord(fn.parameters) ? fn.parameters : undefined;
    if (claude) decl.parameters = params ? forClaudeParameters(params) : { type: "object", properties: {} };
    else if (params && legacy) decl.parameters = forGeminiLegacyParameters(params);
    else if (params) decl.parametersJsonSchema = forGeminiJsonSchema(params);
    out.push(decl);
  }
  return out;
}

function toolConfig(choice: unknown): JsonObject | undefined {
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (isRecord(choice) && isRecord(choice.function) && typeof choice.function.name === "string") {
    return { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [choice.function.name] } };
  }
  return undefined;
}

const forcesTool = (choice: unknown) => choice === "required" || (isRecord(choice) && isRecord(choice.function));

/** Fixed thinking budgets must stay below the output limit; returns the adjusted pair. */
function fixedBudget(info: CatalogModel, budget: number, maxOut: number | undefined): { budget?: number; maxOut?: number } {
  const limit = Math.max(1, info.maxOutputTokens);
  const min = info.minThinkingBudget ?? 0;
  const b = Math.min(Math.max(min, budget), limit - 1);
  if (b < min) return { maxOut };
  let out = maxOut;
  if (!out || out <= b) out = Math.max(b + 1, Math.min(b + 8192, limit));
  return { budget: b, maxOut: out };
}

const EFFORT_LEVELS: Record<string, string> = { minimal: "LOW", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH" };

/** The last model turn of an unfinished tool loop must open with a signed thought for Claude. */
function claudeLoopLacksSignedThinking(contents: Content[]): boolean {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i]!;
    if (c.role === "user") {
      if (c.parts.some((p) => p.functionResponse)) continue;
      return false; // a fresh user turn ends the loop
    }
    if (!c.parts.some((p) => p.functionCall)) return false;
    const first = c.parts[0];
    return !(first?.thought && first.thoughtSignature);
  }
  return false;
}

export function buildRequest(req: ChatRequest, opts: BuildOptions): GeminiRequest {
  const model = req.model;
  const info = opts.info;
  const claude = isClaude(model);
  const withId = needsToolCallId(model);
  const system: string[] = [];
  const contents: Content[] = [];
  const callNames = new Map<string, string>();

  for (const msg of req.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = textOf(msg.content);
      if (text) system.push(text);
    } else if (msg.role === "assistant") {
      for (const tc of toolCallsOf(msg)) callNames.set(tc.id, tc.name);
      push(contents, "model", modelParts(msg, model));
    } else if (msg.role === "tool") {
      const id = msg.tool_call_id ?? "";
      const output = textOf(msg.content);
      push(contents, "user", [
        {
          functionResponse: {
            name: msg.name || callNames.get(id) || "tool",
            response: { output },
            ...(withId && id ? { id: cleanId(id) } : {}),
          },
        },
      ]);
    } else {
      push(contents, "user", userParts(msg.content));
    }
  }
  if (!contents.length || contents[0]!.role !== "user") contents.unshift({ role: "user", parts: [{ text: "Hello." }] });

  const generationConfig: JsonObject = {};
  if (typeof req.temperature === "number") generationConfig.temperature = req.temperature;
  if (typeof req.top_p === "number") generationConfig.topP = req.top_p;
  const stops = typeof req.stop === "string" ? [req.stop] : Array.isArray(req.stop) ? req.stop.filter((s) => typeof s === "string") : [];
  if (stops.length) generationConfig.stopSequences = stops;

  const requested = req.max_completion_tokens ?? req.max_tokens;
  let maxOut = typeof requested === "number" && requested > 0 ? Math.min(requested, info.maxOutputTokens) : undefined;

  const thinkingWanted = info.thinking && !(claude && (forcesTool(req.tool_choice) || claudeLoopLacksSignedThinking(contents)));
  if (thinkingWanted) {
    const budget = info.thinkingBudget ?? -1;
    if (claude) {
      if (budget === -1) generationConfig.thinkingConfig = { include_thoughts: true };
      else {
        const fixed = fixedBudget(info, budget, maxOut);
        maxOut = fixed.maxOut;
        if (fixed.budget !== undefined) generationConfig.thinkingConfig = { include_thoughts: true, thinking_budget: fixed.budget };
      }
    } else {
      const level = /-tiered$/i.test(model) && req.reasoning_effort ? EFFORT_LEVELS[req.reasoning_effort.toLowerCase()] : undefined;
      if (level && budget === -1) generationConfig.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
      else if (budget === -1) {
        generationConfig.thinkingConfig = { includeThoughts: true };
        // Adaptive thinking spends the output budget before any visible text.
        if (maxOut !== undefined) maxOut = Math.min(maxOut + 8192, info.maxOutputTokens);
      } else {
        const fixed = fixedBudget(info, budget, maxOut);
        maxOut = fixed.maxOut;
        if (fixed.budget !== undefined) generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: fixed.budget };
      }
    }
  }
  if (maxOut) generationConfig.maxOutputTokens = maxOut;

  const request: GeminiRequest = { contents, generationConfig };
  if (system.length) request.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
  const decls = convertTools(req.tools, model, opts.legacySchemas ?? false);
  if (decls.length) {
    request.tools = [{ functionDeclarations: decls }];
    const config = toolConfig(req.tool_choice);
    if (config) request.toolConfig = config;
  }
  if (opts.sessionId) request.sessionId = opts.sessionId;
  return request;
}

/** A 400 that means Google refused parametersJsonSchema, so retrying with `parameters` may help. */
export function isSchemaRejection(status: number, body: string): boolean {
  return status === 400 && /parameters_?json_?schema/i.test(body);
}
