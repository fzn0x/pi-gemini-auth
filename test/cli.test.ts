import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ModelCatalog } from "../src/catalog-cache.ts";
import { main } from "../src/cli.ts";
import { Rotator } from "../src/rotator.ts";
import { createRotatorServer } from "../src/server.ts";
import { loadAccounts, loadConfig, saveAccounts } from "../src/store.ts";
import { type MockGoogle, startMockGoogle } from "./helpers/mock-google.ts";

let g: MockGoogle;
let server: Server;
let home: string;
let port: number;
let apiKey: string;

before(async () => {
  g = await startMockGoogle();
  process.env.PGA_ENDPOINTS = g.url;
  process.env.PGA_TOKEN_URL = `${g.url}/token`;
  home = await mkdtemp(join(tmpdir(), "pga-home-"));
  await saveAccounts(home, [{ email: "a@x", refreshToken: "rt-a", projectId: "p-a", addedAt: "" }]);
  apiKey = (await loadConfig(home)).apiKey;
  const rotator = new Rotator(await loadAccounts(home), { google: g.google });
  server = createRotatorServer({ rotator, catalog: new ModelCatalog(g.google, rotator), apiKey });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  delete process.env.PGA_ENDPOINTS;
  delete process.env.PGA_TOKEN_URL;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await g.close();
});

const quiet = async (fn: () => Promise<number>) => {
  const log = console.log;
  const out: string[] = [];
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  try {
    return { code: await fn(), out: out.join("\n") };
  } finally {
    console.log = log;
  }
};

const run = (pi: string, ...args: string[]) => quiet(() => main([...args, "--home", home, "--port", String(port), "--pi-dir", pi, "--no-start"]));
const fresh = () => mkdtemp(join(tmpdir(), "pga-pi-"));
const read = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));

test("setup replaces the old placeholders and keeps everything else", async () => {
  const pi = await fresh();
  await writeFile(
    join(pi, "auth.json"),
    JSON.stringify({
      "google-antigravity": { type: "oauth", refresh: "proxy-managed", access: "proxy-managed", expires: 1 },
      anthropic: { type: "api_key", key: "keep-me" },
    }),
  );
  await writeFile(
    join(pi, "models.json"),
    JSON.stringify({
      providers: {
        "google-antigravity": { baseUrl: "http://localhost:51200" },
        other: { baseUrl: "http://x" },
      },
    }),
  );

  const { code, out } = await run(pi, "setup");
  assert.equal(code, 0, out);
  assert.match(out, /Test request to gemini-3\.8-flash-medium succeeded/);

  const models = read(pi, "models.json");
  assert.equal(models.providers["google-antigravity"], undefined);
  assert.deepEqual(models.providers.other, { baseUrl: "http://x" });
  const p = models.providers["gemini-rotator"];
  assert.equal(p.baseUrl, `http://127.0.0.1:${port}/v1`);
  assert.equal(p.api, "openai-completions");
  assert.equal(p.apiKey, apiKey);
  assert.ok(p.models.length > 5 && p.models.every((m: { id: string }) => m.id.startsWith("gemini-")));
  assert.equal(p.models.find((m: { id: string }) => m.id === "gemini-3.8-flash-high").name, "Gemini 3.8 Flash High");

  const auth = read(pi, "auth.json");
  assert.equal(auth["google-antigravity"], undefined);
  assert.deepEqual(auth.anthropic, { type: "api_key", key: "keep-me" });
  assert.ok(readdirSync(pi).some((f) => f.startsWith("models.json.bak-")));
  assert.ok(readdirSync(pi).some((f) => f.startsWith("auth.json.bak-")));
});

test("--all adds Claude; user extras survive a re-run", async () => {
  const pi = await fresh();
  await run(pi, "--no-verify");
  const first = read(pi, "models.json");
  first.providers["gemini-rotator"].models[0].custom = 1;
  first.providers["gemini-rotator"].headers = { "X-Mine": "1" };
  await writeFile(join(pi, "models.json"), JSON.stringify(first));

  await run(pi, "--no-verify", "--all");
  const p = read(pi, "models.json").providers["gemini-rotator"];
  assert.ok(p.models.some((m: { id: string }) => m.id === "claude-opus-5-5-high"));
  assert.equal(p.models.find((m: { id: string }) => m.id === first.providers["gemini-rotator"].models[0].id).custom, 1);
  assert.deepEqual(p.headers, { "X-Mine": "1" });
});

test("dry run writes nothing", async () => {
  const pi = await fresh();
  const { code } = await run(pi, "--dry-run");
  assert.equal(code, 0);
  assert.ok(!existsSync(join(pi, "models.json")));
});

test("status and remove", async () => {
  const pi = await fresh();
  let r = await run(pi, "status");
  assert.equal(r.code, 1);
  assert.match(r.out, /not configured/);

  await run(pi, "--no-verify");
  r = await run(pi, "status");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1 Google account\(s\) ready/);

  r = await run(pi, "remove");
  assert.equal(r.code, 0);
  assert.equal(read(pi, "models.json").providers["gemini-rotator"], undefined);
});

test("rotator down with --no-start gives the start hint", async () => {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const closed = (probe.address() as { port: number }).port;
  await new Promise((r) => probe.close(r));
  const { code, out } = await quiet(() => main(["--home", home, "--port", String(closed), "--pi-dir", "unused", "--no-start"]));
  assert.equal(code, 1);
  assert.match(out, /pi-gemini-auth start --detach/);
});

test("refuses to configure Pi against some other server", async () => {
  const other = http.createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  const otherPort = (other.address() as { port: number }).port;
  try {
    const { code, out } = await quiet(() => main(["--home", home, "--port", String(otherPort), "--pi-dir", "unused", "--no-start"]));
    assert.equal(code, 1);
    assert.match(out, /Something else is answering/);
  } finally {
    other.close();
  }
});

test("setup without accounts points at login", async () => {
  const empty = await mkdtemp(join(tmpdir(), "pga-empty-"));
  const { code, out } = await quiet(() => main(["--home", empty, "--pi-dir", "unused"]));
  assert.equal(code, 1);
  assert.match(out, /pi-gemini-auth login/);
});

test("accounts --check shows quota; a revoked login is flagged; logout removes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pga-acc-"));
  await saveAccounts(dir, [
    { email: "good@x", refreshToken: "rt-good", projectId: "p1", addedAt: "" },
    { email: "gone@x", refreshToken: "rt-gone", projectId: "p2", addedAt: "" },
  ]);
  g.revoked.add("rt-gone");
  const { code, out } = await quiet(() => main(["accounts", "--check", "--home", dir, "--port", "1"]));
  assert.equal(code, 1);
  assert.match(out, /gemini 100%/);
  assert.match(out, /claude 40%/);
  assert.match(out, /revoked/);
  assert.equal((await loadAccounts(dir)).find((a) => a.email === "gone@x")?.disabled, true);

  const r = await quiet(() => main(["logout", "gone@x", "--home", dir]));
  assert.equal(r.code, 0);
  assert.deepEqual((await loadAccounts(dir)).map((a) => a.email), ["good@x"]);
});

test("config.json gets a generated key on first use and keeps it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pga-cfg-"));
  await mkdir(dir, { recursive: true });
  const a = await loadConfig(dir);
  const b = await loadConfig(dir);
  assert.match(a.apiKey, /^pga-/);
  assert.equal(a.apiKey, b.apiKey);
  assert.equal(a.port, 51300);
});
