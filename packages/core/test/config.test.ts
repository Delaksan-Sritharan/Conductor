import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/index.js";

const root = path.resolve("/tmp/project");

describe("parseConfig", () => {
  it("parses the map form with defaults and resolves paths against the project root", () => {
    const cfg = parseConfig(
      `
services:
  entity:
    path: ./entity
    command: npm run dev
    wait_for: { type: port, value: 8081 }
  backend:
    command: ./gradlew bootRun
    depends_on: entity
    timeout: 90
    env: { SPRING_PROFILES_ACTIVE: dev, PORT: 8080 }
    wait_for: { type: http, url: "http://localhost:8080/health" }
`,
      root,
    );
    const [entity, backend] = cfg.services;
    expect(entity).toMatchObject({ name: "entity", cwd: path.join(root, "entity"), waitFor: { type: "port", port: 8081 }, timeoutMs: 120_000 });
    expect(backend).toMatchObject({ cwd: root, dependsOn: ["entity"], timeoutMs: 90_000, env: { SPRING_PROFILES_ACTIVE: "dev", PORT: "8080" } });
    expect(backend!.waitFor).toEqual({ type: "http", url: "http://localhost:8080/health" });
  });

  it("parses the list form", () => {
    const cfg = parseConfig(`services:\n  - name: a\n    command: x\n  - name: b\n    command: y\n    depends_on: [a]\n`, root);
    expect(cfg.services.map((s) => s.name)).toEqual(["a", "b"]);
  });

  it("points at the offending field", () => {
    expect(() => parseConfig(`services:\n  a:\n    command: x\n    wait_for: { type: port, value: 99999 }\n`, root)).toThrow(/services\.a\.wait_for\.value/);
  });

  it("catches typos in keys", () => {
    expect(() => parseConfig(`services:\n  a:\n    command: x\n    depend_on: [b]\n`, root)).toThrow(/depend_on/);
  });

  it("requires a matcher for output checks", () => {
    expect(() => parseConfig(`services:\n  a:\n    command: x\n    wait_for: { type: output }\n`, root)).toThrow(/contains" or "regex/);
  });

  it("rejects cycles and unknown dependencies at load time", () => {
    expect(() => parseConfig(`services:\n  a: { command: x, depends_on: [b] }\n  b: { command: y, depends_on: [a] }\n`, root)).toThrow(/cycle/);
    expect(() => parseConfig(`services:\n  a: { command: x, depends_on: [zzz] }\n`, root)).toThrow(/unknown service "zzz"/);
  });

  it("rejects invalid YAML and empty configs", () => {
    expect(() => parseConfig("services: [", root)).toThrow(/invalid YAML/);
    expect(() => parseConfig("services: {}", root)).toThrow(/no services/);
  });
});
