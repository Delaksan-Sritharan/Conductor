export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** A readiness check did not succeed (timeout, or the process died first). */
export class ReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessError";
  }
}

/** The operation was aborted because the user asked to stop. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

export class StartupError extends Error {
  constructor(
    readonly service: string,
    message: string,
  ) {
    super(`${service}: ${message}`);
    this.name = "StartupError";
  }
}
