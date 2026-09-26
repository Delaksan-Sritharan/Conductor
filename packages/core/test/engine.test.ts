import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { Engine, ServiceProcess, StartupError } from "../src/index.js";
import { freePort, isListening, node, project, record, server, svc, waitFor } from "./helpers.js";

const engines: Engine[] = [];
const make = (services: Parameters<typeof project>[0]) => {
  const e = new Engine(project(services));
  engines.push(e);
  return e;
};

afterEach(async () => {
  await Promise.all(engines.splice(0).map((e) => e.stop().catch(() => e.kill())));
});

describe("start ordering", () => {
  it("does not start a service until its dependency is ready, and stops in reverse order", async () => {
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()]);
    const engine = make([
      server("entity", p1, { delay: 500 }),
      server("backend", p2, { dependsOn: ["entity"], waitFor: { type: "http", url: `http://127.0.0.1:${p2}/health` } }),
      server("frontend", p3, { dependsOn: ["backend"], waitFor: { type: "output", contains: "listening on" } }),
    ]);
    const events = record(engine);

    await engine.start();

    const at = (e: string) => events.indexOf(e);
    expect(at("entity:running")).toBeGreaterThan(-1);
    expect(at("entity:running")).toBeLessThan(at("backend:starting"));
    expect(at("backend:running")).toBeLessThan(at("frontend:starting"));
    expect(engine.getStates().map((s) => s.status)).toEqual(["running", "running", "running"]);
    expect(engine.getStates().every((s) => typeof s.pid === "number")).toBe(true);

    events.length = 0;
    await engine.stop();
    expect(events.filter((e) => e.endsWith(":stopping"))).toEqual(["frontend:stopping", "backend:stopping", "entity:stopping"]);
    expect(await isListening(p1)).toBe(false);
    expect(await isListening(p2)).toBe(false);
    expect(await isListening(p3)).toBe(false);
  });

  it("starts independent services in parallel", async () => {
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()]);
    const engine = make([
      server("a", p1, { delay: 800 }),
      server("b", p2, { delay: 800 }),
      server("c", p3, { delay: 100, dependsOn: ["a", "b"] }),
    ]);
    const t0 = Date.now();
    await engine.start();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1500); // sequential would be 1600+ before c even starts
  });

  it("starting one service also starts its dependencies, but not unrelated services", async () => {
    const [p1, p2, p3] = await Promise.all([freePort(), freePort(), freePort()]);
    const engine = make([server("db", p1), server("api", p2, { dependsOn: ["db"] }), server("other", p3)]);
    await engine.start(["api"]);
    expect(engine.getStates().map((s) => `${s.name}:${s.status}`)).toEqual(["db:running", "api:running", "other:stopped"]);
  });

  it("treats wait_for: exit as a completed one-shot step", async () => {
    const p = await freePort();
    const engine = make([
      svc("migrate", { command: `${node("-e")} "console.log('migrated')"`, waitFor: { type: "exit" } }),
      server("api", p, { dependsOn: ["migrate"] }),
    ]);
    const events = record(engine);
    await engine.start();
    expect(events.indexOf("migrate:completed")).toBeLessThan(events.indexOf("api:starting"));
    expect(engine.getState("migrate").status).toBe("completed");
    expect(engine.getState("api").status).toBe("running");
  });
});

