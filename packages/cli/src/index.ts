#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  CONFIG_DIR,
  CONFIG_TEMPLATE,
  ConfigError,
  Engine,
  describeCheck,
  findConfigFile,
  loadConfig,
  runDoctor,
  signalGroup,
  type ProjectConfig,
} from "@devflow/core";
import { c, colorFor, statusLine } from "./format.js";
import { isAlive, isOurProcess, readState, removeState, writeState, type StateFile } from "./state.js";

const program = new Command();
program.name("devflow").description("Start your dev services in dependency order, each one only once the previous is ready.").version("0.1.0");
program.option("-c, --config <path>", "path to .devflow/config.yaml (default: search upwards from the current directory)");

function loadProject(): ProjectConfig {
  const explicit = program.opts<{ config?: string }>().config;
  const file = explicit ? path.resolve(explicit) : findConfigFile(process.cwd());
  if (!file) throw new ConfigError(`no ${CONFIG_DIR}/config.yaml found (run \`devflow init\` to create one)`);
  return loadConfig(file);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

// ---------------------------------------------------------------- init

program
  .command("init")
  .description("create a starter .devflow/config.yaml in the current directory")
  .action(() => {
    const dir = path.join(process.cwd(), CONFIG_DIR);
    const file = path.join(dir, "config.yaml");
    if (fs.existsSync(file)) throw new ConfigError(`${file} already exists`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, CONFIG_TEMPLATE);
    fs.writeFileSync(path.join(dir, ".gitignore"), "state.json\n");
    console.log(`Created ${path.relative(process.cwd(), file)}. Edit it, then run ${c.bold("devflow start")}.`);
  });

// ---------------------------------------------------------------- start

program
  .command("start [services...]")
  .description("start all services (or the named ones plus their dependencies) and stream their logs")
  .option("--no-preflight", "do not fail when a service's port is already in use")
  .action(async (names: string[], opts: { preflight: boolean }) => {
    const project = loadProject();
    const engine = new Engine(project);
    for (const n of names) if (!engine.graph.has(n)) throw new ConfigError(`unknown service "${n}"`);

    const existing = readState(project);
    if (existing && existing.cliPid !== process.pid && isAlive(existing.cliPid)) {
      throw new Error(`devflow is already running for this project (PID ${existing.cliPid}). Use \`devflow stop\` first.`);
    }

    const width = Math.max(...project.services.map((s) => s.name.length));
    const colors = new Map(project.services.map((s, i) => [s.name, colorFor(i)]));
    const prefix = (name: string) => colors.get(name)!(`${name.padEnd(width)} │`);

    const state: StateFile = { cliPid: process.pid, startedAt: new Date().toISOString(), services: {} };
    engine.on("status", (s) => {
      const prev = state.services[s.name];
      state.services[s.name] = { status: s.status, pid: s.pid, spawnedAt: s.status === "starting" ? Date.now() : prev?.spawnedAt };
      writeState(project, state);
      if (s.status !== "pending") console.log(statusLine(s.name, s.status, s.detail, width));
    });
    engine.on("log", ({ service, line }) => console.log(`${prefix(service)} ${line}`));

    let shutdown: Promise<void> | undefined;
    const onSignal = (sig: string) => {
      if (shutdown) {
        console.log(c.yellow("\nForce killing…"));
        engine.kill();
        removeState(project);
        process.exit(130);
      }
      console.log(c.dim(`\nReceived ${sig}, stopping services (Ctrl+C again to force)…`));
      shutdown = engine.stop().then(() => {
        removeState(project);
        process.exit(0);
      });
    };
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => onSignal(sig));

    const plan = engine.graph.closure(names.length ? names : engine.graph.names());
    console.log(c.bold(`Starting ${plan.length} service${plan.length === 1 ? "" : "s"}`) + c.dim(`  (${plan.join(" → ")})`));

    try {
      await engine.start(names.length ? names : undefined, { preflight: opts.preflight });
    } catch (err) {
      if (shutdown) return shutdown; // Ctrl+C during startup
      console.error(`\n${c.red("✗ Startup failed:")} ${(err as Error).message}`);
      removeState(project);
      process.exitCode = 1;
      return;
    }

    console.log(`\n${c.green("✓ All services ready.")} ${c.dim("Press Ctrl+C to stop everything.")}\n`);

    // Stay attached until Ctrl+C, or until nothing is left running (e.g. every service crashed).
    await new Promise<void>((resolve) => {
      const check = () => !engine.isActive() && !shutdown && resolve();
      engine.on("status", check);
      check();
    });
    if (!shutdown) {
      const crashed = engine.getStates().some((s) => s.status === "crashed" || s.status === "failed");
      removeState(project);
      process.exitCode = crashed ? 1 : 0;
    }
  });

