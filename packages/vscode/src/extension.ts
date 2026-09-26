import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  CONFIG_DIR,
  CONFIG_TEMPLATE,
  Engine,
  findConfigFile,
  loadConfig,
  runDoctor,
  type ProjectConfig,
  type ServiceStatus,
} from "@devflow/core";
import { ACTIVE, ServiceItem, ServiceTreeProvider } from "./serviceTree.js";
import { ServiceTerminals } from "./terminals.js";

const STOP_ON_DEACTIVATE_MS = 4000;

let engine: Engine | undefined;
let project: ProjectConfig | undefined;
let configError: string | undefined;
let pendingReload = false;
let unsubscribe: (() => void)[] = [];

export function activate(context: vscode.ExtensionContext): void {
  const terminals = new ServiceTerminals();
  const output = vscode.window.createOutputChannel("DevFlow");
  const tree = new ServiceTreeProvider(
    () => project,
    () => engine?.getStates() ?? [],
    () => configError,
  );
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  context.subscriptions.push(terminals, output, statusBar, vscode.window.registerTreeDataProvider("devflow.services", tree));

  const setContext = (key: string, value: boolean) => vscode.commands.executeCommand("setContext", `devflow.${key}`, value);

  const isActive = () => !!engine && engine.getStates().some((s) => ACTIVE.includes(s.status));

  function updateChrome(): void {
    tree.refresh();
    void setContext("active", isActive());
    if (!engine) {
      statusBar.hide();
      return;
    }
    const states = engine.getStates();
    const running = states.filter((s) => s.status === "running" || s.status === "completed").length;
    const bad = states.some((s) => s.status === "failed" || s.status === "crashed");
    statusBar.text = `${bad ? "$(error)" : "$(server-process)"} DevFlow ${running}/${states.length}`;
    statusBar.tooltip = isActive() ? "DevFlow: click to stop all services" : "DevFlow: click to start all services";
    statusBar.command = isActive() ? "devflow.stopAll" : "devflow.startAll";
    statusBar.backgroundColor = bad ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
    statusBar.show();
  }

  const NOTE: Partial<Record<ServiceStatus, string>> = {
    starting: "starting…",
    running: "● ready",
    completed: "✓ completed",
    stopped: "○ stopped",
  };

  function load(): void {
    unsubscribe.forEach((off) => off());
    unsubscribe = [];
    engine = project = configError = undefined;
    pendingReload = false;

    const folder = vscode.workspace.workspaceFolders?.[0];
    const file = folder && findConfigFile(folder.uri.fsPath);
    void setContext("hasConfig", !!file);
    if (file) {
      try {
        project = loadConfig(file);
        engine = new Engine(project);
        unsubscribe.push(
          engine.on("log", ({ service, line }) => terminals.line(service, line)),
          engine.on("status", (s) => {
            const note = s.status === "failed" || s.status === "crashed" ? `✗ ${s.status}${s.detail ? `: ${s.detail}` : ""}` : NOTE[s.status];
            if (note) terminals.note(s.name, note);
            updateChrome();
          }),
        );
      } catch (e) {
        configError = e instanceof Error ? e.message : String(e);
        output.appendLine(configError);
      }
    }
    updateChrome();
  }

  async function guarded(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === "CancelledError") return;
      output.appendLine(`${what} failed: ${message}`);
      const choice = await vscode.window.showErrorMessage(`DevFlow: ${message}`, "Show Output");
      if (choice) output.show();
    }
  }

  function requireEngine(): Engine | undefined {
    if (!engine) {
      void vscode.window
        .showWarningMessage(configError ? "DevFlow config has errors." : "No DevFlow config in this workspace.", configError ? "Open Config" : "Create Config")
        .then((c) => c && vscode.commands.executeCommand(configError ? "devflow.openConfig" : "devflow.init"));
    }
    return engine;
  }

  async function pickService(arg: unknown, placeHolder: string): Promise<string | undefined> {
    if (typeof arg === "string") return arg;
    if (arg instanceof ServiceItem) return arg.serviceName;
    const eng = requireEngine();
    if (!eng) return undefined;
    return vscode.window.showQuickPick(eng.graph.names(), { placeHolder });
  }

  /** Create terminals up front so every service has a tab; reveal the first without stealing focus. */
  function prepareTerminals(names: string[], fresh: boolean): void {
    names.forEach((n, i) => {
      if (fresh) terminals.clear(n);
      terminals.ensure(n);
      if (i === 0) terminals.show(n, true);
    });
  }

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg("devflow.startAll", () =>
    guarded("start", async () => {
      const eng = requireEngine();
      if (!eng) return;
      prepareTerminals(eng.graph.order(), true);
      await eng.start();
    }),
  );

  reg("devflow.stopAll", () =>
    guarded("stop", async () => {
      await engine?.stop();
      if (pendingReload) load();
    }),
  );

  reg("devflow.restartAll", () =>
    guarded("restart", async () => {
      await engine?.stop();
      if (pendingReload) load();
      const eng = requireEngine();
      if (!eng) return;
      prepareTerminals(eng.graph.order(), true);
      await eng.start();
    }),
  );

  reg("devflow.startService", (arg?: unknown) =>
    guarded("start service", async () => {
      const name = await pickService(arg, "Start which service?");
      if (!name || !engine) return;
      prepareTerminals(engine.graph.closure([name]), false);
      terminals.show(name, true);
      await engine.start([name]);
    }),
  );

  reg("devflow.stopService", (arg?: unknown) =>
    guarded("stop service", async () => {
      const name = await pickService(arg, "Stop which service?");
      if (name) await engine?.stop([name]);
    }),
  );

  reg("devflow.restartService", (arg?: unknown) =>
    guarded("restart service", async () => {
      const name = await pickService(arg, "Restart which service?");
      if (!name || !engine) return;
      terminals.show(name, true);
      await engine.restart(name);
    }),
  );

  reg("devflow.showLogs", async (arg?: unknown) => {
    const name = await pickService(arg, "Show logs for which service?");
    if (name) terminals.show(name);
  });

  reg("devflow.doctor", () =>
    guarded("doctor", async () => {
      if (!project) return void requireEngine();
      const results = await runDoctor(project);
      output.clear();
      let last: string | undefined;
      for (const r of results) {
        if (r.service !== last) output.appendLine(`\n${r.service ?? "project"}`);
        last = r.service;
        output.appendLine(`  ${r.level === "ok" ? "✓" : r.level === "warn" ? "!" : "✗"} ${r.message}${r.hint ? `  → ${r.hint}` : ""}`);
      }
      const errors = results.filter((r) => r.level === "error").length;
      output.show(true);
      if (errors) void vscode.window.showWarningMessage(`DevFlow doctor found ${errors} problem${errors === 1 ? "" : "s"}.`, "Show Output").then((c) => c && output.show());
      else void vscode.window.showInformationMessage("DevFlow doctor: everything looks good.");
    }),
  );

  reg("devflow.openConfig", async () => {
    const file = project?.configPath ?? (vscode.workspace.workspaceFolders?.[0] && findConfigFile(vscode.workspace.workspaceFolders[0].uri.fsPath));
    if (!file) return void vscode.commands.executeCommand("devflow.init");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  });

  reg("devflow.init", async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return void vscode.window.showWarningMessage("Open a folder first.");
    const dir = path.join(folder.uri.fsPath, CONFIG_DIR);
    const file = path.join(dir, "config.yaml");
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, CONFIG_TEMPLATE);
      fs.writeFileSync(path.join(dir, ".gitignore"), "state.json\n");
    }
    load();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
  });

  reg("devflow.refresh", () => {
    if (isActive()) {
      pendingReload = true;
      void vscode.window.showInformationMessage("DevFlow: services are running. The config will reload when they stop.");
    } else load();
  });

  const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_DIR}/config.{yaml,yml}`);
  const onConfigChange = () => (isActive() ? ((pendingReload = true), void vscode.window.showInformationMessage("DevFlow config changed. Restart services to apply it.")) : load());
  watcher.onDidChange(onConfigChange);
  watcher.onDidCreate(onConfigChange);
  watcher.onDidDelete(onConfigChange);
  context.subscriptions.push(watcher, vscode.workspace.onDidChangeWorkspaceFolders(() => load()));

  load();
}

/** Services run in their own process groups, so the extension host exiting would orphan them. */
export async function deactivate(): Promise<void> {
  const current = engine;
  if (!current) return;
  await Promise.race([current.stop().catch(() => {}), new Promise((r) => setTimeout(r, STOP_ON_DEACTIVATE_MS))]);
  current.kill();
}
