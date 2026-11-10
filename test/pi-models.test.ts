import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateUrls, normalizeBaseUrl } from "../src/pi/client.ts";
import { cleanLegacy } from "../src/pi/config.ts";
import { buildPiModels, filterModels, pickTestModel, prettyName, toPiModel } from "../src/pi/models.ts";

const listed = [
  { id: "gemini-3.8-flash-high", context_window: 1048576, meta: { max_output_tokens: 65536, thinking: true, multimodal: true, tool_calling: true } },
  { id: "gemini-3.8-flash-medium", context_window: 1048576, meta: { max_output_tokens: 65536, thinking: true, multimodal: true } },
  { id: "gemini-3.8-flash-low", context_window: 1048576, meta: { thinking: true } },
  { id: "gpt-oss-120b-medium", context_window: 131072, meta: { max_output_tokens: 32768, thinking: true, multimodal: false } },
  { id: "claude-opus-5-5-high", context_window: 1000000, meta: { display_name: "Claude Opus 5.5 (High)", thinking: true } },
  { id: "whisper-1", meta: {} },
  { id: "x-tool-less", meta: { tool_calling: false } },
];

test("prettyName", () => {
  assert.equal(prettyName("gemini-3.8-flash-high"), "Gemini 3.8 Flash High");
  assert.equal(prettyName("claude-opus-5-5-medium"), "Claude Opus 5.5 Medium");
  assert.equal(prettyName("claude-sonnet-4-6"), "Claude Sonnet 4.6");
  assert.equal(prettyName("gpt-oss-120b-medium"), "GPT OSS 120B Medium");
});

test("toPiModel maps limits and capabilities; names come from the id", () => {
  assert.deepEqual(toPiModel(listed[3]!), {
    id: "gpt-oss-120b-medium",
    name: "GPT OSS 120B Medium",
    input: ["text"],
    reasoning: true,
    contextWindow: 131072,
    maxTokens: 32768,
  });
  assert.equal(toPiModel(listed[4]!).name, "Claude Opus 5.5 High");
});

test("non-chat models are dropped; filters support globs and exclusions", () => {
  const ids = buildPiModels(listed, "").map((m) => m.id);
  assert.ok(!ids.includes("whisper-1"));
  assert.ok(!ids.includes("x-tool-less"));
  const f = (p: string) => filterModels(listed, p).map((m) => m.id);
  assert.deepEqual(f("gemini-3.8-*,!*-low"), ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"]);
  assert.equal(f("").length, listed.length);
  assert.equal(pickTestModel(buildPiModels(listed, "gemini-*")), "gemini-3.8-flash-medium");
});

test("url normalisation", () => {
  assert.equal(normalizeBaseUrl("http://localhost:51300/v1/"), "http://localhost:51300");
  assert.equal(normalizeBaseUrl("127.0.0.1:51300"), "http://127.0.0.1:51300");
  assert.deepEqual(candidateUrls("http://localhost:51300"), ["http://127.0.0.1:51300", "http://localhost:51300"]);
  assert.deepEqual(candidateUrls("http://10.0.0.5:51300"), ["http://10.0.0.5:51300"]);
});

test("cleanLegacy leaves a remote google-antigravity override alone", () => {
  const { models, changes } = cleanLegacy({ providers: { "google-antigravity": { baseUrl: "https://gateway.example.com" } } }, {});
  assert.deepEqual(changes, []);
  assert.deepEqual(models, { providers: { "google-antigravity": { baseUrl: "https://gateway.example.com" } } });
});
