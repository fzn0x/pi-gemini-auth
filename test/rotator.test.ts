import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { retryDelayMs } from "../src/retry.ts";
import { Rotator, RotatorError } from "../src/rotator.ts";
import { type Account, loadAccounts, saveAccounts } from "../src/store.ts";
import { type MockGoogle, startMockGoogle, textEvents } from "./helpers/mock-google.ts";

let g: MockGoogle;
before(async () => {
  g = await startMockGoogle();
});
after(() => g.close());
beforeEach(() => {
  g.calls.length = 0;
  g.revoked.clear();
  g.script = () => ({ events: textEvents("ok") });
});

const acct = (email: string): Account => ({ email, refreshToken: `rt-${email}`, projectId: `p-${email}`, addedAt: "2026-01-01T00:00:00Z" });
const envelope = (s: { account: Account }) => ({ project: s.account.projectId, model: "m", request: {} });
const quota429 = (delay: string) => ({
  status: 429,
  body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } },
});

test("retry delay parsing", () => {
  assert.equal(retryDelayMs('{"retryDelay": "34.5s"}'), 34500);
  assert.equal(retryDelayMs("Your quota will reset after 1h2m3s."), 3723000);
  assert.equal(retryDelayMs("Please retry in 250ms"), 250);
  assert.equal(retryDelayMs('"quotaResetDelay": "2m"'), 120000);
  assert.equal(retryDelayMs("", new Headers({ "retry-after": "7" })), 7000);
  assert.equal(retryDelayMs("nothing here"), undefined);
});

test("sticky: stays on one account until it is rate limited, then moves on", async () => {
  const r = new Rotator([acct("a"), acct("b")], { google: g.google });
  g.script = (req) => (req.body.project === "p-a" && g.calls.length === 3 ? quota429("3600s") : { events: textEvents("ok") });
  for (let i = 0; i < 2; i++) assert.equal((await r.generate("m", envelope)).state.account.email, "a");
  const third = await r.generate("m", envelope);
  assert.equal(third.state.account.email, "b");
  assert.deepEqual(g.calls.map((c) => c.body.project), ["p-a", "p-a", "p-a", "p-b"]);
  // a stays cooled for this model only
  assert.equal((await r.generate("m", envelope)).state.account.email, "b");
  assert.equal((await r.generate("other", envelope)).state.account.email, "a");
  assert.equal(g.calls.at(-1)!.headers.authorization, "Bearer at-rt-a");
  assert.match(String(g.calls.at(-1)!.headers["user-agent"]), /^antigravity\//);
});

test("round-robin spreads requests", async () => {
  const r = new Rotator([acct("a"), acct("b"), acct("c")], { google: g.google, strategy: "round-robin" });
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push((await r.generate("m", envelope)).state.account.email);
  assert.deepEqual(seen, ["a", "b", "c", "a"]);
});

test("all accounts limited: short waits are absorbed, long ones become a 429 with retry-after", async () => {
  const r = new Rotator([acct("a")], { google: g.google, maxWaitMs: 2000 });
  g.script = (_req, call) => (call === 0 ? quota429("0.3s") : { events: textEvents("ok") });
  const ok = await r.generate("m", envelope);
  assert.equal(ok.state.account.email, "a");

  g.script = () => quota429("600s");
  await assert.rejects(r.generate("m2", envelope), (err: RotatorError) => {
    assert.equal(err.status, 429);
    assert.ok(err.retryAfterMs! > 590_000);
    return true;
  });
});

test("revoked refresh token disables the account and persists it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pga-rot-"));
  await saveAccounts(dir, [acct("a"), acct("b")]);
  g.revoked.add("rt-a");
  const r = new Rotator(await loadAccounts(dir), { google: g.google, dir });
  const res = await r.generate("m", envelope);
  assert.equal(res.state.account.email, "b");
  const stored = await loadAccounts(dir);
  assert.equal(stored.find((a) => a.email === "a")?.disabled, true);
  assert.equal(stored.find((a) => a.email === "b")?.disabled, undefined);
});

test("a 401 refreshes the token once and retries the same account", async () => {
  const r = new Rotator([acct("a")], { google: g.google });
  g.script = (_req, call) => (call === 0 ? { status: 401, body: { error: { message: "expired" } } } : { events: textEvents("ok") });
  const res = await r.generate("m", envelope);
  assert.equal(res.response.status, 200);
  assert.equal(g.tokenCalls.filter((t) => t === "rt-a").length >= 2, true);
});

test("a 400 is returned as is without trying other accounts", async () => {
  const r = new Rotator([acct("a"), acct("b")], { google: g.google });
  g.script = () => ({ status: 400, body: { error: { message: "Invalid argument: contents" } } });
  await assert.rejects(r.generate("m", envelope), (err: RotatorError) => err.status === 400 && /Invalid argument/.test(err.message));
  assert.equal(g.calls.length, 1);
});

test("server errors are retried a few times, then reported", async () => {
  const r = new Rotator([acct("a")], { google: g.google });
  g.script = (_req, call) => (call < 2 ? { status: 503, body: { error: { message: "overloaded" } } } : { events: textEvents("ok") });
  assert.equal((await r.generate("m", envelope)).response.status, 200);
  g.script = () => ({ status: 503, body: { error: { message: "overloaded" } } });
  await assert.rejects(r.generate("m", envelope), (err: RotatorError) => err.status === 502);
});

test("accounts added while running are picked up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pga-rot-"));
  await saveAccounts(dir, [acct("a")]);
  let clock = 1_000_000;
  const r = new Rotator(await loadAccounts(dir), { google: g.google, dir, now: () => clock });
  await new Promise((res) => setTimeout(res, 20));
  await saveAccounts(dir, [acct("a"), acct("b")]);
  clock += 5000;
  await r.refreshAccountsIfChanged();
  assert.deepEqual(r.states.map((s) => s.account.email), ["a", "b"]);
});
