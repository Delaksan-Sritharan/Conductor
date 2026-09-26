import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import { ConfigError } from "./errors.js";
import { DependencyGraph } from "./graph.js";
import type { ProjectConfig, ReadyCheck, ServiceConfig } from "./types.js";

export const CONFIG_DIR = ".devflow";
export const CONFIG_FILES = ["config.yaml", "config.yml"];
const DEFAULT_TIMEOUT_SECONDS = 120;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const waitForSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("exit") }),
  z.strictObject({
    type: z.literal("port"),
    value: z.coerce.number().int().min(1).max(65535),
    host: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("http"),
    url: z.url(),
    status: z.number().int().min(100).max(599).optional(),
  }),
  z.strictObject({
    type: z.literal("output"),
    contains: z.string().min(1).optional(),
    regex: z.string().min(1).optional(),
  }),
]);

const stringList = z.union([z.string(), z.array(z.string())]).transform((v) => (Array.isArray(v) ? v : [v]));

const serviceSchema = z.strictObject({
  name: z.string().optional(),
  path: z.string().default("."),
  command: z.string().min(1, "command must not be empty"),
  depends_on: stringList.default([]),
  wait_for: waitForSchema.default({ type: "none" }),
  env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  timeout: z.number().positive().default(DEFAULT_TIMEOUT_SECONDS),
  requires: stringList.default([]),
});

const fileSchema = z.strictObject({
  version: z.number().optional(),
  services: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
});

function formatIssues(prefix: string, error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const where = [prefix, ...i.path.map(String)].filter(Boolean).join(".");
      return `${where}: ${i.message}`;
    })
    .join("\n  ");
}

function toReadyCheck(w: z.infer<typeof waitForSchema>): ReadyCheck {
  switch (w.type) {
    case "port":
      return { type: "port", port: w.value, ...(w.host ? { host: w.host } : {}) };
    case "http":
      return { type: "http", url: w.url, ...(w.status ? { status: w.status } : {}) };
    case "output":
      return { type: "output", contains: w.contains, regex: w.regex };
    default:
      return { type: w.type };
  }
}

/** Parse config YAML text. `root` is the directory service paths are relative to. */
export function parseConfig(text: string, root: string, configPath = path.join(root, CONFIG_DIR, "config.yaml")): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    const msg = e instanceof YAMLParseError ? e.message : String(e);
    throw new ConfigError(`invalid YAML in ${configPath}:\n  ${msg}`);
  }

  const file = fileSchema.safeParse(raw ?? {});
  if (!file.success) throw new ConfigError(`invalid config ${configPath}:\n  ${formatIssues("", file.error)}`);

  // Normalise the map form and the list form into [name, rawService] pairs.
  const entries: [string | undefined, unknown][] = Array.isArray(file.data.services)
    ? file.data.services.map((s) => [(s as { name?: string } | null)?.name, s])
    : Object.entries(file.data.services);

  const services: ServiceConfig[] = [];
  const errors: string[] = [];

  entries.forEach(([key, value], index) => {
    const label = key ?? `services[${index}]`;
    if (!key) {
      errors.push(`${label}: every service in list form needs a "name"`);
      return;
    }
    if (!NAME_RE.test(key)) {
      errors.push(`${label}: name may only contain letters, digits, ".", "_" and "-"`);
      return;
    }
    const parsed = serviceSchema.safeParse(value ?? {});
    if (!parsed.success) {
      errors.push(formatIssues(`services.${key}`, parsed.error));
      return;
    }
    const s = parsed.data;
    if (s.wait_for.type === "output" && !s.wait_for.contains && !s.wait_for.regex) {
      errors.push(`services.${key}.wait_for: output check needs "contains" or "regex"`);
      return;
    }
    if (s.wait_for.type === "output" && s.wait_for.regex) {
      try {
        new RegExp(s.wait_for.regex);
      } catch {
        errors.push(`services.${key}.wait_for.regex: not a valid regular expression`);
        return;
      }
    }
    services.push({
      name: key,
      cwd: path.resolve(root, s.path),
      command: s.command,
      dependsOn: s.depends_on,
      waitFor: toReadyCheck(s.wait_for),
      env: Object.fromEntries(Object.entries(s.env).map(([k, v]) => [k, String(v)])),
      timeoutMs: Math.round(s.timeout * 1000),
      requires: s.requires,
    });
  });

  if (errors.length) throw new ConfigError(`invalid config ${configPath}:\n  ${errors.join("\n  ")}`);
  if (services.length === 0) throw new ConfigError(`${configPath} defines no services`);

  new DependencyGraph(services); // fail early on unknown deps and cycles
  return { root, configPath, services };
}

export function loadConfig(configPath: string): ProjectConfig {
  const abs = path.resolve(configPath);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch {
    throw new ConfigError(`cannot read ${abs}`);
  }
  return parseConfig(text, path.dirname(path.dirname(abs)), abs);
}

/** Walk up from `startDir` looking for `.devflow/config.yaml`. */
export function findConfigFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const file of CONFIG_FILES) {
      const candidate = path.join(dir, CONFIG_DIR, file);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export const CONFIG_TEMPLATE = `# DevFlow: start your services in dependency order, each one only after
# the services it depends on are actually ready.
#
# wait_for options:
#   { type: port, value: 8081 }                       TCP port accepts connections
#   { type: http, url: http://localhost:8080/health } URL answers 2xx/3xx
#   { type: output, contains: "Server started" }      text appears in the logs
#   { type: exit }                                    process exits with code 0 (migrations, seeds)
#   { type: none }                                    process stays alive for ~1s (default)

services:
  entity-service:
    path: ./entity-service
    command: npm run dev
    wait_for:
      type: port
      value: 8081

  backend:
    path: ./backend
    command: ./gradlew bootRun
    depends_on: [entity-service]
    timeout: 180
    wait_for:
      type: http
      url: http://localhost:8080/health

  frontend:
    path: ./frontend
    command: npm run dev
    depends_on: [backend]
    wait_for:
      type: output
      contains: "Local:"
`;
