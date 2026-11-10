import assert from "node:assert/strict";
import { test } from "node:test";
import { familyDefaults, parseCatalog } from "../src/google/catalog.ts";
import { SKIP_SIGNATURE } from "../src/google/constants.ts";
import { readRecipe } from "../src/translate/recipe.ts";
import { buildRequest, type ChatRequest } from "../src/translate/request.ts";
import { mapFinishReason, ResponseTranslator, sseJson } from "../src/translate/response.ts";
import { forClaudeParameters, forGeminiJsonSchema, forGeminiLegacyParameters } from "../src/translate/schema.ts";
import { catalogFixture } from "./helpers/mock-google.ts";

const catalog = parseCatalog(JSON.parse(catalogFixture));
const info = (id: string) => catalog.models.find((m) => m.id === id) ?? { id, ...familyDefaults(id) };
const build = (req: Partial<ChatRequest> & { model: string }) =>
  buildRequest({ messages: [{ role: "user", content: "hi" }], ...req } as ChatRequest, { info: info(req.model) });

test("catalog drops internal and image entries and keeps limits", () => {
  const ids = catalog.models.map((m) => m.id);
  for (const gone of ["chat_20706", "tab_flash_lite_preview", "gemini-3.5-flash", "gemini", "gemini-3.1-flash-image"]) {
    assert.ok(!ids.includes(gone), gone);
  }
  assert.ok(ids.includes("gemini-3.5-flash-lite"));
  const gpt = info("gpt-oss-120b-medium");
  assert.equal(gpt.contextWindow, 131072);
  assert.equal(gpt.images, false);
  assert.equal(info("gemini-3.8-flash-high").displayName, "Gemini 3.8 Flash (High)");
  assert.equal(catalog.quotas["claude-sonnet-4-6"]?.remainingFraction, 0.4);
});

test("system, images and history become Gemini contents", () => {
  const r = build({
    model: "gemini-3.8-flash-high",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "developer", content: [{ type: "text", text: "Use tools." }] },
      { role: "user", content: [{ type: "text", text: "Look:" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
      { role: "assistant", content: "Seen." },
      { role: "user", content: "Thanks" },
    ],
  });
  assert.deepEqual(r.systemInstruction, { parts: [{ text: "Be brief.\n\nUse tools." }] });
  assert.deepEqual(r.contents, [
    { role: "user", parts: [{ text: "Look:" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }] },
    { role: "model", parts: [{ text: "Seen." }] },
    { role: "user", parts: [{ text: "Thanks" }] },
  ]);
});

test("tool calls and results, ids for Gemini 3, skip signature when none was kept", () => {
  const r = build({
    model: "gemini-3.8-flash-high",
    messages: [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
          { id: "call|b", type: "function", function: { name: "ls", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "hello" },
      { role: "tool", tool_call_id: "call|b", content: "a.txt" },
    ],
  });
  const [, model, results] = r.contents;
  assert.deepEqual(model!.parts, [
    { functionCall: { name: "read", args: { path: "a.txt" }, id: "call_a" }, thoughtSignature: SKIP_SIGNATURE },
    { functionCall: { name: "ls", args: {}, id: "call_b" } },
  ]);
  assert.deepEqual(results!.parts, [
    { functionResponse: { name: "read", response: { output: "hello" }, id: "call_a" } },
    { functionResponse: { name: "ls", response: { output: "a.txt" }, id: "call_b" } },
  ]);
});

test("Gemini 2.5 gets no ids and no placeholder signature", () => {
  const r = build({
    model: "gemini-2.5-flash",
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "y" },
    ],
  });
  assert.deepEqual(r.contents[1]!.parts, [{ functionCall: { name: "f", args: {} } }]);
});

