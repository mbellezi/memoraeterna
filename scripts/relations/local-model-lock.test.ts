import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  acquireLocalModelLock,
  waitForModelsOutsideTheLock,
  withLocalModelLock
} from "./local-model-lock.ts";

describe("the local-model lock file", () => {
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-lock-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const exists = (path: string): Promise<boolean> =>
    stat(path).then(
      () => true,
      () => false
    );

  it("creates the file with the task id first and removes it on release, once", async () => {
    const path = join(directory, "nested", "BUSY");
    const release = await acquireLocalModelLock({ path, owner: "T46a" });
    expect(await readFile(path, "utf8")).toMatch(/^T46a pid \d+\n$/u);
    await release();
    expect(await exists(path)).toBe(false);
    await release();
  });

  it("waits while another holder has the file and takes it when it disappears", async () => {
    const path = join(directory, "BUSY-WAIT");
    const releaseFirst = await acquireLocalModelLock({ path, owner: "first" });
    const waits: string[] = [];
    let acquired = false;
    const second = acquireLocalModelLock({
      path,
      owner: "second",
      pollMs: 5,
      onWait: (waitingFor) => waits.push(waitingFor)
    }).then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((done) => setTimeout(done, 40));
    expect(acquired).toBe(false);
    expect(waits.length).toBeGreaterThan(0);
    expect(await readFile(path, "utf8")).toMatch(/^first pid/u);
    await releaseFirst();
    const releaseSecond = await second;
    expect(await readFile(path, "utf8")).toMatch(/^second pid/u);
    await releaseSecond();
    expect(await exists(path)).toBe(false);
  });

  it("waits for models outside the lock and ignores scorers that only wait for it", async () => {
    const lists = [
      ["11 tsx scripts/relations/score-pairs.ts score --runtime gguf", "12 memora-mlx-helper"],
      ["11 tsx scripts/relations/score-pairs.ts score --runtime gguf", "13 node-llama-cpp"],
      ["11 tsx scripts/relations/score-pairs.ts score --runtime gguf"]
    ];
    const waits: string[][] = [];
    let polls = 0;
    await waitForModelsOutsideTheLock(() => lists[polls++] ?? [], {
      pollMs: 1,
      onWait: (waitingFor) => waits.push(waitingFor)
    });
    expect(polls).toBe(3);
    expect(waits).toEqual([["12 memora-mlx-helper"], ["13 node-llama-cpp"]]);
    await expect(waitForModelsOutsideTheLock(() => [])).resolves.toBeUndefined();
  });

  it("removes the file when the work succeeds and when it fails", async () => {
    const path = join(directory, "BUSY-WORK");
    await expect(
      withLocalModelLock({ path, owner: "T46a" }, async () => {
        expect(await exists(path)).toBe(true);
        return 42;
      })
    ).resolves.toBe(42);
    expect(await exists(path)).toBe(false);
    await expect(
      withLocalModelLock({ path, owner: "T46a" }, async () => {
        throw new Error("scoring failed");
      })
    ).rejects.toThrow("scoring failed");
    expect(await exists(path)).toBe(false);
  });
});
