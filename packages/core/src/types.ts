export type ReadyCheck =
  | { type: "none" }
  | { type: "exit" }
  | { type: "port"; port: number; host?: string }
  | { type: "http"; url: string; status?: number }
  | { type: "output"; contains?: string; regex?: string };

export interface ServiceConfig {
  name: string;
  /** Absolute working directory. */
  cwd: string;
  command: string;
  dependsOn: string[];
  waitFor: ReadyCheck;
  env: Record<string, string>;
  timeoutMs: number;
  /** Executables that must be on PATH (checked by `doctor`). */
  requires: string[];
}

export interface ProjectConfig {
  /** Directory that contains `.devflow/`. */
  root: string;
  configPath: string;
  services: ServiceConfig[];
}

export type ServiceStatus =
  | "pending"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "crashed"
  | "stopping"
  | "stopped";

export interface ServiceState {
  name: string;
  status: ServiceStatus;
  pid?: number;
  detail?: string;
}

export interface LogLine {
  stream: "stdout" | "stderr";
  line: string;
}