test("a recipe puts thoughts and signatures back in their places", () => {
  const t = new ResponseTranslator("gemini-3.8-flash-high");
  t.push({ response: { candidates: [{ content: { parts: [{ text: "Plan: ", thought: true }, { text: "read.", thought: true, thoughtSignature: "S-thought" }] } }] } });
  t.push({ response: { candidates: [{ content: { parts: [{ text: "Reading." }] } }] } });
  t.push({ response: { candidates: [{ content: { parts: [{ functionCall: { name: "read", args: { p: 1 } }, thoughtSignature: "S-call" }] }, finishReason: "STOP" }] } });
  const details = t.reasoningDetails();
  assert.ok(details);
  const callId = t.toolCalls[0]!.id;
  const r = build({
    model: "gemini-3.8-flash-high",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "Reading.",
        reasoning_details: details,
        tool_calls: [{ id: callId, type: "function", function: { name: "read", arguments: '{"p":1}' } }],
      },
      { role: "tool", tool_call_id: callId, content: "data" },
    ],
  });
  assert.deepEqual(r.contents[1]!.parts, [
    { thought: true, text: "Plan: read.", thoughtSignature: "S-thought" },
    { text: "Reading." },
    { functionCall: { name: "read", args: { p: 1 }, id: callId }, thoughtSignature: "S-call" },
  ]);
});

test("Claude: parameters schema, ids, snake_case thinking, thinking off without a signed thought", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "edit",
        description: "Edit a file",
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { mode: { anyOf: [{ const: "a" }, { const: "b" }] }, n: { type: ["integer", "null"] } },
          required: ["mode"],
        },
      },
    },
  ];
  const fresh = build({ model: "claude-sonnet-4-6", tools, max_tokens: 64000 });
  assert.deepEqual(fresh.tools![0]!.functionDeclarations[0], {
    name: "edit",
    description: "Edit a file",
    parameters: {
      type: "object",
      properties: { mode: { enum: ["a", "b"], type: "string" }, n: { type: "integer", nullable: true } },
      required: ["mode"],
    },
  });
  assert.deepEqual(fresh.generationConfig.thinkingConfig, { include_thoughts: true, thinking_budget: 32768 });
  assert.equal(fresh.generationConfig.maxOutputTokens, 64000);

  const loopNoSig = build({
    model: "claude-sonnet-4-6",
    tools,
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", tool_calls: [{ id: "toolu_1", type: "function", function: { name: "edit", arguments: '{"mode":"a"}' } }] },
      { role: "tool", tool_call_id: "toolu_1", content: "done" },
    ],
  });
  assert.equal(loopNoSig.generationConfig.thinkingConfig, undefined);
  assert.equal((loopNoSig.contents[1]!.parts[0] as any).functionCall.id, "toolu_1");
  assert.equal((loopNoSig.contents[2]!.parts[0] as any).functionResponse.id, "toolu_1");

  const forced = build({ model: "claude-sonnet-4-6", tools, tool_choice: { type: "function", function: { name: "edit" } } });
  assert.equal(forced.generationConfig.thinkingConfig, undefined);
  assert.deepEqual(forced.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["edit"] } });
});

test("Claude keeps thinking on when the loop's model turn starts with a signed thought", () => {
  const t = new ResponseTranslator("claude-sonnet-4-6");
  t.push({ response: { candidates: [{ content: { parts: [{ text: "hmm", thought: true }, { text: "", thought: true, thoughtSignature: "SIG" }] } }] } });
  t.push({ response: { candidates: [{ content: { parts: [{ functionCall: { name: "edit", args: {}, id: "toolu_9" } }] }, finishReason: "STOP" }] } });
  assert.equal(t.toolCalls[0]!.id, "toolu_9");
  const r = build({
    model: "claude-sonnet-4-6",
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", reasoning_details: t.reasoningDetails(), tool_calls: [{ id: "toolu_9", type: "function", function: { name: "edit", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "toolu_9", content: "ok" },
    ],
  });
  assert.deepEqual(r.contents[1]!.parts[0], { thought: true, text: "hmm", thoughtSignature: "SIG" });
  assert.ok(r.generationConfig.thinkingConfig);
});

