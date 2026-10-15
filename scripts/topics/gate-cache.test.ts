import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GateScoreCache, gateScoreFileName } from "./gate-cache.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gate-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const decider = "mlx-qwen3-reranker-0.6b:e61197ed:topic.gate.instruction-1";

describe("GateScoreCache", () => {
  it("keys scores by note hash, descriptor hash and decider, and survives a reload", async () => {
    const cache = await GateScoreCache.open(dir, decider);
    expect(cache.get("note-a", "topic-1")).toBeUndefined();
    cache.set({ noteHash: "note-a", descriptorHash: "topic-1", logOdds: 3.25 });
    cache.set({ noteHash: "note-a", descriptorHash: "topic-2", logOdds: -1.5, truncated: true });
    expect(cache.get("note-a", "topic-1")?.logOdds).toBe(3.25);
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1 });
    await cache.flush();

    const reloaded = await GateScoreCache.open(dir, decider);
    expect(reloaded.size).toBe(2);
    expect(reloaded.get("note-a", "topic-2")).toEqual({
      noteHash: "note-a",
      descriptorHash: "topic-2",
      logOdds: -1.5,
      truncated: true
    });
    expect(reloaded.has("note-b", "topic-1")).toBe(false);

    // Another decider has its own file and never sees these scores.
    const other = await GateScoreCache.open(dir, "gguf-qwen3-reranker-0.6b-q8-0:a02f48bb");
    expect(other.size).toBe(0);
    expect(other.path).not.toBe(reloaded.path);
  });

  it("lets the last line for a key win and ignores lines of another decider", async () => {
    const cache = await GateScoreCache.open(dir, decider);
    cache.set({ noteHash: "n", descriptorHash: "d", logOdds: 1 });
    cache.set({ noteHash: "n", descriptorHash: "d", logOdds: 2 });
    await cache.flush();
    await appendFile(
      cache.path,
      `${JSON.stringify({ decider: "someone-else", noteHash: "n", descriptorHash: "d", logOdds: 99 })}\n`
    );
    const reloaded = await GateScoreCache.open(dir, decider);
    expect(reloaded.get("n", "d")?.logOdds).toBe(2);
    expect(reloaded.stats.skippedLines).toBe(1);
  });

  it("skips a torn last line and starts the next append on a fresh line", async () => {
    const cache = await GateScoreCache.open(dir, decider);
    cache.set({ noteHash: "n1", descriptorHash: "d", logOdds: 1 });
    await cache.flush();
    await appendFile(cache.path, '{"decider":"x","noteHash":"n2","descr');
    const torn = await GateScoreCache.open(dir, decider);
    expect(torn.size).toBe(1);
    expect(torn.stats.skippedLines).toBe(1);
    torn.set({ noteHash: "n3", descriptorHash: "d", logOdds: 3 });
    await torn.flush();
    const text = await readFile(torn.path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const healed = await GateScoreCache.open(dir, decider);
    expect(healed.get("n1", "d")?.logOdds).toBe(1);
    expect(healed.get("n3", "d")?.logOdds).toBe(3);
    expect(healed.size).toBe(2);
  });

  it("computes a missing score once and serves it afterwards", async () => {
    const cache = await GateScoreCache.open(dir, decider);
    let calls = 0;
    const compute = () => {
      calls += 1;
      return { noteHash: "n", descriptorHash: "d", logOdds: 0.5 };
    };
    expect((await cache.getOrCompute("n", "d", compute)).logOdds).toBe(0.5);
    expect((await cache.getOrCompute("n", "d", compute)).logOdds).toBe(0.5);
    expect(calls).toBe(1);
    await cache.flush();
    await cache.flush(); // nothing pending: no second append
    expect((await readFile(cache.path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("rejects non-finite scores and unusable decider keys", async () => {
    const cache = await GateScoreCache.open(dir, decider);
    expect(() => cache.set({ noteHash: "n", descriptorHash: "d", logOdds: Number.NaN })).toThrow();
    expect(() => cache.set({ noteHash: "", descriptorHash: "d", logOdds: 1 })).toThrow();
    await expect(GateScoreCache.open(dir, "///")).rejects.toThrow(RangeError);
    expect(gateScoreFileName("a b/c:d")).toBe("a_b_c_d.jsonl");
  });
});
