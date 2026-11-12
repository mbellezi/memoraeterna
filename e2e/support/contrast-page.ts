// Runs the contrast scan's in-page code in a real page: a bare offscreen Electron (the screens tool's
// kind: temporary userData, no network, no Memora, no model) loads an HTML fixture and the page
// functions of `contrast.ts` run in it as Playwright sends them (their source, self-contained). The
// fixture tests use it to prove the scan on what Chromium really computes, not on hand-made samples.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The Electron binary, or null where it is not installed. */
export function electronBinary(): string | null {
  try {
    const binary: unknown = createRequire(import.meta.url)("electron");
    return typeof binary === "string" ? binary : null;
  } catch {
    return null;
  }
}

export interface PageStep {
  /** A JavaScript expression evaluated in the page; its value (a promise is awaited) is the result. */
  source: string;
  /** Wait this long before the step (a transition or an animation to let run). */
  waitMs?: number;
}

/** Loads `html`, evaluates each step in order, and returns their results. */
export async function runInPage(
  html: string,
  steps: readonly PageStep[],
  options: { timeoutMs?: number } = {}
): Promise<unknown[]> {
  const binary = electronBinary();
  if (binary === null) throw new Error("Electron is not installed");
  const folder = await mkdtemp(join(tmpdir(), "memora-contrast-plan-"));
  const planFile = join(folder, "plan.json");
  const out = join(folder, "out.json");
  try {
    await writeFile(planFile, JSON.stringify({ html, steps, out }));
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !name.startsWith("MEMORA_") && name !== "ELECTRON_RUN_AS_NODE"
      )
    );
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(binary, [join(here, "contrast-fixture.cjs"), planFile], {
        env: environment,
        stdio: ["ignore", "ignore", "ignore"]
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
      child.once("error", reject);
      child.once("exit", (status) => {
        clearTimeout(timer);
        resolve(status ?? 1);
      });
    });
    const answer = JSON.parse(await readFile(out, "utf8").catch(() => "{}")) as {
      results?: unknown[];
      error?: string;
    };
    if (answer.results === undefined)
      throw new Error(answer.error ?? `The fixture page did not answer (exit ${code})`);
    return answer.results;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** A step that runs a self-contained function in the page with JSON arguments, as Playwright does. */
export function call(fn: (...args: never[]) => unknown, ...args: unknown[]): PageStep {
  return { source: `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")})` };
}
