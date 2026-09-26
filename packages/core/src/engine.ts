import { CancelledError, StartupError } from "./errors.js";
import { TypedEmitter } from "./events.js";
import { DependencyGraph } from "./graph.js";
import { describeExit, ServiceProcess, type ExitInfo } from "./process.js";
import { isPortOpen, waitUntilReady } from "./readiness.js";
import type { LogLine, ProjectConfig, ServiceState, ServiceStatus } from "./types.js";

export interface EngineEvents {
  status: ServiceState;
  log: { service: string } & LogLine;
}

export interface StartOptions {
  /** Refuse to start a service whose wait_for port is already taken. Default: true. */
  preflight?: boolean;
}

const LIVE: ServiceStatus[] = ["starting", "running", "completed"];

/**
 * Starts services in dependency order, waiting for each to be *ready*
 * (not merely spawned) before starting the services that depend on it.
 * Services with no dependency between them start in parallel.
 */
export class Engine extends TypedEmitter<EngineEvents> {
  readonly graph: DependencyGraph;
  private readonly states = new Map<string, ServiceState>();
  private readonly procs = new Map<string, ServiceProcess>();
  private startAbort?: AbortController;

  constructor(readonly project: ProjectConfig) {
    super();
    this.graph = new DependencyGraph(project.services);
    for (const svc of project.services) this.states.set(svc.name, { name: svc.name, status: "stopped" });
  }

  getStates(): ServiceState[] {
    return this.graph.names().map((n) => ({ ...this.states.get(n)! }));
  }

  getState(name: string): ServiceState {
    this.graph.get(name);
    return { ...this.states.get(name)! };
  }

  /** True while anything is starting or running. */
  isActive(): boolean {
    return [...this.states.values()].some((s) => s.status === "starting" || s.status === "running" || s.status === "stopping");
  }

  private setStatus(name: string, status: ServiceStatus, detail?: string): void {
    const prev = this.states.get(name)!;
    const pid = this.procs.get(name)?.pid;
    const next: ServiceState = { name, status, ...(pid !== undefined ? { pid } : {}), ...(detail ? { detail } : {}) };
    if (prev.status === status && prev.detail === next.detail && prev.pid === next.pid) return;
    this.states.set(name, next);
    this.emit("status", { ...next });
  }

  /**
   * Start `names` (default: all) plus their dependencies. Services that are
   * already live are left alone. If anything fails to become ready, every
   * service started by this call is stopped again and the error is thrown.
   */
  async start(names?: string[], options: StartOptions = {}): Promise<void> {
    if (this.startAbort && !this.startAbort.signal.aborted) throw new Error("a start is already in progress");
    const selected = this.graph.closure(names ?? this.graph.names());
    const abort = (this.startAbort = new AbortController());
    const todo = selected.filter((n) => !LIVE.includes(this.states.get(n)!.status));

    if (options.preflight !== false) await this.preflight(todo);

    for (const name of todo) this.setStatus(name, "pending", "waiting for dependencies");

    const startedNow: string[] = [];
    let firstError: Error | undefined;
    const ready = new Map<string, Promise<void>>();

    for (const name of selected) {
      if (!todo.includes(name)) {
        ready.set(name, Promise.resolve());
        continue;
      }
      const deps = this.graph.dependenciesOf(name).map((d) => ready.get(d)!);
      ready.set(
        name,
        (async () => {
          await Promise.all(deps);
          if (abort.signal.aborted) throw new CancelledError();
          startedNow.push(name);
          await this.startOne(name, abort.signal);
        })().catch((err) => {
          if (!(err instanceof CancelledError)) firstError ??= err;
          abort.abort();
          throw err;
        }),
      );
    }

    const results = await Promise.allSettled([...ready.values()]);
    const failed = results.some((r) => r.status === "rejected");

    if (failed) {
      await this.stopNames(startedNow);
      for (const name of todo) {
        if (this.states.get(name)!.status === "pending") this.setStatus(name, "stopped", "not started");
      }
      this.startAbort = undefined;
      throw firstError ?? new CancelledError();
    }
    this.startAbort = undefined;
  }

  private async preflight(names: string[]): Promise<void> {
    for (const name of names) {
      const { waitFor } = this.graph.get(name);
      if (waitFor.type !== "port") continue;
      if (await isPortOpen(waitFor.port, waitFor.host)) {
        throw new StartupError(name, `port ${waitFor.port} is already in use (stop whatever is using it, or run \`conductor doctor\`)`);
      }
    }
  }

  private async startOne(name: string, signal: AbortSignal): Promise<void> {
    const svc = this.graph.get(name);
    const proc = new ServiceProcess(svc);
    this.procs.set(name, proc);
    proc.on("line", (l) => this.emit("log", { service: name, ...l }));
    proc.on("exit", (info) => this.onExit(name, proc, info));
    proc.start();
    this.setStatus(name, "starting", `waiting for ${svc.waitFor.type === "none" ? "process" : svc.waitFor.type}`);

    try {
      await waitUntilReady(svc.waitFor, proc, { timeoutMs: svc.timeoutMs, signal });
    } catch (err) {
      const cancelled = err instanceof CancelledError;
      this.setStatus(name, cancelled ? "stopped" : "failed", cancelled ? undefined : (err as Error).message);
      await proc.stop();
      if (cancelled) throw err;
      throw new StartupError(name, (err as Error).message);
    }
    this.setStatus(name, svc.waitFor.type === "exit" ? "completed" : "running");
  }

  private onExit(name: string, proc: ServiceProcess, info: ExitInfo): void {
    if (this.procs.get(name) !== proc) return; // a newer process replaced this one
    const status = this.states.get(name)!.status;
    if (status === "running") {
      this.setStatus(name, proc.stopRequested ? "stopped" : "crashed", proc.stopRequested ? undefined : describeExit(info));
    }
    // "starting" is resolved by startOne, "stopping" by stopOne
  }

  /** Stop `names` (default: all) and everything that depends on them, dependents first. */
  async stop(names?: string[]): Promise<void> {
    this.startAbort?.abort();
    await this.stopNames(names ? this.graph.dependentClosure(names) : this.graph.names());
  }

  private async stopNames(names: string[]): Promise<void> {
    const target = new Set(names);
    const done = new Map<string, Promise<void>>();
    for (const name of [...this.graph.order()].reverse()) {
      if (!target.has(name)) continue;
      const dependents = this.graph.dependentsOf(name).flatMap((d) => (done.has(d) ? [done.get(d)!] : []));
      done.set(
        name,
        Promise.all(dependents).then(() => this.stopOne(name)),
      );
    }
    await Promise.all(done.values());
  }

  private async stopOne(name: string): Promise<void> {
    const proc = this.procs.get(name);
    const status = this.states.get(name)!.status;
    if (status === "stopped" || status === "failed") return; // keep the failure reason visible
    if (!proc) {
      this.setStatus(name, "stopped");
      return;
    }
    this.setStatus(name, "stopping");
    await proc.stop(); // also reaps grandchildren left behind by a crashed shell
    this.setStatus(name, "stopped");
  }

  /** Restart one service; its dependencies and dependents are left running. */
  async restart(name: string): Promise<void> {
    this.graph.get(name);
    await this.stopOne(name);
    await this.start([name]);
  }

  /** SIGKILL every service immediately (used on a second Ctrl+C or extension shutdown). */
  kill(): void {
    this.startAbort?.abort();
    for (const proc of this.procs.values()) proc.kill();
  }
}
