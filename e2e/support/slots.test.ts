import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireJourneySlots, isOwnLock, memoraElectrons, type ProcessRow } from "./slots.js";

const electron = "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
const row = (pid: number, command: string): ProcessRow => ({ pid, ppid: 1, command });

describe("memoraElectrons", () => {
  it("counts Electron main processes that can start Memora and nothing else", () => {
    const rows = [
      row(10, `${electron} /repo/apps/desktop/out/main/index.js`),
      row(11, `${electron} .`),
      row(12, "/Applications/Memora Eterna.app/Contents/MacOS/Memora Eterna"),
      row(20, `${electron} /repo/scripts/screens/capture.cjs /tmp/plan.json`),
      row(21, `${electron} scripts/verify-graph-webgl.mjs`),
      row(
        22,
        "/repo/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/x --type=renderer"
      ),
      row(23, "/Applications/Claude.app/Contents/MacOS/Claude"),
      row(24, "node /repo/node_modules/.bin/electron-vite dev")
    ];
    expect(memoraElectrons(rows).map((line) => Number(line.split(" ")[0]))).toEqual([10, 11, 12]);
  });
});

describe("isOwnLock", () => {
  it("matches the owner and the run, whatever the pid", () => {
    expect(isOwnLock("journeys:r1 pid 5 run r1\n", "journeys:r1", "r1")).toBe(true);
    expect(isOwnLock("journeys:r1 run r1", "journeys:r1", "r1")).toBe(true);
    expect(isOwnLock("journeys:r2 pid 5 run r2", "journeys:r1", "r1")).toBe(false);
    expect(isOwnLock("soak:soak7 pid 9 run x", "journeys:r1", "r1")).toBe(false);
    expect(isOwnLock("f4-replay", "journeys:r1", "r1")).toBe(false);
  });
});

describe("acquireJourneySlots", () => {
  let dir: string;
  let lockPath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "journeys-slots-"));
    lockPath = join(dir, "f2", "LOCAL_MODEL_BUSY");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const options = (rows: ProcessRow[] = []) => ({
    lockPath,
    owner: "journeys:r1",
    run: "r1",
    pid: 42,
    processes: () => rows
  });

  it("creates the busy file with its task id and removes it on release", async () => {
    const release = await acquireJourneySlots(options());
    expect(await readFile(lockPath, "utf8")).toBe("journeys:r1 pid 42 run r1\n");
    await release();
    expect(existsSync(lockPath)).toBe(false);
    await release();
  });

  it("refuses while another task holds the busy file, and leaves it alone", async () => {
    await acquireJourneySlots({ ...options(), owner: "other", run: "x" });
    await expect(acquireJourneySlots(options())).rejects.toThrow(/held by another task/u);
    expect(await readFile(lockPath, "utf8")).toContain("other");
  });

  it("refuses while a Memora Electron runs, before touching the busy file", async () => {
    await expect(
      acquireJourneySlots(options([row(7, `${electron} /repo/apps/desktop/out/main/index.js`)]))
    ).rejects.toThrow(/Another Memora Electron/u);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes back its own busy file from a crashed attempt of the same run", async () => {
    await acquireJourneySlots({ ...options(), pid: 1 });
    const release = await acquireJourneySlots(options());
    expect(await readFile(lockPath, "utf8")).toBe("journeys:r1 pid 42 run r1\n");
    await release();
  });

  it("does not remove a busy file another task wrote after it", async () => {
    const release = await acquireJourneySlots(options());
    await writeFile(lockPath, "other pid 3 run y\n");
    await release();
    expect(existsSync(lockPath)).toBe(true);
  });
});
