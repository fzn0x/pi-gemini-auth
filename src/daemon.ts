// Run the rotator in the background and stop it again.

import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { checkHealth } from "./pi/client.ts";
import { storeFiles } from "./store.ts";

export function readPid(dir: string): number | undefined {
  const file = storeFiles(dir).pid;
  if (!existsSync(file)) return undefined;
  const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const writePid = (dir: string) => writeFile(storeFiles(dir).pid, String(process.pid));
export const clearPid = (dir: string) => rm(storeFiles(dir).pid, { force: true });

/** Spawn `start` detached, logging to rotator.log, and wait until /health answers. */
export async function startDetached(dir: string, args: string[], url: string): Promise<{ pid: number; log: string }> {
  await mkdir(dir, { recursive: true });
  const { log } = storeFiles(dir);
  const fd = openSync(log, "a");
  const script = process.argv[1]!;
  const child = spawn(process.execPath, [...process.execArgv, script, "start", ...args], {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, PI_GEMINI_AUTH_HOME: dir },
  });
  child.unref();
  const pid = child.pid;
  if (!pid) throw new Error("Could not start the rotator process.");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) throw new Error(`The rotator exited right away. See ${log}`);
    try {
      await checkHealth(url, { timeoutMs: 1000 });
      return { pid, log };
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`The rotator did not answer within 10s. See ${log}`);
}

/** Stop the rotator named in the pid file, but only after it answers /health as ours. */
export async function stopDetached(dir: string, url: string): Promise<number | undefined> {
  const pid = readPid(dir);
  if (!pid || !isAlive(pid)) {
    await clearPid(dir);
    return undefined;
  }
  // A stale pid file may point at an unrelated process that reused the id.
  await checkHealth(url, { timeoutMs: 2000 });
  process.kill(pid);
  for (let i = 0; i < 40 && isAlive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  await clearPid(dir);
  return pid;
}
