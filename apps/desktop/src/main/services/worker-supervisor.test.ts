import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMatrix,
  createRng,
  defaultTopicTreeConfig,
  normalizeRows
} from "@app/domain/topic-tree";
import type { TopicClusteringRequest } from "@app/domain/topic-tree";

import { WorkerSupervisor } from "./worker-supervisor.js";

const fixture = new URL("./__fixtures__/topic-clustering-fixture.worker.mjs", import.meta.url);
const supervisors: WorkerSupervisor[] = [];

function supervisor(): WorkerSupervisor {
  const created = new WorkerSupervisor({ workerUrl: fixture });
  supervisors.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((created) => created.shutdown()));
  vi.useRealTimers();
});

/** A request of `rows` random unit rows; the fixture acts out the behavior its seed names. */
function request(
  seed: number,
  extra: Partial<TopicClusteringRequest> = {}
): TopicClusteringRequest {
  const rows = extra.rows ?? 8;
  const matrix = createMatrix(rows, 256);
  const rng = createRng(3);
  for (let index = 0; index < matrix.data.length; index += 1) matrix.data[index] = rng.gaussian();
  normalizeRows(matrix);
  return {
    kind: "build",
    rows,
    dimensions: 256,
    vectors: new Float32Array(matrix.data),
    config: defaultTopicTreeConfig,
    seed,
    ...extra
  };
}

describe("WorkerSupervisor.execute", () => {
  it("transfers a buffer to the worker instead of copying it", async () => {
    const vectors = Float32Array.from([1, 2, 3, 4]);
    const result = await supervisor().execute(
      "topic-clustering",
      { mode: "echo", vectors },
      { transferList: [vectors.buffer] }
    );
    expect(result).toEqual({ length: 4, sum: 10 });
    expect(vectors.byteLength).toBe(0);
    const copied = Float32Array.from([1, 2, 3, 4]);
    await supervisor().execute("topic-clustering", { mode: "echo", vectors: copied });
    expect(copied.byteLength).toBe(16);
  });

  it("reports progress and keeps the default timeout failure of other workers", async () => {
    const progress: number[] = [];
    const started = performance.now();
    await expect(
      supervisor().execute(
        "topic-clustering",
        { mode: "spin" },
        { timeoutMs: 300, onProgress: (value) => progress.push(value) }
      )
    ).rejects.toThrow("Worker exited with code 1.");
    expect(progress).toContain(0.5);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("rejects a timeout with the caller's error and a cancel with an AbortError within a second", async () => {
    await expect(
      supervisor().execute(
        "topic-clustering",
        { mode: "spin" },
        { timeoutMs: 200, timeoutError: (ms) => new Error(`slow ${ms}`) }
      )
    ).rejects.toThrow("slow 200");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    await expect(
      supervisor().execute("topic-clustering", { mode: "spin" }, { signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("stops a running worker on shutdown", async () => {
    const created = supervisor();
    const running = created.execute("topic-clustering", { mode: "spin" });
    const outcome = running.catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await created.shutdown();
    expect(await outcome).toMatchObject({ message: "Worker exited with code 1." });
  });
});

describe("WorkerSupervisor.clusterTopics", () => {
  it("transfers the matrix, validates the result and returns it", async () => {
    const input = request(1);
    const result = await supervisor().clusterTopics(input);
    expect(result.nodes).toEqual([{ key: 0, parent: null, items: [0, 1, 2, 3, 4, 5, 6, 7] }]);
    expect(input.vectors.byteLength).toBe(0);
  });

  it("refuses an invalid request before starting a worker", async () => {
    await expect(
      supervisor().clusterTopics(request(1, { vectors: new Float32Array(10) }))
    ).rejects.toMatchObject({ code: "topic_clustering_invalid_input" });
    await expect(
      supervisor().clusterTopics(request(1, { frozenGroups: [[0]] }))
    ).rejects.toMatchObject({ code: "topic_clustering_invalid_input" });
    const base = request(1);
    const view = new Float32Array(base.vectors.buffer, 0, base.vectors.length - 256);
    await expect(
      supervisor().clusterTopics({ ...base, rows: 7, vectors: view })
    ).rejects.toMatchObject({
      code: "topic_clustering_invalid_input",
      message: "The vectors must own a transferable buffer."
    });
    await expect(supervisor().clusterTopics({ ...request(1), rows: 0 })).rejects.toMatchObject({
      code: "topic_clustering_invalid_input"
    });
  });

  it("does not start when the signal is already aborted", async () => {
    const input = request(1);
    await expect(
      supervisor().clusterTopics(input, { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ code: "topic_clustering_canceled" });
    expect(input.vectors.byteLength).toBeGreaterThan(0);
  });

  it("times out at 30 s plus 5 ms per row from the configuration, with the timeout code", async () => {
    const input = request(2, {
      config: {
        ...defaultTopicTreeConfig,
        build: {
          ...defaultTopicTreeConfig.build,
          workerTimeoutBaseMs: 1000,
          workerTimeoutPerRowMs: 25
        }
      }
    });
    const started = performance.now();
    const failure = await supervisor()
      .clusterTopics(input)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "topic_clustering_timeout" });
    expect((failure as Error).message).toContain("8 rows exceeded 1200 ms");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1100);
    expect(elapsed).toBeLessThan(3000);
  });

  it("cancels a running clustering within a second, with the canceled code", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = performance.now();
    await expect(
      supervisor().clusterTopics(request(2), { signal: controller.signal })
    ).rejects.toMatchObject({ code: "topic_clustering_canceled" });
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("keeps the code a worker reports and maps everything else to the failed code", async () => {
    await expect(supervisor().clusterTopics(request(3))).rejects.toMatchObject({
      code: "topic_clustering_invalid_input",
      message: "row 3 is not of unit length"
    });
    await expect(supervisor().clusterTopics(request(7))).rejects.toMatchObject({
      code: "topic_clustering_failed",
      message: "the detector failed"
    });
    await expect(supervisor().clusterTopics(request(4))).rejects.toMatchObject({
      code: "topic_clustering_failed",
      message: "Worker exited with code 3."
    });
  });

  it("validates the result in main: its schema and its partition", async () => {
    await expect(supervisor().clusterTopics(request(5))).rejects.toMatchObject({
      code: "topic_clustering_failed",
      message: expect.stringContaining("Invalid clustering result") as unknown
    });
    await expect(supervisor().clusterTopics(request(6))).rejects.toMatchObject({
      code: "topic_clustering_failed",
      message: "Invalid clustering result: 1 of 8 rows are placed"
    });
  });
});
