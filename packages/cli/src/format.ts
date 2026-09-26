import type { ServiceStatus } from "@devflow/core";

const enabled = !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
const wrap = (open: number, close: number) => (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

const PALETTE = [c.cyan, c.magenta, c.yellow, c.blue, c.green];
export const colorFor = (index: number) => PALETTE[index % PALETTE.length]!;

export const STATUS_STYLE: Record<ServiceStatus, { icon: string; paint: (s: string) => string }> = {
  pending: { icon: "○", paint: c.dim },
  starting: { icon: "◐", paint: c.yellow },
  running: { icon: "●", paint: c.green },
  completed: { icon: "✓", paint: c.green },
  failed: { icon: "✗", paint: c.red },
  crashed: { icon: "✗", paint: c.red },
  stopping: { icon: "◐", paint: c.yellow },
  stopped: { icon: "○", paint: c.dim },
};

export function statusLine(name: string, status: ServiceStatus, detail?: string, width = 0): string {
  const { icon, paint } = STATUS_STYLE[status];
  return `${paint(icon)} ${name.padEnd(width)}  ${paint(status)}${detail ? c.dim(`  ${detail}`) : ""}`;
}
