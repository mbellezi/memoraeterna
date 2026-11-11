import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const script = join(repository, "scripts", "quality-ratchet.mjs");

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ratchet-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  mkdirSync(join(workspace, "scripts"), { recursive: true });
  copyFileSync(script, join(workspace, "scripts", "quality-ratchet.mjs"));
});
afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function put(path: string, text: string): void {
  const full = join(workspace, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function record(values: Record<string, number>): void {
  put(
    "quality-ratchet.json",
    JSON.stringify({
      rawPaletteClasses: 0,
      arbitraryFontSizes: 0,
      windowDialogs: 0,
      rendererSetIntervals: 0,
      rendererPollLoops: 0,
      productLinesOver200: 0,
      ...values
    })
  );
}

function ratchet(): { status: number | null; out: string } {
  const result = spawnSync("node", [join(workspace, "scripts", "quality-ratchet.mjs")], {
    cwd: workspace,
    encoding: "utf8"
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const renderer = (file: string) => `apps/desktop/src/renderer/${file}`;

describe("rendererPollLoops counts the loops that wait and ask again", () => {
  it("fails on the boot loop that awaits a delay between reads", () => {
    record({});
    put(
      renderer("App.tsx"),
      `async function wait() {
  while (true) {
    const status = await window.app.database.getStatus();
    if (status.state === "ready") return status;
    await delay(300);
  }
}
`
    );
    const { status, out } = ratchet();
    expect(status).toBe(1);
    expect(out).toContain("FAIL      rendererPollLoops: 1 > recorded 0");
    expect(out).toContain(renderer("App.tsx"));
  });

  it("counts awaited sleep, wait and pause helpers and a Promise armed with a real delay", () => {
    record({});
    put(
      renderer("lib/poll.ts"),
      `export async function a() { await sleep(100); await wait(5); await pause(1); }
export async function b() {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
export async function c() { await new Promise((done) => window.setTimeout(done, 250)); }
`
    );
    expect(ratchet().out).toContain("FAIL      rendererPollLoops: 5 > recorded 0");
  });

  it("does not count a macrotask yield, a one-shot timer, or an await of a named wait", () => {
    record({});
    put(
      renderer("lib/ok.ts"),
      `export async function settle() { await new Promise<void>((done) => setTimeout(done, 0)); }
export function debounce(run: () => void) { return setTimeout(run, 250); }
export async function boot() { return await waitForDatabaseReady(window.app); }
export async function load() { await waitUntilShown(); }
`
    );
    const { status, out } = ratchet();
    expect(out).toContain("ok        rendererPollLoops: 0");
    expect(status).toBe(0);
  });

  it("looks at renderer sources only and leaves tests out", () => {
    record({});
    put("apps/desktop/src/main/services/poller.ts", "await delay(1000);\n");
    put(renderer("App.test.tsx"), "await delay(300);\n");
    put(renderer("lib/__fixtures__/slow.ts"), "await delay(300);\n");
    put(renderer("styles.css"), "/* await delay(300); */\n");
    const { status, out } = ratchet();
    expect(out).toContain("ok        rendererPollLoops: 0");
    expect(status).toBe(0);
  });

  it("measures both pollers: a setInterval is counted by the other metric", () => {
    record({});
    put(renderer("components/Card.tsx"), "useEffect(() => { setInterval(refresh, 3000); }, []);\n");
    const { status, out } = ratchet();
    expect(status).toBe(1);
    expect(out).toContain("FAIL      rendererSetIntervals: 1 > recorded 0");
    expect(out).toContain("ok        rendererPollLoops: 0");
  });

  it("records the new metric on --update when the file has no value for it", () => {
    put(
      "quality-ratchet.json",
      JSON.stringify({
        rawPaletteClasses: 0,
        arbitraryFontSizes: 0,
        windowDialogs: 0,
        rendererSetIntervals: 0,
        productLinesOver200: 0
      })
    );
    expect(ratchet().out).toContain("MISSING   rendererPollLoops");
    const updated = spawnSync(
      "node",
      [join(workspace, "scripts", "quality-ratchet.mjs"), "--update"],
      {
        cwd: workspace,
        encoding: "utf8"
      }
    );
    expect(updated.stdout).toContain("recorded  rendererPollLoops: 0");
  });
});

describe("the repository itself", () => {
  it("has no setInterval and no poll loop in the renderer", () => {
    const result = spawnSync("node", [script], { cwd: repository, encoding: "utf8" });
    const out = `${result.stdout}${result.stderr}`;
    expect(out).toContain("ok        rendererSetIntervals: 0");
    expect(out).toContain("ok        rendererPollLoops: 0");
  });
});
