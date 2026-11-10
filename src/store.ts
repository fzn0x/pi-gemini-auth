// Where the rotator keeps its accounts and settings: ~/.pi-gemini-auth by default.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord, readJson, writeJsonAtomic } from "./fsutil.ts";

export const DEFAULT_PORT = 51300;
export const DEFAULT_HOST = "127.0.0.1";

export type Strategy = "sticky" | "round-robin";

export interface Account {
  email: string;
  refreshToken: string;
  projectId: string;
  addedAt: string;
  /** Set when Google revoked the refresh token. The account is skipped until you log in again. */
  disabled?: boolean;
  lastError?: string;
}

export interface Config {
  host: string;
  port: number;
  apiKey: string;
  strategy: Strategy;
}

export function homeDir(override?: string): string {
  return override || process.env.PI_GEMINI_AUTH_HOME || join(homedir(), ".pi-gemini-auth");
}

export function storeFiles(dir: string) {
  return {
    accounts: join(dir, "accounts.json"),
    config: join(dir, "config.json"),
    models: join(dir, "models-cache.json"),
    pid: join(dir, "rotator.pid"),
    log: join(dir, "rotator.log"),
  };
}

function toAccount(value: unknown): Account | undefined {
  if (!isRecord(value)) return undefined;
  const { email, refreshToken, projectId } = value;
  if (typeof email !== "string" || typeof refreshToken !== "string" || typeof projectId !== "string") return undefined;
  if (!email || !refreshToken || !projectId) return undefined;
  const account: Account = {
    email,
    refreshToken,
    projectId,
    addedAt: typeof value.addedAt === "string" ? value.addedAt : new Date(0).toISOString(),
  };
  if (value.disabled === true) account.disabled = true;
  if (typeof value.lastError === "string") account.lastError = value.lastError;
  return account;
}

export async function loadAccounts(dir: string): Promise<Account[]> {
  const { data } = await readJson(storeFiles(dir).accounts);
  const list = Array.isArray(data.accounts) ? data.accounts : [];
  return list.map(toAccount).filter((a): a is Account => a !== undefined);
}

export async function saveAccounts(dir: string, accounts: Account[]): Promise<void> {
  await writeJsonAtomic(storeFiles(dir).accounts, { version: 1, accounts });
}

const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Insert or replace by email. Returns true when the account was new. */
export async function upsertAccount(dir: string, account: Account): Promise<boolean> {
  const accounts = await loadAccounts(dir);
  const i = accounts.findIndex((a) => sameEmail(a.email, account.email));
  if (i === -1) accounts.push(account);
  else accounts[i] = { ...account, addedAt: accounts[i]!.addedAt };
  await saveAccounts(dir, accounts);
  return i === -1;
}

export async function removeAccount(dir: string, email: string): Promise<boolean> {
  const accounts = await loadAccounts(dir);
  const next = accounts.filter((a) => !sameEmail(a.email, email));
  if (next.length === accounts.length) return false;
  await saveAccounts(dir, next);
  return true;
}

/** Apply a change to one stored account without clobbering accounts added meanwhile. */
export async function patchAccount(dir: string, email: string, patch: Partial<Account>): Promise<void> {
  const accounts = await loadAccounts(dir);
  const a = accounts.find((x) => sameEmail(x.email, email));
  if (!a) return;
  Object.assign(a, patch);
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (a as unknown as Record<string, unknown>)[k];
  await saveAccounts(dir, accounts);
}

export function generateApiKey(): string {
  return `pga-${randomBytes(24).toString("base64url")}`;
}

/** Load settings, creating the file with a fresh API key on first use. */
export async function loadConfig(dir: string): Promise<Config> {
  const file = storeFiles(dir).config;
  const { data, existed } = await readJson(file);
  const config: Config = {
    host: typeof data.host === "string" && data.host ? data.host : DEFAULT_HOST,
    port: Number.isInteger(data.port) && (data.port as number) > 0 ? (data.port as number) : DEFAULT_PORT,
    apiKey: typeof data.apiKey === "string" && data.apiKey ? data.apiKey : generateApiKey(),
    strategy: data.strategy === "round-robin" ? "round-robin" : "sticky",
  };
  if (!existed || data.apiKey !== config.apiKey) await writeJsonAtomic(file, { ...data, ...config });
  return config;
}