// ---------------------------------------------------------------- stop

program
  .command("stop")
  .description("stop a running `devflow start` for this project")
  .action(async () => {
    const project = loadProject();
    const state = readState(project);
    if (!state) return void console.log("Nothing running.");

    if (state.cliPid !== process.pid && isAlive(state.cliPid)) {
      console.log(`Asking devflow (PID ${state.cliPid}) to stop services in reverse order…`);
      process.kill(state.cliPid, "SIGTERM");
      if (await waitUntil(() => !isAlive(state.cliPid), 60_000)) {
        console.log("Stopped.");
        return removeState(project);
      }
      console.error(c.yellow("devflow did not exit within 60s; cleaning up its services directly."));
    }

    // The starter is gone (crash / kill -9): reap any orphaned service process groups.
    const orphans = Object.entries(state.services).filter(([, s]) => isOurProcess(s.pid, s.spawnedAt));
    for (const [name, s] of orphans) {
      console.log(`Stopping orphaned ${name} (PID ${s.pid})`);
      signalGroup(s.pid!, "SIGTERM");
    }
    if (orphans.length) {
      await waitUntil(() => orphans.every(([, s]) => !isOurProcess(s.pid, s.spawnedAt)), 5000);
      for (const [, s] of orphans) if (isOurProcess(s.pid, s.spawnedAt)) signalGroup(s.pid!, "SIGKILL");
    }
    removeState(project);
    console.log(orphans.length ? "Cleaned up." : "Nothing was running (removed stale state).");
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("show what is running")
  .action(() => {
    const project = loadProject();
    const state = readState(project);
    const width = Math.max(...project.services.map((s) => s.name.length));
    const starterAlive = !!state && isAlive(state.cliPid);

    for (const svc of project.services) {
      const entry = state?.services[svc.name];
      const live = entry && isOurProcess(entry.pid, entry.spawnedAt);
      const status = live ? (entry.status === "starting" ? "starting" : "running") : entry?.status === "failed" ? "failed" : "stopped";
      const detail = live ? `PID ${entry.pid}${starterAlive ? "" : " (orphaned: starter exited)"}` : undefined;
      console.log(statusLine(svc.name, status, detail, width));
    }
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("check directories, commands, required tools and ports before starting")
  .action(async () => {
    const project = loadProject();
    const results = await runDoctor(project);
    const icon = { ok: c.green("✓"), warn: c.yellow("!"), error: c.red("✗") } as const;
    let lastService: string | undefined;
    for (const r of results) {
      if (r.service !== lastService) console.log(`\n${c.bold(r.service ?? "project")}`);
      lastService = r.service;
      console.log(`  ${icon[r.level]} ${r.message}${r.hint ? c.dim(`  → ${r.hint}`) : ""}`);
    }
    const errors = results.filter((r) => r.level === "error").length;
    console.log(errors ? `\n${c.red(`${errors} problem${errors === 1 ? "" : "s"} found.`)}` : `\n${c.green("Everything looks good.")}`);
    process.exitCode = errors ? 1 : 0;
  });

// ---------------------------------------------------------------- graph

program
  .command("graph")
  .description("show the start order and what each service waits for")
  .action(() => {
    const project = loadProject();
    const engine = new Engine(project);
    engine.graph.waves().forEach((wave, i) => {
      console.log(c.bold(`Step ${i + 1}`) + c.dim(wave.length > 1 ? "  (in parallel)" : ""));
      for (const name of wave) {
        const svc = engine.graph.get(name);
        const deps = svc.dependsOn.length ? c.dim(`  after ${svc.dependsOn.join(", ")}`) : "";
        console.log(`  ${name}${deps}  ${c.dim(`ready when: ${describeCheck(svc.waitFor)}`)}`);
      }
    });
  });

program.parseAsync().catch((err: unknown) => {
  console.error(c.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
