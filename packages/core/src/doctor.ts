import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isPortOpen } from "./readiness.js";
import type { ProjectConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const SHELL_BUILTINS = new Set(["cd", "export", "source", ".", "echo", "exec", "set", "unset", "eval", "test", "[", "true", "false", "exit"]);

export interface DoctorResult {
  level: "ok" | "warn" | "error";
  service?: string;
  message: string;
  hint?: string;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** First real program in a shell command line, skipping `VAR=value` prefixes. */
export function programOf(command: string): string | undefined {
  for (const token of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return token.replace(/^["']|["']$/g, "");
  }
  return undefined;
}

async function describePortOwner(port: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"]);
    const pid = /^p(\d+)/m.exec(stdout)?.[1];
    const cmd = /^c(.+)$/m.exec(stdout)?.[1];
    return pid ? `${cmd ?? "process"} (PID ${pid})` : undefined;
  } catch {
    return undefined;
  }
}

/** Pre-flight checks: everything that commonly makes `start` fail for dull reasons. */
export async function runDoctor(project: ProjectConfig): Promise<DoctorResult[]> {
  const results: DoctorResult[] = [];
  const push = (r: DoctorResult) => results.push(r);

  for (const svc of project.services) {
    const service = svc.name;

    if (!fs.existsSync(svc.cwd) || !fs.statSync(svc.cwd).isDirectory()) {
      push({ level: "error", service, message: `directory not found: ${svc.cwd}`, hint: "check `path` in the config" });
      continue;
    }
    push({ level: "ok", service, message: `directory ${path.relative(project.root, svc.cwd) || "."}` });

    const program = programOf(svc.command);
    if (program && !SHELL_BUILTINS.has(program)) {
      const found = program.includes("/") || program.includes("\\") ? isExecutable(path.resolve(svc.cwd, program)) : !!findOnPath(program);
      push(
        found
          ? { level: "ok", service, message: `command "${program}" found` }
          : {
              level: "error",
              service,
              message: `command "${program}" not found`,
              hint: program.includes("/") ? `is it executable? try: chmod +x ${program}` : "install it or fix your PATH",
            },
      );
    }

    for (const tool of svc.requires) {
      push(
        findOnPath(tool)
          ? { level: "ok", service, message: `requires ${tool}` }
          : { level: "error", service, message: `required tool "${tool}" not found on PATH` },
      );
    }

    if (svc.waitFor.type === "port") {
      const { port, host } = svc.waitFor;
      if (await isPortOpen(port, host)) {
        const owner = await describePortOwner(port);
        push({
          level: "error",
          service,
          message: `port ${port} is already in use${owner ? ` by ${owner}` : ""}`,
          hint: "stop that process or change the port",
        });
      } else {
        push({ level: "ok", service, message: `port ${port} is free` });
      }
    }
  }

  return results;
}