describe("failure handling", () => {
  it("stops everything already started when a later service fails", async () => {
    const [p1, p2] = await Promise.all([freePort(), freePort()]);
    const engine = make([
      server("db", p1),
      svc("api", { command: node("crash.mjs"), dependsOn: ["db"], waitFor: { type: "port", port: p2 } }),
      server("web", await freePort(), { dependsOn: ["api"] }),
    ]);

    const err = await engine.start().catch((e) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect(err.service).toBe("api");
    expect(err.message).toMatch(/exited with code 1 before becoming ready/);

    expect(engine.getState("api")).toMatchObject({ status: "failed" });
    expect(engine.getState("db").status).toBe("stopped");
    expect(engine.getState("web").status).toBe("stopped");
    expect(await isListening(p1)).toBe(false);
  });

  it("fails with a clear message when readiness times out, and kills the process", async () => {
    const p = await freePort();
    const engine = make([{ ...server("slow", p, { delay: 10_000 }), timeoutMs: 600 }]);
    const err = await engine.start().catch((e) => e);
    expect(err).toBeInstanceOf(StartupError);
    expect(err.message).toMatch(/not ready after 1s \(waiting for port/);
    expect(engine.getState("slow").status).toBe("failed");
  });

  it("refuses to start when the port is already taken", async () => {
    const p = await freePort();
    const blocker = net.createServer().listen(p, "127.0.0.1");
    await new Promise((r) => blocker.once("listening", r));
    try {
      const engine = make([server("api", p)]);
      await expect(engine.start()).rejects.toThrow(/port \d+ is already in use/);
      expect(engine.getState("api").status).toBe("stopped");
    } finally {
      blocker.close();
    }
  });

  it("reports a spawn failure instead of hanging", async () => {
    const engine = make([svc("ghost", { command: "true", cwd: "/definitely/not/a/dir", waitFor: { type: "port", port: await freePort() } })]);
    await expect(engine.start()).rejects.toThrow(/failed to start/);
  });

  it("marks a service as crashed if it dies after becoming ready", async () => {
    const p = await freePort();
    const engine = make([server("api", p, { env: { DIE_AFTER: "300" } })]);
    await engine.start();
    await waitFor(() => engine.getState("api").status === "crashed");
    expect(engine.getState("api").detail).toMatch(/exited with code 3/);
  });

  it("aborts a start in progress when stop() is called", async () => {
    const [p1, p2] = await Promise.all([freePort(), freePort()]);
    const engine = make([server("a", p1, { delay: 2000 }), server("b", p2, { dependsOn: ["a"] })]);
    const starting = engine.start().catch((e) => e);
    await waitFor(() => engine.getState("a").status === "starting");
    await engine.stop();
    const err = await starting;
    expect(err.name).toBe("CancelledError");
    expect(engine.getStates().map((s) => s.status)).toEqual(["stopped", "stopped"]);
  });
});

describe("process management", () => {
  it("stops the whole process tree, not just the shell", async () => {
    const p = await freePort();
    const engine = make([server("api", p, { script: "parent.mjs" })]);
    await engine.start();
    expect(await isListening(p)).toBe(true);
    await engine.stop();
    expect(await isListening(p)).toBe(false);
  });

  it("escalates to SIGKILL when a process ignores SIGTERM", async () => {
    const proc = new ServiceProcess(svc("stubborn", { command: node("stubborn.mjs") }));
    proc.start();
    await waitFor(() => proc.history.some((l) => l.line === "stubborn ready"));
    const t0 = Date.now();
    await proc.stop(400);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
    expect(proc.hasExited).toBe(true);
  });

  it("restarts a single service without touching its neighbours", async () => {
    const [p1, p2] = await Promise.all([freePort(), freePort()]);
    const engine = make([server("db", p1), server("api", p2, { dependsOn: ["db"] })]);
    await engine.start();
    const dbPid = engine.getState("db").pid;
    const apiPid = engine.getState("api").pid;
    await engine.restart("api");
    expect(engine.getState("db").pid).toBe(dbPid);
    expect(engine.getState("api").status).toBe("running");
    expect(engine.getState("api").pid).not.toBe(apiPid);
  });

  it("forwards log lines with the service name", async () => {
    const p = await freePort();
    const engine = make([server("api", p)]);
    const lines: string[] = [];
    engine.on("log", (l) => lines.push(`${l.service}|${l.stream}|${l.line}`));
    await engine.start();
    expect(lines).toContain("api|stdout|booting api");
    expect(lines).toContain(`api|stdout|listening on ${p}`);
  });
});
