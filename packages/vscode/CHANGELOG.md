# Changelog

## 0.1.0

Initial release.

- Start services in dependency order; each waits until its dependencies are actually ready.
- Readiness checks: TCP port, HTTP health endpoint, log output (text or regex), clean exit, or process alive.
- Independent services start in parallel.
- Sidebar with live status, a terminal per service, start / stop / restart for all services or one.
- Stopping goes in reverse dependency order and kills the whole process tree.
- A failed start stops everything already started and reports why.
- `Conductor: Doctor` checks directories, commands, required tools and busy ports.
- JSON schema for `.conductor/config.yaml` (autocomplete and validation with the Red Hat YAML extension).
