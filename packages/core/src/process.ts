import { spawn, type ChildProcess } from "node:child_process";
import { TypedEmitter } from "./events.js";
import type { LogLine, ServiceConfig } from "./types.js";

const IS_WINDOWS = process.platform === "win32";
const HISTORY_LIMIT = 500;

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be spawned at all. */
  error?: string;
}

export function describeExit(info: ExitInfo): string {
  if (info.error) return `failed to start (${info.error})`;
  if (info.signal) return `was killed by ${info.signal}`;
  return `exited with code ${info.code}`;
}

/** Send a signal to a whole process group (POSIX) or tree (Windows). */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  if (IS_WINDOWS) {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function isGroupAlive(pid: number): boolean {
  try {
    process.kill(IS_WINDOWS ? pid : -pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

class LineSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r?\n/);
    this.buffer = parts.pop() ?? "";
    return parts;
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? [rest] : [];
  }
}

/**
 * One running service. Each service gets its own process group so that
 * `npm run dev` (which spawns children) can be stopped as a unit.
 */
export class ServiceProcess extends TypedEmitter<{ line: LogLine; exit: ExitInfo }> {
  private child?: ChildProcess;
  private exitInfo?: ExitInfo;
  private resolveExited!: (info: ExitInfo) => void;
  readonly exited = new Promise<ExitInfo>((resolve) => {
    this.resolveExited = resolve;
  });
  /** Recent output, so readiness checks never miss a line emitted before they attached. */
  readonly history: LogLine[] = [];
  stopRequested = false;

  constructor(readonly service: ServiceConfig) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get hasExited(): boolean {
    return this.exitInfo !== undefined;
  }

  start(): void {
    const svc = this.service;
    const child = spawn(svc.command, {
      cwd: svc.cwd,
      env: { ...process.env, FORCE_COLOR: "1", ...svc.env },
      shell: true,
      detached: !IS_WINDOWS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };
    const emitLines = (stream: LogLine["stream"], lines: string[]) => {
      for (const line of lines) {
        const entry: LogLine = { stream, line };
        this.history.push(entry);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        this.emit("line", entry);
      }
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]!.setEncoding("utf8");
      child[stream]!.on("data", (chunk: string) => emitLines(stream, splitters[stream].push(chunk)));
    }
    child.on("close", () => {
      emitLines("stdout", splitters.stdout.flush());
      emitLines("stderr", splitters.stderr.flush());
    });

    child.on("error", (err) => {
      // spawn failures (e.g. missing cwd) surface here and are never followed by "exit"
      if (child.pid === undefined) this.finish({ code: null, signal: null, error: err.message });
    });
    child.on("exit", (code, signal) => this.finish({ code, signal }));
  }

  private finish(info: ExitInfo): void {
    if (this.exitInfo) return;
    this.exitInfo = info;
    this.emit("exit", info);
    this.resolveExited(info);
  }

  /** Graceful stop: SIGTERM the group, wait, then SIGKILL whatever is left. */
  async stop(graceMs = 5000): Promise<void> {
    const pid = this.pid;
    if (!this.child || pid === undefined) return;
    this.stopRequested = true;
    if (this.hasExited && !isGroupAlive(pid)) return;

    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && !(this.hasExited && !isGroupAlive(pid))) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isGroupAlive(pid)) signalGroup(pid, "SIGKILL");
    await this.exited;
  }

  /** Immediate SIGKILL of the whole group. */
  kill(): void {
    if (this.pid !== undefined) signalGroup(this.pid, "SIGKILL");
  }
}
