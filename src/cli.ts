import { parseArgs } from "node:util";
import { ModelCatalog } from "./catalog-cache.ts";
import { clearPid, isAlive, readPid, startDetached, stopDetached, writePid } from "./daemon.ts";
import { backup, type JsonObject, readJson, timestamp, writeJsonAtomic } from "./fsutil.ts";
import { type CatalogSnapshot, fetchCatalog } from "./google/catalog.ts";
import { googleConfig } from "./google/constants.ts";
import { login } from "./google/login.ts";
import { OAuthError, refreshAccessToken } from "./google/oauth.ts";
import { checkHealth, ClientError, fetchAccounts, fetchModels, testChat } from "./pi/client.ts";
import { applyProvider, cleanLegacy, inspect, piDir, piFiles, removeProvider } from "./pi/config.ts";
import { buildPiModels, pickTestModel } from "./pi/models.ts";
import { Rotator } from "./rotator.ts";
import { createRotatorServer } from "./server.ts";
import { homeDir, loadAccounts, loadConfig, patchAccount, removeAccount, type Strategy, storeFiles, upsertAccount } from "./store.ts";
import { VERSION } from "./version.ts";

const DEFAULT_PROVIDER = "gemini-rotator";
const GEMINI_ONLY = "gemini-*";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const color = (code: number) => (s: unknown) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = color(32);
const red = color(31);
const yellow = color(33);
const dim = color(2);
const bold = color(1);

const ok = (msg: string) => console.log(`${green("✔")} ${msg}`);
const warn = (msg: string) => console.log(`${yellow("!")} ${msg}`);
const fail = (msg: string) => console.log(`${red("✖")} ${msg}`);
const info = (msg: string) => console.log(`  ${dim(msg)}`);

const HELP = `${bold("pi-gemini-auth")} ${VERSION}
Rotate your Google Antigravity accounts behind one local OpenAI-compatible
endpoint, and point the Pi coding agent at it.

${bold("Accounts")}
  pi-gemini-auth login            Add a Google account (opens the browser)
  pi-gemini-auth accounts         List accounts; --check also shows quota
  pi-gemini-auth logout <email>   Remove an account

${bold("Rotator")}
  pi-gemini-auth start            Run the rotator in this terminal
  pi-gemini-auth start --detach   Run it in the background
  pi-gemini-auth stop             Stop the background rotator

${bold("Pi")}
  pi-gemini-auth [setup]          Configure Pi to use the rotator (default)
  pi-gemini-auth status           Check Pi config, rotator and accounts
  pi-gemini-auth remove           Remove the provider from Pi

${bold("Options")}
  --port <n> / --host <h>  Rotator address (default 127.0.0.1:51300, saved in config.json)
  --url <url>              Talk to a rotator elsewhere (setup/status)
  --api-key <key>          Override the rotator key (default: generated, in config.json)
  --strategy <s>           sticky (default) or round-robin
  --provider <id>          Provider name shown in Pi (default "${DEFAULT_PROVIDER}")
  --models <globs>         Filter, e.g. "gemini-3.8-*,claude-sonnet-*,!*-low"
  --all                    Every chat model (Claude, GPT-OSS...), not just Gemini
  --keep-legacy            Keep old google-antigravity placeholder entries
  --no-start               setup: do not start the rotator if it is down
  --no-verify              setup: skip the test request
  --no-browser             login: print the URL instead of opening it
  --dry-run                Print the result without writing anything
  --pi-dir <path>          Pi config folder (default ~/.pi/agent, env PI_AGENT_DIR)
  --home <path>            Rotator folder (default ~/.pi-gemini-auth, env PI_GEMINI_AUTH_HOME)
`;

interface Options {
  command: string;
  args: string[];
  url: string | undefined;
  port: number | undefined;
  host: string | undefined;
  apiKey: string | undefined;
  strategy: Strategy | undefined;
  provider: string;
  models: string;
  keepLegacy: boolean;
  start: boolean;
  verify: boolean;
  browser: boolean;
  detach: boolean;
  check: boolean;
  dryRun: boolean;
  dir: string;
  home: string;
}

