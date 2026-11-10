// Small JSON file helpers shared by the rotator store and the Pi config editor.

import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type JsonObject = Record<string, unknown>;

export interface JsonRead {
  data: JsonObject;
  existed: boolean;
  corrupt: boolean;
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): JsonRead {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) return { data: parsed, existed: true, corrupt: false };
  } catch {
    // fall through
  }
  return { data: {}, existed: true, corrupt: true };
}

/** Never throws for a missing or broken file. */
export async function readJson(file: string): Promise<JsonRead> {
  if (!existsSync(file)) return { data: {}, existed: false, corrupt: false };
  return parseObject(await readFile(file, "utf8"));
}

export function readJsonSync(file: string): JsonRead {
  if (!existsSync(file)) return { data: {}, existed: false, corrupt: false };
  return parseObject(readFileSync(file, "utf8"));
}

export function timestamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export async function backup(file: string, stamp = timestamp()): Promise<string | undefined> {
  if (!existsSync(file)) return undefined;
  const dest = `${file}.bak-${stamp}`;
  await copyFile(file, dest);
  return dest;
}

let tmpCounter = 0;

/** Write via temp file + rename so a crash never leaves half a file. Created with 0600. */
export async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}
