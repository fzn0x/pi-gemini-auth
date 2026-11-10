import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { ModelCatalog } from "../src/catalog-cache.ts";
import { Rotator } from "../src/rotator.ts";
import { createRotatorServer } from "../src/server.ts";
import { type MockGoogle, startMockGoogle, textEvents } from "./helpers/mock-google.ts";

const KEY = "pga-test-key";
let g: MockGoogle;
let server: Server;
let base: string;

before(async () => {
  g = await startMockGoogle();
  const rotator = new Rotator(
    [
      { email: "a@x", refreshToken: "rt-a", projectId: "p-a", addedAt: "" },
      { email: "b@x", refreshToken: "rt-b", projectId: "p-b", addedAt: "" },
    ],
    { google: g.google },
  );
  const catalog = new ModelCatalog(g.google, rotator);
  server = createRotatorServer({ rotator, catalog, apiKey: KEY });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await g.close();
});
beforeEach(() => {
  g.calls.length = 0;
  g.script = () => ({ events: textEvents("ok") });
});

const readJson = (res: Response): Promise<any> => res.json();

const post = (body: unknown, key = KEY) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function sse(res: Response): Promise<any[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((e) => e.replace(/^data: /, "").trim())
    .filter((e) => e && e !== "[DONE]")
    .map((e) => JSON.parse(e));
}

test("health is public; everything else needs the key", async () => {
  const h = await readJson(await fetch(`${base}/health`));
  assert.equal(h.name, "pi-gemini-auth");
  assert.equal(h.accounts, 2);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await post({ model: "x", messages: [] }, "wrong")).status, 401);
});

test("/v1/models lists the live catalog with limits", async () => {
  const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  const json = await readJson(res);
  const ids = json.data.map((m: { id: string }) => m.id);
  assert.ok(ids.includes("gemini-3.8-flash-high"));
  assert.ok(!ids.includes("chat_20706"));
  const gpt = json.data.find((m: { id: string }) => m.id === "gpt-oss-120b-medium");
  assert.equal(gpt.context_window, 131072);
  assert.equal(gpt.meta.multimodal, false);
  assert.equal(gpt.meta.max_output_tokens, 32768);
});

test("streaming: text, thoughts, tool call, replay data, finish and usage", async () => {
  g.script = () => ({
    events: [
      { response: { candidates: [{ content: { role: "model", parts: [{ text: "Let me look.", thought: true, thoughtSignature: "SIG1" }] } }] } },
      { response: { candidates: [{ content: { role: "model", parts: [{ text: "Checking." }] } }] } },
      { response: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "SIG2" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, totalTokenCount: 25 } } },
    ],
  });
  const res = await post({
    model: "gemini-3.8-flash-high",
    stream: true,
    messages: [{ role: "user", content: "read a" }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    max_completion_tokens: 1000,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const chunks = await sse(res);
  const deltas = chunks.flatMap((c) => c.choices.map((ch: any) => ch.delta));
  assert.equal(deltas[0].role, "assistant");
  assert.ok(deltas.some((d) => d.reasoning_content === "Let me look."));
  assert.ok(deltas.some((d) => d.content === "Checking."));
  const call = deltas.find((d) => d.tool_calls)!.tool_calls[0];
  assert.equal(call.function.name, "read");
  assert.equal(call.function.arguments, '{"path":"a"}');
  const details = deltas.find((d) => d.reasoning_details)!.reasoning_details;
  assert.equal(details[0].type, "reasoning.encrypted");
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)!.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 });

  const upstream = g.calls[0]!.body;
  assert.equal(upstream.project, "p-a");
  assert.equal(upstream.model, "gemini-3.8-flash-high");
  assert.equal(upstream.requestType, "agent");
  assert.ok(upstream.request.tools[0].functionDeclarations[0].parametersJsonSchema);

  // Next turn: Pi sends the reasoning_details back; signatures land on the right parts.
  g.calls.length = 0;
  const second = await post({
    model: "gemini-3.8-flash-high",
    messages: [
      { role: "user", content: "read a" },
      { role: "assistant", content: "Checking.", reasoning_details: details, tool_calls: [{ id: call.id, type: "function", function: call.function }] },
      { role: "tool", tool_call_id: call.id, content: "file body" },
    ],
  });
  assert.equal(second.status, 200);
  const turn = g.calls[0]!.body.request.contents[1].parts;
  assert.deepEqual(turn[0], { thought: true, text: "Let me look.", thoughtSignature: "SIG1" });
  assert.equal(turn[2].thoughtSignature, "SIG2");
  assert.equal(g.calls[0]!.body.request.contents[2].parts[0].functionResponse.name, "read");
});

test("non-streaming returns a chat.completion", async () => {
  const res = await post({ model: "gemini-2.5-flash", messages: [{ role: "user", content: "hi" }] });
  const json = await readJson(res);
  assert.equal(json.object, "chat.completion");
  assert.equal(json.choices[0].message.content, "ok");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.equal(json.usage.total_tokens, 15);
});

test("rate limit on one account is invisible to the client", async () => {
  g.script = (req) =>
    req.body.project === "p-a" ? { status: 429, body: { error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } } } : { events: textEvents("from b") };
  const json = await readJson(await post({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(json.choices[0].message.content, "from b");
  assert.equal(g.calls[1]!.headers["anthropic-beta"], "interleaved-thinking-2025-05-14");
});

test("everyone rate limited: 429 with Retry-After", async () => {
  g.script = () => ({ status: 429, body: { error: { code: 429, message: "Your quota will reset after 2h0m0s." } } });
  const res = await post({ model: "gemini-3.1-pro-low", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "7200");
  assert.match((await readJson(res)).error.message, /rate limited|quota/i);
});

test("empty upstream stream is retried before anything reaches the client", async () => {
  g.script = (_req, call) => (call === 0 ? { events: [] } : { events: textEvents("second try") });
  const json = await readJson(await post({ model: "gemini-3-flash", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(json.choices[0].message.content, "second try");
});

test("parametersJsonSchema refusal switches to legacy parameters once", async () => {
  g.script = (req) =>
    req.body.request.tools?.[0].functionDeclarations[0].parametersJsonSchema
      ? { status: 400, body: { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "parametersJsonSchema" at \'request.tools[0]\'' } } }
      : { events: textEvents("legacy ok") };
  const tools = [{ type: "function", function: { name: "f", parameters: { type: "object", properties: { a: { type: "string", pattern: "x" } } } } }];
  const json = await readJson(await post({ model: "gemini-3-flash", tools, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(json.choices[0].message.content, "legacy ok");
  assert.deepEqual(g.calls.at(-1)!.body.request.tools[0].functionDeclarations[0].parameters, { type: "object", properties: { a: { type: "string" } } });
});

test("bad requests get a 400 with a reason", async () => {
  const res = await post({ model: "gemini-3-flash" });
  assert.equal(res.status, 400);
  assert.match((await readJson(res)).error.message, /messages/);
});
