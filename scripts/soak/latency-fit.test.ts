import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { latencyFitSchema } from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import { quantileLatency } from "../../apps/desktop/src/main/services/dev/fake-remote-core.ts";
import {
  codexDurations,
  fitDurations,
  quantile,
  quantilePoints,
  readCassetteDurations,
  runLatencyFit
} from "./latency-fit.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const entry = (taskType: string, responses: Array<Record<string, unknown>>) => ({
  format: "memora-ai-cassette-entry",
  taskType,
  responses
});
const codex = (durationMs: number) => ({
  providerId: "openai-codex",
  runtime: "remote",
  durationMs
});

describe("the latency fit", () => {
  it("interpolates quantiles of sorted values", () => {
    expect(quantile([10, 20, 30, 40, 50], 0)).toBe(10);
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(quantile([10, 20, 30, 40, 50], 0.875)).toBe(45);
    expect(quantile([10, 20, 30, 40, 50], 1)).toBe(50);
    expect(quantilePoints).toHaveLength(21);
  });

  it("keeps only the Codex responses of an entry, with a duration", () => {
    expect(
      codexDurations(
        entry("summarization", [
          codex(2_000),
          { providerId: "local-mlx", runtime: "local", durationMs: 9_000 },
          { providerId: "openai-codex", runtime: "remote", durationMs: 0 },
          codex(3_000.4)
        ])
      )
    ).toEqual([
      { task: "summarization", durationMs: 2_000 },
      { task: "summarization", durationMs: 3_000 }
    ]);
    expect(codexDurations(null)).toEqual([]);
    expect(codexDurations({ taskType: 3 })).toEqual([]);
  });

  it("fits each task at 21 quantiles, in the shape the fakes read", () => {
    const fit = fitDurations(
      [
        ...Array.from({ length: 100 }, (_, index) => ({
          task: "summarization",
          durationMs: 1_000 + index * 100
        })),
        { task: "reranking", durationMs: 5_000 }
      ],
      [".cache/golden/cassettes/x"],
      new Date("2026-10-18T10:00:00Z")
    );
    expect(latencyFitSchema.parse(fit)).toEqual(fit);
    expect(Object.keys(fit.tasks)).toEqual(["reranking", "summarization"]);
    const task = fit.tasks.summarization!;
    expect(task).toMatchObject({ count: 100, p50: 5_950, p90: 9_910 });
    expect(task.quantilesMs).toHaveLength(21);
    expect(task.quantilesMs[0]).toBe(1_000);
    expect(task.quantilesMs[20]).toBe(10_900);
    // The fake draws from the fit: the median draw is the fit's median.
    expect(quantileLatency(task.quantilesMs).sample(0.5)).toBeCloseTo(task.p50, -2);
  });

  it("reads cassette directories and writes the fit file", async () => {
    const root = await mkdtemp(join(tmpdir(), "latency-fit-"));
    directories.push(root);
    const cassette = join(root, "cassette");
    await mkdir(join(cassette, "entries", "ab"), { recursive: true });
    await writeFile(join(cassette, "cassette.json"), "{}");
    await writeFile(
      join(cassette, "entries", "ab", "one.json"),
      JSON.stringify(entry("summarization", [codex(1_000), codex(2_000)]))
    );
    await writeFile(
      join(cassette, "entries", "ab", "two.json"),
      JSON.stringify(entry("reranking", [codex(4_000)]))
    );
    expect(await readCassetteDurations(cassette)).toHaveLength(3);
    const text = await runLatencyFit(
      ["--cassette", cassette, "--out", join(root, "fit.json")],
      root
    );
    expect(text).toContain("summarization");
    const written = latencyFitSchema.parse(
      JSON.parse(await readFile(join(root, "fit.json"), "utf8"))
    );
    expect(written.tasks.summarization!.count).toBe(2);
    await expect(runLatencyFit(["--cassette", join(root, "nothing")], root)).rejects.toThrow(
      /No recorded Codex response/u
    );
    expect(await runLatencyFit(["--help"], root)).toContain("Usage");
  });
});
