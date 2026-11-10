// The OpenAI-compatible HTTP API that Pi talks to.
//
//   GET  /health               liveness and identity, no key needed
//   GET  /v1/models            live model list
//   POST /v1/chat/completions  chat, streaming or not
//   GET  /v1/accounts          account states (no secrets)

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ModelCatalog } from "./catalog-cache.ts";
import { upstreamModel } from "./google/catalog.ts";
import { RotatorError, type Rotator } from "./rotator.ts";
import { buildRequest, type ChatRequest, isSchemaRejection, RequestError, validateChatRequest } from "./translate/request.ts";
import { type Delta, ResponseTranslator, sseJson } from "./translate/response.ts";
import { SERVER_NAME, VERSION } from "./version.ts";

const MAX_BODY_BYTES = 64 * 1024 * 1024;
const EMPTY_STREAM_RETRIES = 2;

export interface ServerOptions {
  rotator: Rotator;
  catalog: ModelCatalog;
  apiKey: string;
  log?: (line: string) => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string, retryAfterMs?: number): void {
  const type = status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error";
  const headers: Record<string, string> = {};
  if (retryAfterMs !== undefined && retryAfterMs > 0) headers["Retry-After"] = String(Math.ceil(retryAfterMs / 1000));
  sendJson(res, status, { error: { message, type, code: status } }, headers);
}

function authorized(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = header.replace(/^Bearer\s+/i, "") || String(req.headers["x-api-key"] ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(apiKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("Request body is not valid JSON.");
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" && v ? v : undefined;
}

export function createRotatorServer(opts: ServerOptions): Server {
  const { rotator, catalog } = opts;
  const log = opts.log ?? (() => {});
  // Remembered per process once Google refuses parametersJsonSchema.
  let legacySchemas = false;

  async function models(res: ServerResponse): Promise<void> {
    try {
      await catalog.ensure();
    } catch (err) {
      if (!catalog.snapshot.models.length) {
        const status = err instanceof RotatorError ? err.status : 502;
        sendError(res, status, `Could not list models: ${err instanceof Error ? err.message : err}`);
        return;
      }
    }
    sendJson(res, 200, {
      object: "list",
      data: catalog.snapshot.models.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: SERVER_NAME,
        context_window: m.contextWindow,
        meta: {
          display_name: m.displayName,
          context_length: m.contextWindow,
          max_output_tokens: m.maxOutputTokens,
          thinking: m.thinking,
          thinking_budget: m.thinkingBudget,
          multimodal: m.images,
          tool_calling: true,
        },
      })),
    });
  }

  async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body: ChatRequest = validateChatRequest(await readBody(req));
    await catalog.ensure().catch(() => {});
    const info = catalog.info(body.model);
    const upstream = upstreamModel(body.model);
    const sessionId = header(req, "x-session-affinity") ?? header(req, "session_id") ?? header(req, "x-session-id");
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    const id = `chatcmpl-${randomBytes(12).toString("hex")}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Delta, finish: string | null = null) => ({
      id,
      object: "chat.completion.chunk",
      created,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const write = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    for (let attempt = 0; ; attempt++) {
      const request = buildRequest(body, { info, legacySchemas, sessionId });
      const envelope = (projectId: string) => ({
        project: projectId,
        model: upstream,
        request,
        requestType: "agent",
        userAgent: "antigravity",
        requestId: `agent-${randomUUID()}`,
      });

      let attemptResult;
      try {
        attemptResult = await rotator.generate(upstream, (s) => envelope(s.account.projectId), abort.signal);
      } catch (err) {
        if (err instanceof RotatorError && !legacySchemas && isSchemaRejection(err.status, err.message)) {
          legacySchemas = true;
          log("Google refused parametersJsonSchema; switching tool schemas to the `parameters` field");
          continue;
        }
        throw err;
      }
      const { response, state } = attemptResult;

      let started = false;
      const translator = new ResponseTranslator(body.model, (delta) => {
        if (!body.stream) return;
        if (!started) {
          started = true;
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          write(chunk({ role: "assistant" }));
        }
        write(chunk(delta));
      });

      let streamError: string | undefined;
      try {
        for await (const event of sseJson(response.body!)) translator.push(event);
      } catch (err) {
        if (abort.signal.aborted) return;
        streamError = err instanceof Error ? err.message : String(err);
      }

      if (!translator.sawOutput && !started && attempt < EMPTY_STREAM_RETRIES) {
        log(`${state.account.email}: empty response from ${upstream}${streamError ? ` (${streamError})` : ""}; retrying`);
        continue;
      }
      log(`${state.account.email} ${upstream} ${translator.finish()}${translator.usage ? ` ${translator.usage.prompt_tokens}+${translator.usage.completion_tokens} tok` : ""}`);

      if (!body.stream) {
        if (streamError && !translator.sawOutput) return sendError(res, 502, `Upstream stream failed: ${streamError}`);
        return sendJson(res, 200, translator.completion(id, created));
      }
      if (!started) {
        if (streamError || !translator.sawOutput) return sendError(res, 502, streamError ? `Upstream stream failed: ${streamError}` : "Google returned an empty response.");
        started = true;
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        write(chunk({ role: "assistant" }));
      }
      if (streamError) {
        write({ error: { message: `Upstream stream failed: ${streamError}`, type: "server_error", code: 502 } });
        return void res.end();
      }
      const details = translator.reasoningDetails();
      if (details) write(chunk({ reasoning_details: details }));
      write(chunk({}, translator.finish()));
      if (translator.usage) write({ id, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: translator.usage });
      res.end("data: [DONE]\n\n");
      return;
    }
  }

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const run = async () => {
      if (req.method === "GET" && (path === "/health" || path === "/")) {
        return sendJson(res, 200, { ok: true, name: SERVER_NAME, version: VERSION, accounts: rotator.states.filter((s) => rotator.usable(s)).length });
      }
      if (!authorized(req, opts.apiKey)) return sendError(res, 401, "Invalid API key. Run `pi-gemini-auth setup` to configure Pi with the right key.");
      if (req.method === "GET" && path === "/v1/models") return models(res);
      if (req.method === "POST" && path === "/v1/chat/completions") return chat(req, res);
      if (req.method === "GET" && path === "/v1/accounts") return sendJson(res, 200, { accounts: rotator.snapshot() });
      sendError(res, 404, `No route for ${req.method} ${path}`);
    };
    run().catch((err: unknown) => {
      if (err instanceof RequestError) return sendError(res, 400, err.message);
      if (err instanceof RotatorError) {
        log(`request failed: ${err.status} ${err.message}`);
        return sendError(res, err.status, err.message, err.retryAfterMs);
      }
      log(`internal error: ${err instanceof Error ? err.stack : err}`);
      if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : String(err));
      else res.end();
    });
  });
}
