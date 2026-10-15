import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createRng, createMatrix, normalizeRows } from "@app/domain/topic-tree";

import {
  ReplayStoreError,
  parseReplayRows,
  readReplayStore,
  replayStorePaths,
  sha256Hex,
  tryReadReplayStore,
  writeReplayStore
} from "./export-vectors.js";
import type { ReplayMeta, WritableReplayRow } from "./export-vectors.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "replay-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function sample(count = 5, dim = 8) {
  const rng = createRng(3);
  const matrix = createMatrix(count, dim);
  for (let i = 0; i < matrix.data.length; i += 1) matrix.data[i] = rng.gaussian();
  normalizeRows(matrix);
  const rows: WritableReplayRow[] = Array.from({ length: count }, (_, row) => ({
    id: `note-${row}`,
    contentHash: sha256Hex(`note-${row}`),
    lang: row % 2 === 0 ? "pt" : "en",
    domain: row < 3 ? "a" : "b",
    group: `doc-${row}`,
    title: `Title ${row}`,
    text: `Text ${row}`,
    order: row
  }));
  const meta: ReplayMeta = {
    dataset: "sample",
    count,
    dim,
    model: { name: "test-model", revision: "r1" },
    runtime: "gguf",
    input: "note",
    createdAt: "2026-10-15T00:00:00.000Z",
    spaceKey: "space-1"
  };
  return { meta, rows, matrix };
}

describe("replay store", () => {
  it("round-trips vectors, rows and meta", async () => {
    const store = sample();
    await writeReplayStore(dir, "sample", store);
    const read = await readReplayStore(dir, "sample");
    expect(read.meta).toEqual(store.meta);
    expect(read.matrix.count).toBe(5);
    expect(Array.from(read.matrix.data)).toEqual(Array.from(store.matrix.data));
    expect(read.rows.map((row) => row.id)).toEqual(store.rows.map((row) => row.id));
    expect(read.rows[0]).toMatchObject({
      kind: "note",
      lang: "pt",
      domain: "a",
      rootSourceId: "doc-0",
      contentHash: sha256Hex("note-0")
    });
    // Atomic writes leave no temporary files behind.
    expect((await readdir(dir)).sort()).toEqual([
      "sample.f32",
      "sample.index.jsonl",
      "sample.meta.json"
    ]);
  });

  it("returns null for a missing store and rejects a half-written one", async () => {
    expect(await tryReadReplayStore(dir, "nothing")).toBeNull();
    await expect(readReplayStore(dir, "nothing")).rejects.toMatchObject({ code: "missing" });
    await writeReplayStore(dir, "sample", sample());
    await writeFile(
      replayStorePaths(dir, "other").meta,
      await readFile(replayStorePaths(dir, "sample").meta, "utf8")
    );
    await expect(readReplayStore(dir, "other")).rejects.toMatchObject({ code: "missing" });
  });

  it("rejects truncated vectors, a wrong row count and non-unit rows", async () => {
    await writeReplayStore(dir, "sample", sample());
    await truncate(replayStorePaths(dir, "sample").vectors, 100);
    await expect(readReplayStore(dir, "sample")).rejects.toThrow(/bytes of vectors/u);

    await writeReplayStore(dir, "sample", sample());
    await writeFile(
      replayStorePaths(dir, "sample").index,
      '{"id":"x","lang":"en","group":"g","title":"t","order":0}\n'
    );
    await expect(readReplayStore(dir, "sample")).rejects.toThrow(/1 index rows, meta says 5/u);

    const unscaled = sample();
    for (let i = 0; i < unscaled.matrix.data.length; i += 1) {
      unscaled.matrix.data[i] = (unscaled.matrix.data[i] as number) * 2;
    }
    await expect(writeReplayStore(dir, "bad", unscaled)).rejects.toThrow(/non-unit/u);
  });

  it("renormalizes on request and rejects non-finite values", async () => {
    await writeReplayStore(dir, "sample", sample());
    const bytes = new Uint8Array(await readFile(replayStorePaths(dir, "sample").vectors));
    const floats = new Float32Array(bytes.buffer);
    for (let i = 0; i < 8; i += 1) floats[i] = (floats[i] as number) * 3;
    await writeFile(replayStorePaths(dir, "sample").vectors, new Uint8Array(floats.buffer));
    await expect(readReplayStore(dir, "sample")).rejects.toThrow(/not unit length/u);
    const fixed = await readReplayStore(dir, "sample", { normalize: true });
    expect(fixed.matrix.data.subarray(0, 8).reduce((sum, v) => sum + v * v, 0)).toBeCloseTo(1, 5);

    floats[0] = Number.NaN;
    await writeFile(replayStorePaths(dir, "sample").vectors, new Uint8Array(floats.buffer));
    await expect(readReplayStore(dir, "sample", { normalize: true })).rejects.toThrow(
      /non-finite/u
    );
  });

  it("reads Spike B rows (inputSha256 stands in for the content hash)", () => {
    const rows = parseReplayRows(
      [
        JSON.stringify({
          id: "wp-en-1",
          dataset: "corpus",
          lang: "en",
          domain: "biology",
          group: "en:Photosynthesis",
          title: "Photosynthesis",
          text: "Plants.",
          createdAt: null,
          order: 0,
          inputSha256: "ab".repeat(32),
          tokens: 12,
          truncated: false
        }),
        ""
      ].join("\n")
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      contentHash: "ab".repeat(32),
      domain: "biology",
      rootSourceId: "en:Photosynthesis"
    });
  });

  it("names the line of an invalid row", () => {
    expect(() => parseReplayRows('{"id":"a"}\n')).toThrow(ReplayStoreError);
    expect(() => parseReplayRows("not json\n", "x")).toThrow(/x: line 1 is not JSON/u);
  });
});