test("thinking budgets: adaptive Gemini, fixed budget floors, tiered effort", () => {
  const adaptive = build({ model: "gemini-3.8-flash-high", max_completion_tokens: 32000 });
  assert.deepEqual(adaptive.generationConfig, { maxOutputTokens: 40192, thinkingConfig: { includeThoughts: true } });
  const fixed = build({ model: "gemini-3.1-pro-high", max_tokens: 4000 });
  assert.deepEqual(fixed.generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 10001 });
  assert.ok((fixed.generationConfig.maxOutputTokens as number) > 10001);
  const tiered = build({ model: "gemini-3.8-flash-tiered", reasoning_effort: "low" });
  assert.deepEqual(tiered.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "LOW" });
  const gpt = build({ model: "gpt-oss-120b-medium", max_tokens: 999999 });
  assert.equal(gpt.generationConfig.maxOutputTokens, 32768);
});

test("schemas: const becomes enum for Gemini; legacy mode strips what the proto rejects", () => {
  const schema = { type: "object", properties: { kind: { const: "x" }, size: { type: "number", minimum: 1 } }, additionalProperties: false };
  assert.deepEqual(forGeminiJsonSchema(schema), {
    type: "object",
    properties: { kind: { enum: ["x"] }, size: { type: "number", minimum: 1 } },
    additionalProperties: false,
  });
  assert.deepEqual(forGeminiLegacyParameters(schema), { type: "object", properties: { kind: {}, size: { type: "number" } } });
  assert.deepEqual(forClaudeParameters({ type: "object", properties: { a: { allOf: [{ type: "object", properties: { x: { type: "string" } }, required: ["x"] }, { properties: { y: { type: "number" } } }] } } }), {
    type: "object",
    properties: { a: { type: "object", properties: { x: { type: "string" }, y: { type: "number" } }, required: ["x"] } },
  });
  assert.deepEqual(forClaudeParameters({ enum: [1, 2] }), {});
});

test("response translator: deltas, usage, finish reasons", () => {
  const deltas: unknown[] = [];
  const t = new ResponseTranslator("gemini-3.8-flash-high", (d) => deltas.push(d));
  t.push({ response: { candidates: [{ content: { parts: [{ text: "think", thought: true }] } }] } });
  t.push({ response: { candidates: [{ content: { parts: [{ text: "Hi" }, { text: " there", thoughtSignature: "T" }] } }] } });
  t.push({
    response: {
      candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 115 },
    },
  });
  assert.deepEqual(deltas, [{ reasoning_content: "think" }, { content: "Hi" }, { content: " there" }]);
  assert.equal(t.finish(), "length");
  assert.deepEqual(t.usage, {
    prompt_tokens: 100,
    completion_tokens: 15,
    total_tokens: 115,
    prompt_tokens_details: { cached_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 5 },
  });
  assert.deepEqual(readRecipe(t.reasoningDetails())?.steps, [{ t: "thought", text: "think" }, { t: "text", sig: "T" }]);
  assert.equal(mapFinishReason("SAFETY", false), "content_filter");
  assert.equal(mapFinishReason("MALFORMED_FUNCTION_CALL", false), "malformed_function_call");
  assert.equal(mapFinishReason(undefined, true), "tool_calls");
});

test("no replay data when the response had nothing to sign", () => {
  const t = new ResponseTranslator("gemini-2.5-flash");
  t.push({ response: { candidates: [{ content: { parts: [{ text: "plain" }] }, finishReason: "STOP" }] } });
  assert.equal(t.reasoningDetails(), undefined);
  assert.equal(t.completion("id", 1).choices instanceof Array, true);
});

test("sseJson handles CRLF, split chunks and a missing final blank line", async () => {
  const enc = new TextEncoder();
  const pieces = ['data: {"a":1}\r\n\r\ndata: {"b"', ':2}\r\n\r\n: comment\n\ndata: [DONE]\n\ndata: {"c":3}'];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  const out: unknown[] = [];
  for await (const e of sseJson(body)) out.push(e);
  assert.deepEqual(out, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});
