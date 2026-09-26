import * as vscode from "vscode";

const HISTORY_LIMIT = 10_000;

/** A terminal that only displays output; the engine owns the real process. */
class LogPty implements vscode.Pseudoterminal {
  private readonly emitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.emitter.event;
  private open_ = false;

  constructor(private readonly history: () => readonly string[]) {}

  open(): void {
    this.open_ = true;
    const replay = this.history().join("");
    if (replay) this.emitter.fire(replay);
  }

  close(): void {
    this.open_ = false;
  }

  write(text: string): void {
    if (this.open_) this.emitter.fire(text);
  }
}

/**
 * One terminal per service. Output is buffered here, so a terminal the user
 * closed can be reopened later with its history replayed.
 */
export class ServiceTerminals implements vscode.Disposable {
  private readonly history = new Map<string, string[]>();
  private readonly live = new Map<string, { pty: LogPty; terminal: vscode.Terminal }>();
  private readonly closeListener: vscode.Disposable;

  constructor() {
    this.closeListener = vscode.window.onDidCloseTerminal((closed) => {
      for (const [name, entry] of this.live) if (entry.terminal === closed) this.live.delete(name);
    });
  }

  private buffer(name: string): string[] {
    let buf = this.history.get(name);
    if (!buf) this.history.set(name, (buf = []));
    return buf;
  }

  private push(name: string, text: string): void {
    const buf = this.buffer(name);
    buf.push(text);
    if (buf.length > HISTORY_LIMIT) buf.splice(0, buf.length - HISTORY_LIMIT);
    this.live.get(name)?.pty.write(text);
  }

  ensure(name: string): vscode.Terminal {
    const existing = this.live.get(name);
    if (existing) return existing.terminal;
    const pty = new LogPty(() => this.buffer(name));
    const terminal = vscode.window.createTerminal({ name: `DevFlow: ${name}`, pty, iconPath: new vscode.ThemeIcon("server-process") });
    this.live.set(name, { pty, terminal });
    return terminal;
  }

  show(name: string, preserveFocus = false): void {
    this.ensure(name).show(preserveFocus);
  }

  line(name: string, text: string): void {
    this.push(name, `${text}\r\n`);
  }

  /** A dim `[devflow]` marker line, used for lifecycle events. */
  note(name: string, text: string): void {
    this.line(name, `\u001b[2m[devflow] ${text}\u001b[0m`);
  }

  clear(name: string): void {
    this.history.set(name, []);
  }

  dispose(): void {
    this.closeListener.dispose();
    for (const { terminal } of this.live.values()) terminal.dispose();
    this.live.clear();
  }
}