function parse(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "api-key": { type: "string" },
      strategy: { type: "string" },
      provider: { type: "string" },
      models: { type: "string" },
      all: { type: "boolean", default: false },
      "keep-legacy": { type: "boolean", default: false },
      "no-start": { type: "boolean", default: false },
      "no-verify": { type: "boolean", default: false },
      "no-browser": { type: "boolean", default: false },
      detach: { type: "boolean", short: "d", default: false },
      check: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "pi-dir": { type: "string" },
      home: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) throw new Error(`Invalid --port "${values.port}"`);
  if (values.strategy && values.strategy !== "sticky" && values.strategy !== "round-robin") throw new Error(`Invalid --strategy "${values.strategy}"`);
  return {
    command: values.help ? "help" : values.version ? "version" : (positionals[0] ?? "setup"),
    args: positionals.slice(1),
    url: values.url ?? process.env.PI_GEMINI_AUTH_URL,
    port,
    host: values.host,
    apiKey: values["api-key"] ?? process.env.PI_GEMINI_AUTH_API_KEY,
    strategy: values.strategy as Strategy | undefined,
    provider: values.provider ?? DEFAULT_PROVIDER,
    models: values.models ?? (values.all ? "" : GEMINI_ONLY),
    keepLegacy: values["keep-legacy"]!,
    start: !values["no-start"],
    verify: !values["no-verify"],
    browser: !values["no-browser"],
    detach: values.detach!,
    check: values.check!,
    dryRun: values["dry-run"]!,
    dir: piDir(values["pi-dir"]),
    home: homeDir(values.home),
  };
}

function reportError(err: unknown): void {
  fail(err instanceof Error ? err.message : String(err));
  if (err instanceof ClientError && err.hint) info(err.hint);
}

/** Where the rotator listens, and the key it expects. */
async function endpoint(o: Options): Promise<{ url: string; apiKey: string; port: number; host: string }> {
  const cfg = await loadConfig(o.home);
  const port = o.port ?? cfg.port;
  const host = o.host ?? cfg.host;
  const local = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return { url: o.url ?? `http://${local.includes(":") ? `[${local}]` : local}:${port}`, apiKey: o.apiKey ?? cfg.apiKey, port, host };
}

function serverArgs(o: Options): string[] {
  return [
    ...(o.port ? ["--port", String(o.port)] : []),
    ...(o.host ? ["--host", o.host] : []),
    ...(o.strategy ? ["--strategy", o.strategy] : []),
    ...(o.home ? ["--home", o.home] : []),
  ];
}

// ── Accounts ────────────────────────────────────────────────────────────

async function cmdLogin(o: Options): Promise<number> {
  const account = await login(googleConfig(), { openBrowser: o.browser, say: (line) => info(line) });
  const added = await upsertAccount(o.home, account);
  ok(`${added ? "Added" : "Updated"} ${account.email} (project ${account.projectId})`);
  const n = (await loadAccounts(o.home)).length;
  info(`${n} account(s) in ${storeFiles(o.home).accounts}. A running rotator picks this up by itself.`);
  return 0;
}

function quotaLine(snap: CatalogSnapshot): string {
  const families: Record<string, { min: number; reset?: string }> = {};
  for (const [id, q] of Object.entries(snap.quotas)) {
    if (q.remainingFraction === undefined && !q.resetTime) continue;
    const fam = id.startsWith("claude") || id.startsWith("gpt-oss") ? "claude" : id.startsWith("gemini") ? "gemini" : "other";
    const f = (families[fam] ??= { min: 1 });
    const left = q.remainingFraction ?? 0;
    if (left < f.min || (left === f.min && q.resetTime)) {
      f.min = left;
      if (q.resetTime) f.reset = q.resetTime;
    }
  }
  const parts = Object.entries(families).map(([fam, f]) => {
    const pct = `${Math.floor(f.min * 100)}%`;
    const reset = f.min < 1 && f.reset ? ` until ${new Date(f.reset).toLocaleTimeString()}` : "";
    return `${fam} ${f.min === 0 ? red(pct) : f.min < 0.2 ? yellow(pct) : pct}${reset}`;
  });
  return parts.length ? parts.join(" · ") : "quota unknown";
}

