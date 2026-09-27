# Setup guide

A walkthrough for going from nothing to a working multi-service setup. For the full field reference,
see the [README](README.md#config-conductorconfigyaml).

## 1. Install

- **VS Code / Cursor / VSCodium:** search **Conductor** in the Extensions view, or install from the
  [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=delaksan-sritharan.conductor-vscode).
- **Command line (optional):** `npm install -g @conductor/cli` gives you the `conductor` command outside VS Code
  (useful in CI, or if you don't use VS Code).

## 2. Create the config

Open the project you want to run, then either:

- Command Palette → **Conductor: Create Config**, or
- run `conductor init` in a terminal.

Either writes `.conductor/config.yaml` with a commented example. Commit this file — it's how the whole team
boots the project the same way.

## 3. Describe one service first

Start small. If you only have one thing to run:

```yaml
services:
  app:
    command: npm run dev
    wait_for:
      type: port
      value: 3000
```

Open the **Conductor** view in the activity bar and click **Start All**. You should see a terminal open with
your app's real output, and the sidebar flip from "starting" to "running" once port 3000 opens.

If it never turns "running", see [Troubleshooting](#troubleshooting) below.

## 4. Add more services, and control the order

This is the part that trips people up: **order is controlled entirely by `depends_on`.** The order services
are written in the file does not matter — only which service names which other service as a dependency.

```yaml
services:
  entity-service:
    path: ./entity-service
    command: npm run dev
    wait_for: { type: port, value: 8081 }

  backend:
    path: ./backend
    command: ./gradlew bootRun
    depends_on: [entity-service]        # <- won't start until entity-service is ready
    wait_for: { type: http, url: "http://localhost:8080/health" }

  frontend:
    path: ./frontend
    command: npm run dev
    depends_on: [backend]               # <- won't start until backend is ready
    wait_for: { type: output, contains: "Local:" }
```

A few things follow from that:

- **No `depends_on` between two services → they start in parallel.** There's no separate "run these in
  this order" setting; if you want A before B for any reason, give B `depends_on: [A]`, even if there's no
  real technical dependency. The default readiness check (`wait_for: none`, if you don't specify one) just
  waits about a second for the process to stay alive before moving on.
- **A service can depend on more than one thing:** `depends_on: [db, redis]` waits for both.
- **"Ready" isn't "started."** Conductor doesn't move on to the next service the instant a process spawns —
  it waits for whatever `wait_for` check you gave it. Pick the check that actually reflects the service
  being usable, not just running.

## 5. Picking a `wait_for`

| Use this when... | `wait_for` |
| --- | --- |
| The service listens on a TCP port | `{ type: port, value: 8081 }` |
| It exposes an HTTP health check | `{ type: http, url: "http://localhost:8080/health" }` |
| Neither, but it logs something recognisable when ready | `{ type: output, contains: "Server started" }` |
| It's a one-shot task (migration, seed) | `{ type: exit }` — ready when it exits 0 |
| None of the above apply | leave it out; ready ~1s after starting |

If your service takes longer than 120 seconds to become ready (a slow Gradle build, for instance), add
`timeout: 180` (seconds) to that service.

## 6. Day to day

- **Start All / Stop All / Restart All** — the sidebar's toolbar buttons, or Command Palette.
- **Start / Stop / Restart** a single service — right-click it in the sidebar, or use its inline icons.
  - Restarting one service leaves everything else running.
  - Stopping one service also stops whatever depends on it (so stopping `backend` also stops `frontend`).
- **Show Service Logs** — click a service in the sidebar to reopen its terminal (its history replays).
- **Doctor** — run before Start if something's not working: checks each service's directory exists, its
  command is on PATH, required tools (`requires:`) are installed, and its port isn't already taken.

## Troubleshooting

**"port already in use"** — something else is already listening there. Run **Doctor**; on macOS/Linux it
names the process holding the port so you can stop it.

**A service times out waiting to be ready** — either it's genuinely slow (raise `timeout`), or the
`wait_for` check doesn't match reality (wrong port, a health endpoint that doesn't exist yet, a `contains`
string that doesn't appear). Open its terminal and read the real output.

**A service fails immediately when started with the others, but works fine alone** — it's usually starting
before something it actually needs. Add the missing `depends_on`.

**Everything stopped when one service failed** — that's intentional. If any service fails to become ready,
Conductor stops everything it already started, so you're not left with a half-running, confusing state.

## Reference

Full field list, the CLI, and known limitations: see the [README](README.md).
