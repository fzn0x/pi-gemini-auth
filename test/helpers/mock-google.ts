// A stand-in for Google's OAuth and Cloud Code Assist endpoints.

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { googleConfig, type GoogleConfig } from "../../src/google/constants.ts";

export const catalogFixture = readFileSync(new URL("../fixtures/catalog.json", import.meta.url), "utf8");

export interface Captured {
  url: string;
  headers: IncomingMessage["headers"];
  body: any;
}

/** Answers one streamGenerateContent call. Return SSE events, or an error. */
export type Script = (req: Captured, call: number) => { events: unknown[] } | { status: number; body: unknown; headers?: Record<string, string> };

export interface MockGoogle {
  url: string;
  google: GoogleConfig;
  calls: Captured[];
  tokenCalls: string[];
  /** refresh tokens that Google treats as revoked */
  revoked: Set<string>;
  script: Script;
  close(): Promise<void>;
}

export const textEvents = (text: string, extra: Record<string, unknown> = {}) => [
  { response: { candidates: [{ content: { role: "model", parts: [{ text }] } }], responseId: "r1" } },
  {
    response: {
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 },
      ...extra,
    },
  },
];

async function readBody(req: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) return undefined;
  if (String(req.headers["content-type"]).includes("x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
}

export async function startMockGoogle(): Promise<MockGoogle> {
  const mock = {
    calls: [] as Captured[],
    tokenCalls: [] as string[],
    revoked: new Set<string>(),
    script: (() => ({ events: textEvents("ok") })) as Script,
  };
  let n = 0;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(data));
    const path = (req.url ?? "").split("?")[0];
    if (path === "/token") {
      mock.tokenCalls.push(body.refresh_token ?? body.code);
      if (body.grant_type === "refresh_token" && mock.revoked.has(body.refresh_token)) {
        return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
      }
      return json(200, { access_token: `at-${body.refresh_token ?? "new"}`, expires_in: 3600, ...(body.code ? { refresh_token: "rt-new" } : {}) });
    }
    if (path === "/userinfo") return json(200, { email: "new@example.com" });
    if (path === "/v1internal:loadCodeAssist") return json(200, { cloudaicompanionProject: "proj-new" });
    if (path === "/v1internal:fetchAvailableModels") return json(200, JSON.parse(catalogFixture));
    if (path === "/v1internal:streamGenerateContent") {
      const captured = { url: req.url ?? "", headers: req.headers, body };
      mock.calls.push(captured);
      const out = mock.script(captured, n++);
      if ("status" in out) return json(out.status, out.body, out.headers);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const e of out.events) res.write(`data: ${JSON.stringify(e)}\r\n\r\n`);
      return res.end();
    }
    json(404, { error: { message: `mock: no route ${path}` } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const google = googleConfig({ endpoints: [url], tokenUrl: `${url}/token`, userInfoUrl: `${url}/userinfo` });
  return Object.assign(mock, {
    url,
    google,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
}