async function cmdAccounts(o: Options): Promise<number> {
  const accounts = await loadAccounts(o.home);
  if (!accounts.length) {
    warn("No accounts yet. Add one: pi-gemini-auth login");
    return 1;
  }
  const google = googleConfig();
  const { url, apiKey } = await endpoint(o);
  type Runtime = { email: string; cooldowns?: Record<string, string>; requests?: number; rateLimits?: number };
  const runtime = new Map<string, Runtime>();
  try {
    const health = await checkHealth(url, { timeoutMs: 1000 });
    for (const a of (await fetchAccounts(health.baseUrl, apiKey)) as Runtime[]) runtime.set(a.email.toLowerCase(), a);
  } catch {
    // rotator not running; show stored state only
  }
  let code = 0;
  for (const a of accounts) {
    const rt = runtime.get(a.email.toLowerCase());
    const cooling = Object.keys(rt?.cooldowns ?? {});
    const state = a.disabled ? red(`disabled: ${a.lastError ?? "login again"}`) : cooling.length ? yellow(`cooling: ${cooling.join(", ")}`) : green("ready");
    console.log(`${bold(a.email)}  ${state}`);
    info(`project ${a.projectId}${rt ? ` · ${rt.requests ?? 0} requests, ${rt.rateLimits ?? 0} rate limits` : ""}`);
    if (!o.check) continue;
    try {
      const token = await refreshAccessToken(google, a.refreshToken);
      info(quotaLine(await fetchCatalog(google, token.accessToken, a.projectId)));
      if (a.disabled) await patchAccount(o.home, a.email, { disabled: undefined, lastError: undefined });
    } catch (err) {
      code = 1;
      if (err instanceof OAuthError && err.invalidGrant) {
        await patchAccount(o.home, a.email, { disabled: true, lastError: "refresh token revoked" });
        fail("  Google revoked this login. Run: pi-gemini-auth login");
      } else fail(`  ${err instanceof Error ? err.message : err}`);
    }
  }
  return code;
}

async function cmdLogout(o: Options): Promise<number> {
  const email = o.args[0];
  if (!email) {
    fail("Usage: pi-gemini-auth logout <email>");
    return 1;
  }
  if (!(await removeAccount(o.home, email))) {
    warn(`${email} is not in ${storeFiles(o.home).accounts}`);
    return 1;
  }
  ok(`Removed ${email}`);
  return 0;
}

// ── Rotator ─────────────────────────────────────────────────────────────

const stamp = () => new Date().toTimeString().slice(0, 8);

