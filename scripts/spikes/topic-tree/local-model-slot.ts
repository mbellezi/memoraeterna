// Local-model mutex for the spikes (owner decision 16): before running local
// inference, wait until no other agent's local-model job is running.
import { execFileSync } from "node:child_process";

// `scripts/relations/` scorers run GGUF in-process, so no `node-llama-cpp` shows on their command line.
export const localModelJob =
  /memora-mlx-helper|scripts\/spikes\/(reranker|topic-tree)\/.*(score|embed)|scripts\/relations\/.*(score|pairs|rematch)|node-llama-cpp/;

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

function processes(): ProcessRow[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3] ?? ""
    }));
}

/** Local-model jobs that are neither this process, its ancestors nor its descendants. */
export function otherLocalModelJobs(): string[] {
  const rows = processes();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const own = new Set<number>([process.pid]);
  for (let current = byPid.get(process.pid); current && !own.has(current.ppid);) {
    own.add(current.ppid);
    current = byPid.get(current.ppid);
  }
  const descendants = new Set<number>([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((row) => !own.has(row.pid) && !descendants.has(row.pid))
    .filter((row) => localModelJob.test(row.command) && !row.command.includes("grep"))
    .map((row) => `${row.pid} ${row.command.slice(0, 160)}`);
}

/** Waits (re-checking every `intervalMs`) until no other local-model job runs. */
export async function waitForLocalModelSlot(intervalMs = 60_000): Promise<void> {
  for (;;) {
    const others = otherLocalModelJobs();
    if (others.length === 0) return;
    console.log(`Waiting for other local-model jobs to finish:\n  ${others.join("\n  ")}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}
