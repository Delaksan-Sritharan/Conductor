import { describe, expect, it } from "vitest";
import { ConfigError, DependencyGraph } from "../src/index.js";
import { svc } from "./helpers.js";

const s = (name: string, dependsOn: string[] = []) => svc(name, { command: "true", dependsOn });

describe("DependencyGraph", () => {
  it("orders dependencies first and keeps declaration order for ties", () => {
    const g = new DependencyGraph([s("frontend", ["backend"]), s("backend", ["db", "entity"]), s("db"), s("entity")]);
    expect(g.order()).toEqual(["db", "entity", "backend", "frontend"]);
  });

  it("groups services into parallel waves", () => {
    const g = new DependencyGraph([s("db"), s("redis"), s("backend", ["db", "redis"]), s("frontend", ["backend"])]);
    expect(g.waves()).toEqual([["db", "redis"], ["backend"], ["frontend"]]);
  });

  it("computes dependency and dependent closures", () => {
    const g = new DependencyGraph([s("a"), s("b", ["a"]), s("c", ["b"]), s("d")]);
    expect(g.closure(["c"])).toEqual(["a", "b", "c"]);
    expect(g.dependentClosure(["b"])).toEqual(["b", "c"]);
  });

  it("rejects cycles and reports the path", () => {
    expect(() => new DependencyGraph([s("a", ["c"]), s("b", ["a"]), s("c", ["b"])])).toThrow(/cycle: a -> c -> b -> a/);
  });

  it("rejects unknown and self dependencies", () => {
    expect(() => new DependencyGraph([s("a", ["nope"])])).toThrow(/unknown service "nope"/);
    expect(() => new DependencyGraph([s("a", ["a"])])).toThrow(ConfigError);
  });
});
