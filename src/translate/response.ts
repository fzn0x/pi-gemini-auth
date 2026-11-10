// Cloud Code Assist stream events -> OpenAI Chat Completions chunks.

import { randomBytes } from "node:crypto";
import { isRecord, type JsonObject } from "../fsutil.ts";
import { cleanId } from "./request.ts";
import { type ReasoningDetail, RecipeBuilder, recipeDetail } from "./recipe.ts";

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
  completion_tokens_details?: { reasoning_tokens: number };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Delta = {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  reasoning_details?: ReasoningDetail[];
  tool_calls?: Array<OpenAIToolCall & { index: number }>;
};

const BLOCKED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/** Gemini finishReason -> OpenAI finish_reason. Unknown reasons pass through; Pi reports them as errors. */
export function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls && (!reason || reason === "STOP")) return "tool_calls";
  if (!reason || reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  if (BLOCKED.has(reason)) return "content_filter";
  return reason.toLowerCase();
}

const newCallId = () => `call_${randomBytes(9).toString("base64url").replace(/[-_]/g, "x")}`;

/**
 * Feeds upstream events in, hands OpenAI deltas out, and keeps everything needed
 * for the final chunk or a non-streaming response.
 */
export class ResponseTranslator {
  readonly model: string;
  readonly recipe = new RecipeBuilder();
  text = "";
  reasoning = "";
  toolCalls: OpenAIToolCall[] = [];
  finishReason: string | undefined;
  usage: Usage | undefined;
  responseId: string | undefined;
  /** Any candidate part or finish reason arrived. */
  sawOutput = false;
  private readonly onDelta: (delta: Delta) => void;

  constructor(model: string, onDelta: (delta: Delta) => void = () => {}) {
    this.model = model;
    this.onDelta = onDelta;
  }

  push(event: unknown): void {
    if (!isRecord(event)) return;
    const response = isRecord(event.response) ? event.response : event;
    if (typeof response.responseId === "string") this.responseId ??= response.responseId;
    const candidate = Array.isArray(response.candidates) ? response.candidates[0] : undefined;
    if (isRecord(candidate)) {
      const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
      for (const part of parts) if (isRecord(part)) this.part(part);
      if (typeof candidate.finishReason === "string" && candidate.finishReason) {
        this.finishReason = candidate.finishReason;
        this.sawOutput = true;
      }
    }
    if (isRecord(response.usageMetadata)) this.usage = toUsage(response.usageMetadata);
  }

  private part(part: JsonObject): void {
    const sig = typeof part.thoughtSignature === "string" && part.thoughtSignature ? part.thoughtSignature : undefined;
    if (isRecord(part.functionCall)) {
      this.sawOutput = true;
      const fc = part.functionCall;
      const given = typeof fc.id === "string" && fc.id ? cleanId(fc.id) : undefined;
      const id = given && !this.toolCalls.some((c) => c.id === given) ? given : newCallId();
      const call: OpenAIToolCall = {
        id,
        type: "function",
        function: { name: typeof fc.name === "string" ? fc.name : "", arguments: JSON.stringify(isRecord(fc.args) ? fc.args : {}) },
      };
      this.toolCalls.push(call);
      this.recipe.call(id, sig);
      this.onDelta({ tool_calls: [{ index: this.toolCalls.length - 1, ...call }] });
      return;
    }
    if (typeof part.text !== "string") {
      // A bare signature part closes the visible text.
      if (sig) this.recipe.text(sig);
      return;
    }
    this.sawOutput = true;
    if (part.thought === true) {
      this.recipe.thought(part.text, sig);
      if (part.text) {
        this.reasoning += part.text;
        this.onDelta({ reasoning_content: part.text });
      }
      return;
    }
    if (part.text || sig) this.recipe.text(sig);
    if (part.text) {
      this.text += part.text;
      this.onDelta({ content: part.text });
    }
  }

  /** Replay data for the next turn, if this response produced any. */
  reasoningDetails(): ReasoningDetail[] | undefined {
    return this.recipe.useful ? [recipeDetail({ model: this.model, steps: this.recipe.steps })] : undefined;
  }

  finish(): string {
    return mapFinishReason(this.finishReason, this.toolCalls.length > 0);
  }

  /** The whole response as a chat.completion object, for stream: false. */
  completion(id: string, created: number): JsonObject {
    const details = this.reasoningDetails();
    const message: JsonObject = { role: "assistant", content: this.text || null };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (details) message.reasoning_details = details;
    if (this.toolCalls.length) message.tool_calls = this.toolCalls;
    return {
      id,
      object: "chat.completion",
      created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finish() }],
      ...(this.usage ? { usage: this.usage } : {}),
    };
  }
}

function toUsage(u: JsonObject): Usage {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const prompt = n(u.promptTokenCount);
  const thoughts = n(u.thoughtsTokenCount);
  const completion = n(u.candidatesTokenCount) + thoughts;
  const usage: Usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: n(u.totalTokenCount) || prompt + completion,
  };
  if (n(u.cachedContentTokenCount)) usage.prompt_tokens_details = { cached_tokens: n(u.cachedContentTokenCount) };
  if (thoughts) usage.completion_tokens_details = { reasoning_tokens: thoughts };
  return usage;
}

/** Split an SSE byte stream into parsed JSON `data:` payloads. */
export async function* sseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const flush = function* (): Generator<unknown> {
    if (!data.length) return;
    const payload = data.join("\n").trim();
    data = [];
    if (!payload || payload === "[DONE]") return;
    try {
      yield JSON.parse(payload);
    } catch {
      // skip a malformed event
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line === "") yield* flush();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
  yield* flush();
}
