// Reading Google's error responses: how long to back off and what kind of failure it is.

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

export type FailureKind = "rate_limit" | "auth" | "forbidden" | "server" | "client";

export function classify(status: number, body: string): FailureKind {
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(body)) return "rate_limit";
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status >= 500 || status === 408 || /overloaded|unavailable/i.test(body)) return "server";
  return "client";
}

function durationMs(value: number, unit: string | undefined): number {
  return unit?.toLowerCase() === "ms" ? value : value * 1000;
}

/** Back-off Google asks for, from headers or the error body. Undefined when it gives none. */
export function retryDelayMs(body: string, headers?: Headers, now = Date.now()): number | undefined {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date) && date > now) return date - now;
  }
  // "Your quota will reset after 18h31m10s" / "after 39s"
  const reset = body.match(/reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i);
  if (reset) {
    const ms = ((Number(reset[1] ?? 0) * 60 + Number(reset[2] ?? 0)) * 60 + Number(reset[3])) * 1000;
    if (ms > 0) return ms;
  }
  const retryIn = body.match(/Please retry in ([0-9.]+)(ms|s)\b/i);
  if (retryIn) {
    const ms = durationMs(Number(retryIn[1]), retryIn[2]);
    if (ms > 0) return ms;
  }
  // google.rpc.RetryInfo: "retryDelay": "34.07s"
  const retryInfo = body.match(/"retryDelay"\s*:\s*"([0-9.]+)(ms|s)"/i);
  if (retryInfo) {
    const ms = durationMs(Number(retryInfo[1]), retryInfo[2]);
    if (ms > 0) return ms;
  }
  // google.rpc.ErrorInfo metadata: "quotaResetDelay": "1h2m3s"
  const quotaReset = body.match(/"quotaResetDelay"\s*:\s*"(?:(\d+)h)?(?:(\d+)m)?([0-9.]+)?(ms|s)?"/i);
  if (quotaReset && (quotaReset[1] || quotaReset[2] || quotaReset[3])) {
    const tail = quotaReset[3] ? durationMs(Number(quotaReset[3]), quotaReset[4]) : 0;
    const ms = (Number(quotaReset[1] ?? 0) * 3600 + Number(quotaReset[2] ?? 0) * 60) * 1000 + tail;
    if (ms > 0) return ms;
  }
  return undefined;
}

/** The human part of a Google error body. */
export function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } } | Array<{ error?: { message?: unknown } }>;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (typeof first?.error?.message === "string") return first.error.message;
  } catch {
    // not JSON
  }
  return body.slice(0, 500);
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
