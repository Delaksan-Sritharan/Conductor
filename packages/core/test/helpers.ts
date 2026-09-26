import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine, type ProjectConfig, type ReadyCheck, type ServiceConfig } from "../src/index.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
export const node = (script: string) => `"${process.execPath}" ${script}`;

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export function svc(name: string, over: Partial<ServiceConfig> & { command: string }): ServiceConfig {
  return { name, cwd: FIXTURES, dependsOn: [], waitFor: { type: "none" }, env: {}, timeoutMs: 15_000, requires: [], ...over };
}

/** A fake server service listening on `port` after `delay` ms. */
export function server(name: string, port: number, opts: { delay?: number; dependsOn?: string[]; waitFor?: ReadyCheck; env?: Record<string, string>; script?: string } = {}) {
  return svc(name, {
    command: node(opts.script ?? "server.mjs"),
    dependsOn: opts.dependsOn ?? [],
    waitFor: opts.waitFor ?? { type: "port", port },
    env: { PORT: String(port), DELAY: String(opts.delay ?? 300), NAME: name, ...opts.env },
  });
}

export function project(services: ServiceConfig[]): ProjectConfig {
  return { root: FIXTURES, configPath: path.join(FIXTURES, ".conductor", "config.yaml"), services };
}

/** Records "name:status" strings in order. */
export function record(engine: Engine): string[] {
  const events: string[] = [];
  engine.on("status", (s) => events.push(`${s.name}:${s.status}`));
  return events;
}

export function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition not met in time");
}
