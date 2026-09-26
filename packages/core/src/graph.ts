import { ConfigError } from "./errors.js";
import type { ServiceConfig } from "./types.js";

/**
 * Validated dependency graph. Construction throws ConfigError on unknown
 * dependencies, self-dependencies and cycles, so a graph you hold is always
 * a DAG.
 */
export class DependencyGraph {
  private readonly byName = new Map<string, ServiceConfig>();
  private readonly dependents = new Map<string, string[]>();
  private readonly topo: string[];

  constructor(readonly services: readonly ServiceConfig[]) {
    for (const svc of services) {
      if (this.byName.has(svc.name)) throw new ConfigError(`duplicate service name "${svc.name}"`);
      this.byName.set(svc.name, svc);
      this.dependents.set(svc.name, []);
    }
    for (const svc of services) {
      for (const dep of svc.dependsOn) {
        if (dep === svc.name) throw new ConfigError(`service "${svc.name}" cannot depend on itself`);
        if (!this.byName.has(dep)) {
          throw new ConfigError(`service "${svc.name}" depends on unknown service "${dep}"`);
        }
        this.dependents.get(dep)!.push(svc.name);
      }
    }
    this.topo = this.sort();
  }

  get(name: string): ServiceConfig {
    const svc = this.byName.get(name);
    if (!svc) throw new ConfigError(`unknown service "${name}"`);
    return svc;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return this.services.map((s) => s.name);
  }

  dependenciesOf(name: string): string[] {
    return this.get(name).dependsOn;
  }

  dependentsOf(name: string): string[] {
    this.get(name);
    return this.dependents.get(name)!;
  }

  /** Dependencies first. Stable: ties keep declaration order. */
  order(): string[] {
    return [...this.topo];
  }

  /** `names` plus everything they transitively depend on, in start order. */
  closure(names: readonly string[]): string[] {
    const wanted = new Set<string>();
    const visit = (n: string) => {
      if (wanted.has(n)) return;
      wanted.add(n);
      this.dependenciesOf(n).forEach(visit);
    };
    names.forEach(visit);
    return this.topo.filter((n) => wanted.has(n));
  }

  /** `names` plus everything that transitively depends on them, in start order. */
  dependentClosure(names: readonly string[]): string[] {
    const wanted = new Set<string>();
    const visit = (n: string) => {
      if (wanted.has(n)) return;
      wanted.add(n);
      this.dependentsOf(n).forEach(visit);
    };
    names.forEach(visit);
    return this.topo.filter((n) => wanted.has(n));
  }

  /** Groups of services that can start in parallel. */
  waves(): string[][] {
    const level = new Map<string, number>();
    for (const name of this.topo) {
      const deps = this.dependenciesOf(name);
      level.set(name, deps.length ? 1 + Math.max(...deps.map((d) => level.get(d)!)) : 0);
    }
    const waves: string[][] = [];
    for (const name of this.topo) (waves[level.get(name)!] ??= []).push(name);
    return waves;
  }

  private sort(): string[] {
    const out: string[] = [];
    const state = new Map<string, "visiting" | "done">();
    const stack: string[] = [];

    const visit = (name: string) => {
      const s = state.get(name);
      if (s === "done") return;
      if (s === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(name)), name];
        throw new ConfigError(`dependency cycle: ${cycle.join(" -> ")}`);
      }
      state.set(name, "visiting");
      stack.push(name);
      for (const dep of this.byName.get(name)!.dependsOn) visit(dep);
      stack.pop();
      state.set(name, "done");
      out.push(name);
    };

    for (const svc of this.services) visit(svc.name);
    return out;
  }
}
