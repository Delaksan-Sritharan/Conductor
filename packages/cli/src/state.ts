import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, isGroupAlive, type ProjectConfig, type ServiceStatus } from "@devflow/core";

/**
 * `.devflow/state.json` lets `devflow stop` and `devflow status` (separate
 * processes) find a running `devflow start`, and clean up after a hard kill.
 */
export interface StateFile {
  cliPid: number;
  startedAt: string;
  services: Record<string, { status: ServiceStatus; pid?: number; spawnedAt?: number }>;
}

const statePath = (p: ProjectConfig) => path.join(p.root, CONFIG_DIR, "state.json");

export function readState(p: ProjectConfig): StateFile | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath(p), "utf8")) as StateFile;
  } catch {
    return undefined;
  }
}

export function writeState(p: ProjectConfig, state: StateFile): void {
  try {
    fs.writeFileSync(statePath(p), JSON.stringify(state, null, 2));
  } catch {
    /* read-only checkout etc.: state is a convenience, never fatal */
  }
}

export function removeState(p: ProjectConfig): void {
  try {
    fs.rmSync(statePath(p), { force: true });
  } catch {
    /* ignore */
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Guards against PID reuse: after a reboot or a long-dead session an old PID
 * may belong to an unrelated process. We only trust a recorded PID if that
 * process started within a few seconds of when we recorded spawning it.
 */
export function isOurProcess(pid: number | undefined, spawnedAt: number | undefined): boolean {
  if (pid === undefined || spawnedAt === undefined || process.platform === "win32") return false;
  if (!isGroupAlive(pid)) return false;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] });
    const started = new Date(out.trim()).getTime();
    return Number.isFinite(started) && Math.abs(started - spawnedAt) < 5000;
  } catch {
    return false;
  }
}
