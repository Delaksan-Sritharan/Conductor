import net from "node:net";
import { CancelledError, ReadinessError } from "./errors.js";
import { describeExit, type ServiceProcess } from "./process.js";
import type { ReadyCheck } from "./types.js";

const POLL_INTERVAL_MS = 250;
const SETTLE_MS = 1000;
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function describeCheck(check: ReadyCheck): string {
  switch (check.type) {
    case "none":
      return "process alive";
    case "exit":
      return "process exit";
    case "port":
      return `port ${check.port}`;
    case "http":
      return check.url;
    case "output":
      return `output ${check.contains ? JSON.stringify(check.contains) : `/${check.regex}/`}`;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

async function poll(fn: () => Promise<boolean>, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (await fn()) return;
    await sleep(POLL_INTERVAL_MS, signal);
  }
  throw new CancelledError();
}

export function portHosts(host?: string): string[] {
  // "localhost" may be IPv4 or IPv6 depending on how the server bound, so try both.
  return host ? [host] : ["127.0.0.1", "::1"];
}

export function tryConnect(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function isPortOpen(port: number, host?: string): Promise<boolean> {
  const results = await Promise.all(portHosts(host).map((h) => tryConnect(h, port)));
  return results.some(Boolean);
}

async function httpOk(url: string, status?: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    await res.body?.cancel();
    return status !== undefined ? res.status === status : res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

function outputMatcher(check: Extract<ReadyCheck, { type: "output" }>): (line: string) => boolean {
  const re = check.regex ? new RegExp(check.regex) : undefined;
  return (raw) => {
    const line = raw.replace(ANSI_RE, "");
    return check.contains !== undefined ? line.includes(check.contains) : !!re?.test(line);
  };
}

function runCheck(check: ReadyCheck, proc: ServiceProcess, signal: AbortSignal): Promise<void> {
  switch (check.type) {
    case "none":
      return sleep(SETTLE_MS, signal).then(() => {
        if (signal.aborted) throw new CancelledError();
      });
    case "exit":
      return new Promise(() => {}); // resolved by the exit race in waitUntilReady
    case "port":
      return poll(() => isPortOpen(check.port, check.host), signal);
    case "http":
      return poll(() => httpOk(check.url, check.status), signal);
    case "output": {
      const matches = outputMatcher(check);
      return new Promise<void>((resolve) => {
        if (proc.history.some((l) => matches(l.line))) return resolve();
        const off = proc.on("line", ({ line }) => {
          if (matches(line)) {
            off();
            resolve();
          }
        });
        signal.addEventListener("abort", off, { once: true });
      });
    }
  }
}

/**
 * Resolves when `check` passes. Rejects with ReadinessError if the timeout
 * elapses or the process dies first, and CancelledError if `signal` aborts.
 */
export async function waitUntilReady(
  check: ReadyCheck,
  proc: ServiceProcess,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<void> {
  const inner = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let onOuterAbort: (() => void) | undefined;

  const race = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new ReadinessError(`not ready after ${Math.round(opts.timeoutMs / 1000)}s (waiting for ${describeCheck(check)})`)),
      opts.timeoutMs,
    );

    onOuterAbort = () => reject(new CancelledError());
    if (opts.signal.aborted) return onOuterAbort();
    opts.signal.addEventListener("abort", onOuterAbort, { once: true });

    proc.exited.then((info) => {
      if (check.type === "exit" && info.code === 0) return resolve();
      const hint = check.type === "none" && info.code === 0 ? ` (if it is meant to finish, use wait_for: { type: exit })` : "";
      reject(new ReadinessError(`${describeExit(info)} before becoming ready${hint}`));
    });

    runCheck(check, proc, inner.signal).then(resolve, reject);
  });

  try {
    await race;
  } finally {
    inner.abort();
    clearTimeout(timer);
    if (onOuterAbort) opts.signal.removeEventListener("abort", onOuterAbort);
  }
}
