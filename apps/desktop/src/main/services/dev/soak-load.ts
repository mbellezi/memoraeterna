import { execFile } from "node:child_process";
import { loadavg } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";

import type { SoakSample } from "./soak-records.js";

/**
 * The load ledger of the 7-day soak (F4 T89, D2, D38): every minute, the machine's load average,
 * its memory pressure and the busiest processes that are not the soak's own. During the soak other
 * agents work on this Mac at background priority; when a stop check fires, the ledger tells an
 * agent's test run or a build (a process outside the soak using the CPU) from a defect of the product.
 * The soak's own processes (the app, its helpers, the database sidecar) are the descendants of the
 * app's process and are left out.
 */

export type LoadReading = NonNullable<SoakSample["load"]>;

export interface ProcessRow {
  pid: number;
  ppid: number;
  cpuPercent: number;
  rssKb: number;
  command: string;
}

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parseMemoryPressureLevel(text: string): LoadReading["memoryPressure"] {
  switch (Number(text.trim())) {
    case 1:
      return "normal";
    case 2:
      return "warn";
    case 4:
      return "critical";
    default:
      return null;
  }
}

/** `System-wide memory free percentage: 62%` from `memory_pressure -Q`. */
export function parseMemoryFreePercent(text: string): number | null {
  const value = /free percentage:\s*(\d+(?:\.\d+)?)%/u.exec(text)?.[1];
  return value === undefined ? null : Number(value);
}

/** `ps -A -o pid=,ppid=,pcpu=,rss=,comm=`: four numbers, then the command, which may hold spaces. */
export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPercent: Number(match[3]),
      rssKb: Number(match[4]),
      command: match[5]!
    });
  }
  return rows;
}

/** Every process descended from `rootPid` (the app and what it started), the root included. */
export function descendantsOf(rows: readonly ProcessRow[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const found = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? [])
      if (!found.has(child)) {
        found.add(child);
        queue.push(child);
      }
  }
  return found;
}

/** The busiest processes outside the soak's own, by CPU, above a floor that leaves quiet ones out. */
export function topForeignProcesses(
  rows: readonly ProcessRow[],
  ownPid: number,
  options: { limit?: number; minCpuPercent?: number } = {}
): LoadReading["top"] {
  const own = descendantsOf(rows, ownPid);
  return rows
    .filter((row) => !own.has(row.pid) && row.cpuPercent >= (options.minCpuPercent ?? 5))
    .toSorted((a, b) => b.cpuPercent - a.cpuPercent || a.pid - b.pid)
    .slice(0, options.limit ?? 5)
    .map((row) => ({
      command: basename(row.command).slice(0, 80),
      cpuPercent: Math.round(row.cpuPercent * 10) / 10,
      rssMb: Math.round((row.rssKb / 1024) * 10) / 10
    }));
}

type Exec = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;
const defaultExec: Exec = promisify(execFile) as unknown as Exec;

export interface LoadReaderOptions {
  ownPid?: number;
  exec?: Exec;
  loadAverage?: () => number[];
}

/** One reading of the load; a command that fails leaves its part null or empty. */
export async function readLoad(options: LoadReaderOptions = {}): Promise<LoadReading> {
  const exec = options.exec ?? defaultExec;
  const attempt = async (file: string, args: readonly string[]) => {
    try {
      return (await exec(file, args)).stdout;
    } catch {
      return "";
    }
  };
  const [table, level, free] = await Promise.all([
    attempt("/bin/ps", ["-A", "-o", "pid=,ppid=,pcpu=,rss=,comm="]),
    attempt("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    attempt("/usr/bin/memory_pressure", ["-Q"])
  ]);
  const average = (options.loadAverage ?? loadavg)();
  return {
    loadAverage: [average[0] ?? 0, average[1] ?? 0, average[2] ?? 0].map(
      (value) => Math.round(value * 100) / 100
    ) as [number, number, number],
    memoryPressure: parseMemoryPressureLevel(level),
    memoryFreePercent: parseMemoryFreePercent(free),
    top: topForeignProcesses(parseProcessTable(table), options.ownPid ?? process.pid)
  };
}