async function cmdStart(o: Options): Promise<number> {
  const { url, port, host } = await endpoint({ ...o, url: undefined });
  if (o.detach) {
    try {
      const h = await checkHealth(url, { timeoutMs: 1000 });
      ok(`Rotator already running at ${h.baseUrl}`);
      return 0;
    } catch (err) {
      if (err instanceof ClientError && err.message.startsWith("Something else")) {
        reportError(err);
        return 1;
      }
    }
    const { pid, log } = await startDetached(o.home, serverArgs(o), url);
    ok(`Rotator running in the background at ${url} (pid ${pid})`);
    info(`log: ${log} · stop it with: pi-gemini-auth stop`);
    return 0;
  }

  const cfg = await loadConfig(o.home);
  const accounts = await loadAccounts(o.home);
  const log = (line: string) => console.log(`${dim(stamp())} ${line}`);
  const google = googleConfig();
  const rotator = new Rotator(accounts, { google, dir: o.home, strategy: o.strategy ?? cfg.strategy, log });
  const catalog = new ModelCatalog(google, rotator, storeFiles(o.home).models);
  await catalog.loadCache();
  const server = createRotatorServer({ rotator, catalog, apiKey: o.apiKey ?? cfg.apiKey, log });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => resolve());
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      fail(`Port ${port} on ${host} is already in use.`);
      info("Is the rotator already running (pi-gemini-auth status)? Or pick another one with --port.");
      return 1;
    }
    throw err;
  }
  const pid = readPid(o.home);
  if (!pid || pid === process.pid || !isAlive(pid)) await writePid(o.home);
  log(`pi-gemini-auth ${VERSION} listening on ${url} with ${accounts.filter((a) => !a.disabled).length} account(s), ${o.strategy ?? cfg.strategy} rotation`);
  if (!accounts.length) log("No accounts yet. In another terminal: pi-gemini-auth login");
  catalog.refresh().then(
    () => log(`${catalog.snapshot.models.length} models available`),
    (err: unknown) => log(`Could not list models yet: ${err instanceof Error ? err.message : err}`),
  );

  return new Promise<number>((resolve) => {
    const shutdown = () => {
      log("Shutting down");
      server.close();
      server.closeAllConnections();
      const own = readPid(o.home) === process.pid;
      (own ? clearPid(o.home) : Promise.resolve()).finally(() => resolve(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function cmdStop(o: Options): Promise<number> {
  const { url } = await endpoint({ ...o, url: undefined });
  try {
    const pid = await stopDetached(o.home, url);
    if (pid) ok(`Stopped the rotator (pid ${pid})`);
    else warn("No background rotator is running.");
    return 0;
  } catch (err) {
    reportError(err);
    info("Not stopping: the process in the pid file does not answer as the rotator.");
    return 1;
  }
}

// ── Pi ──────────────────────────────────────────────────────────────────

async function ensureRotator(o: Options, url: string): Promise<{ baseUrl: string; accounts: number } | undefined> {
  try {
    return await checkHealth(url);
  } catch (err) {
    const down = err instanceof ClientError && err.message.startsWith("Nothing is listening");
    if (!down || !o.start || o.url || o.dryRun) {
      reportError(err);
      return undefined;
    }
  }
  try {
    const { pid } = await startDetached(o.home, serverArgs(o), url);
    ok(`Started the rotator in the background (pid ${pid}). Stop it with: pi-gemini-auth stop`);
    return await checkHealth(url);
  } catch (err) {
    reportError(err);
    return undefined;
  }
}

async function cmdSetup(o: Options): Promise<number> {
  const files = piFiles(o.dir);
  const accounts = await loadAccounts(o.home);
  if (!o.url && !accounts.some((a) => !a.disabled)) {
    fail("No Google accounts yet.");
    info("Add one with: pi-gemini-auth login");
    return 1;
  }
  const { url, apiKey } = await endpoint(o);

  // 1. Rotator
  const health = await ensureRotator(o, url);
  if (!health) return 1;
  let listed: unknown[];
  try {
    listed = await fetchModels(health.baseUrl, apiKey);
  } catch (err) {
    reportError(err);
    return 1;
  }
  ok(`Rotator reachable at ${health.baseUrl} (${health.accounts} account(s), ${listed.length} models)`);

  // 2. Models
  const piModels = buildPiModels(listed, o.models);
  if (!piModels.length) {
    fail(`No chat models matched "${o.models || "*"}".`);
    info(listed.length ? "Try --all, or a different --models filter." : "Check the accounts: pi-gemini-auth accounts --check");
    return 1;
  }
  ok(`${piModels.length} model(s) selected${o.models ? ` (filter: ${o.models})` : ""}`);

  // 3. Pi config
  const [models, auth] = await Promise.all([readJson(files.models), readJson(files.auth)]);
  if (models.corrupt) warn(`${files.models} is not valid JSON; it will be backed up and replaced.`);
  let nextModels: JsonObject = models.data;
  let nextAuth: JsonObject = auth.data;
  let changes: string[] = [];
  if (!o.keepLegacy) {
    const cleaned = cleanLegacy(nextModels, nextAuth);
    nextModels = cleaned.models;
    nextAuth = cleaned.auth;
    changes = cleaned.changes;
  }
  nextModels = applyProvider(nextModels, o.provider, { baseUrl: health.baseUrl, apiKey, models: piModels });
  const authChanged = changes.some((x) => x.startsWith("auth.json"));

  if (o.dryRun) {
    console.log(`\n${bold(files.models)}`);
    console.log(JSON.stringify(nextModels, null, 2));
    if (authChanged) {
      console.log(`\n${bold(files.auth)}`);
      console.log(JSON.stringify(nextAuth, null, 2));
    }
    for (const ch of changes) info(`would clean: ${ch}`);
    warn("Dry run: nothing written.");
    return 0;
  }

  const when = timestamp();
  const backups = [await backup(files.models, when)];
  await writeJsonAtomic(files.models, nextModels);
  if (authChanged) {
    backups.push(await backup(files.auth, when));
    await writeJsonAtomic(files.auth, nextAuth);
  }
  ok(`Wrote provider "${o.provider}" to ${files.models}`);
  for (const ch of changes) ok(`Cleaned ${ch}`);
  for (const b of backups) if (b) info(`backup: ${b}`);

  // 4. Verify
  const testModel = pickTestModel(piModels);
  if (o.verify && testModel) {
    try {
      const r = await testChat(health.baseUrl, apiKey, testModel);
      ok(`Test request to ${testModel} succeeded in ${(r.ms / 1000).toFixed(1)}s${r.text ? ` ${dim(`→ "${r.text}"`)}` : ""}`);
    } catch (err) {
      reportError(err);
      warn("Pi is configured, but the test request failed (see above).");
      return 2;
    }
  }

  console.log(`\n${bold("Done.")} Restart Pi, open the model picker and choose a model under "${o.provider}"${testModel ? ` (e.g. ${testModel})` : ""}.`);
  return 0;
}

async function cmdStatus(o: Options): Promise<number> {
  const files = piFiles(o.dir);
  const [models, auth] = await Promise.all([readJson(files.models), readJson(files.auth)]);
  const s = inspect(models.data, auth.data, o.provider);
  let code = 0;

  console.log(bold(`Pi config: ${o.dir}`));
  if (models.corrupt) {
    fail(`${files.models} is not valid JSON`);
    code = 1;
  }
  if (s.provider) ok(`Provider "${o.provider}" → ${s.provider.baseUrl} (${s.provider.models?.length ?? 0} models)`);
  else {
    fail(`Provider "${o.provider}" not configured. Run: pi-gemini-auth setup`);
    code = 1;
  }
  if (s.legacyPlaceholder || s.legacyRedirect) warn("Old google-antigravity placeholder entries found. setup removes them.");

  const accounts = await loadAccounts(o.home);
  const usable = accounts.filter((a) => !a.disabled);
  if (usable.length) ok(`${usable.length} Google account(s) ready${accounts.length > usable.length ? `, ${accounts.length - usable.length} disabled` : ""}`);
  else {
    fail("No usable Google accounts. Run: pi-gemini-auth login");
    code = 1;
  }

  const ep = await endpoint(o);
  const base = s.provider?.baseUrl ? String(s.provider.baseUrl) : ep.url;
  const key = typeof s.provider?.apiKey === "string" ? s.provider.apiKey : ep.apiKey;
  try {
    const health = await checkHealth(base);
    const listed = await fetchModels(health.baseUrl, key);
    ok(`Rotator ${health.version} reachable at ${health.baseUrl} (${listed.length} models)`);
    if (s.provider) {
      const live = new Set(listed.map((m) => (m as { id: string }).id));
      const stale = (s.provider.models ?? []).filter((m) => !live.has(m.id));
      if (stale.length) {
        warn(`${stale.length} configured model(s) no longer offered: ${stale.map((m) => m.id).join(", ")}`);
        info("Re-run setup to refresh the model list.");
      }
    }
  } catch (err) {
    reportError(err);
    code = 1;
  }
  return code;
}

async function cmdRemove(o: Options): Promise<number> {
  const files = piFiles(o.dir);
  const models = await readJson(files.models);
  const { next, removed } = removeProvider(models.data, o.provider);
  if (!removed) {
    warn(`Provider "${o.provider}" was not in ${files.models}; nothing to do.`);
    return 0;
  }
  if (o.dryRun) {
    warn(`Dry run: would remove provider "${o.provider}".`);
    return 0;
  }
  const b = await backup(files.models);
  await writeJsonAtomic(files.models, next);
  ok(`Removed provider "${o.provider}" from ${files.models}`);
  if (b) info(`backup: ${b}`);
  info("The rotator and your accounts are untouched. Stop it with: pi-gemini-auth stop");
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let o: Options;
  try {
    o = parse(argv);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    console.log(HELP);
    return 1;
  }
  try {
    switch (o.command) {
      case "setup":
        return await cmdSetup(o);
      case "status":
      case "doctor":
        return await cmdStatus(o);
      case "remove":
      case "uninstall":
        return await cmdRemove(o);
      case "login":
        return await cmdLogin(o);
      case "logout":
        return await cmdLogout(o);
      case "accounts":
        return await cmdAccounts(o);
      case "start":
      case "serve":
        return await cmdStart(o);
      case "stop":
        return await cmdStop(o);
      case "version":
        console.log(VERSION);
        return 0;
      case "help":
        console.log(HELP);
        return 0;
      default:
        fail(`Unknown command "${o.command}"`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    reportError(err);
    return 1;
  }
}
