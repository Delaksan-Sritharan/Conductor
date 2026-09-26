import * as path from "node:path";
import * as vscode from "vscode";
import { describeCheck, type ProjectConfig, type ServiceState, type ServiceStatus } from "@devflow/core";

const ICONS: Record<ServiceStatus, vscode.ThemeIcon> = {
  pending: new vscode.ThemeIcon("clock", new vscode.ThemeColor("disabledForeground")),
  starting: new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.yellow")),
  running: new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed")),
  completed: new vscode.ThemeIcon("check", new vscode.ThemeColor("testing.iconPassed")),
  failed: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  crashed: new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed")),
  stopping: new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.yellow")),
  stopped: new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("disabledForeground")),
};

export const ACTIVE: ServiceStatus[] = ["pending", "starting", "running", "stopping"];

export class ServiceItem extends vscode.TreeItem {
  constructor(
    readonly serviceName: string,
    state: ServiceState,
    project: ProjectConfig,
  ) {
    super(serviceName, vscode.TreeItemCollapsibleState.None);
    const svc = project.services.find((s) => s.name === serviceName)!;

    const port = svc.waitFor.type === "port" ? `:${svc.waitFor.port}` : undefined;
    const showDetail = (state.status === "failed" || state.status === "crashed") && state.detail;
    this.description = [showDetail ? `${state.status} · ${state.detail}` : state.status, port].filter(Boolean).join(" · ");
    this.iconPath = ICONS[state.status];
    this.contextValue = ACTIVE.includes(state.status) ? "service.active" : "service.inactive";
    this.command = { command: "devflow.showLogs", title: "Show Logs", arguments: [serviceName] };

    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**${serviceName}** — ${state.status}\n\n`);
    tip.appendMarkdown(`Path: \`${path.relative(project.root, svc.cwd) || "."}\`\n\n`);
    tip.appendCodeblock(svc.command, "sh");
    tip.appendMarkdown(`\nReady when: ${describeCheck(svc.waitFor)}\n\n`);
    tip.appendMarkdown(`Depends on: ${svc.dependsOn.length ? svc.dependsOn.join(", ") : "nothing"}`);
    if (state.pid !== undefined) tip.appendMarkdown(`\n\nPID ${state.pid}`);
    if (state.detail) tip.appendMarkdown(`\n\n${state.detail}`);
    this.tooltip = tip;
  }
}

class MessageItem extends vscode.TreeItem {
  constructor(message: string, tooltip: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
    this.tooltip = tooltip;
    this.command = { command: "devflow.openConfig", title: "Open Config" };
  }
}

type Node = ServiceItem | MessageItem;

export class ServiceTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly getProject: () => ProjectConfig | undefined,
    private readonly getStates: () => ServiceState[],
    private readonly getError: () => string | undefined,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  getChildren(): Node[] {
    const error = this.getError();
    if (error) return [new MessageItem("Config error - click to open", error)];
    const project = this.getProject();
    if (!project) return [];
    return this.getStates().map((s) => new ServiceItem(s.name, s, project));
  }
}
