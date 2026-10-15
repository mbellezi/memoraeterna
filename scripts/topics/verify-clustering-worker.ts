// Proof of the topic clustering worker (T13, gate A: "the worker partition hash equals the
// in-memory one"). It runs the BUILT worker host (`npm run build -w @app/desktop` first), so the
// ESM/CJS interop of graphology and the lazily loaded chunk are exercised as shipped.
//
//   npx tsx scripts/topics/verify-clustering-worker.ts [--dataset corpus-notitle] [--seed 20261014]
//       [--expect-hash <sha256>] [--in-process] [--recall] [--groups] [--no-synthetic]
//       [--vectors-dir <dir>]
//
// 1. Synthetic: 1,000 rows of 256 dimensions through the worker give the partition of the
//    in-process builder.
// 2. Dataset: the replay store is paged into one transferred Float32Array (1,000 rows per page,
//    yielding between pages, as the loader of the service does) and clustered by the worker.
//    The partition hash is compared with `--expect-hash` (the T09 parity report) and, with
//    `--in-process`, with a build in this process. The event-loop delay of the main thread is
//    sampled from the first page to the result (bar: p99 below 50 ms).
// 3. `--recall` also runs the `knn-recall` kind on the dataset.
// 4. `--groups` runs a rebuild with 40 frozen articles and a build seeded by the dataset's domains.
import { existsSync } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  buildLouvain,
  createRng,
  defaultTopicTreeConfig,
  deriveSeed,
  gaussianClusters
} from "@app/domain/topic-tree";
import type { EmbeddingMatrix, TopicClusteringRequest } from "@app/domain/topic-tree";

import { WorkerSupervisor } from "../../apps/desktop/src/main/services/worker-supervisor.js";
import { detectCommunitiesLouvain } from "../../apps/desktop/src/main/workers/topic-communities.js";
import { defaultVectorDirs, loadReplayDataset, repoRoot } from "./datasets.js";
import type { ReplayDataset } from "./datasets.js";
import { partitionHash, partitionHashOfNodes } from "./report-data.js";

const pageRows = 1000;
const eventLoopBarMs = 50;

const builtHost = resolve(repoRoot, "apps/desktop/out/main/workers/worker-host.js");

const yieldToEventLoop = (): Promise<void> => new Promise((done) => setImmediate(done));

/** Copies `matrix` into a new transferable buffer, one page at a time. */
async function pagedCopy(matrix: EmbeddingMatrix): Promise<Float32Array<ArrayBuffer>> {
  const vectors = new Float32Array(matrix.count * matrix.dim);
  for (let start = 0; start < matrix.count; start += pageRows) {
    const end = Math.min(matrix.count, start + pageRows);
    vectors.set(matrix.data.subarray(start * matrix.dim, end * matrix.dim), start * matrix.dim);
    await yieldToEventLoop();
  }
  return vectors;
}

function requestOf(
  kind: TopicClusteringRequest["kind"],
  matrix: EmbeddingMatrix,
  vectors: Float32Array<ArrayBuffer>,
  seed: number
): TopicClusteringRequest {
  if (matrix.dim !== 256 && matrix.dim !== 768 && matrix.dim !== 1024) {
    throw new RangeError(`The worker takes 256, 768 or 1024 dimensions, not ${matrix.dim}`);
  }
  return {
    kind,
    rows: matrix.count,
    dimensions: matrix.dim,
    vectors,
    config: defaultTopicTreeConfig,
    seed
  };
}

function inProcessHash(matrix: EmbeddingMatrix, seed: number): { hash: string; ms: number } {
  const started = performance.now();
  const built = buildLouvain(
    matrix,
    Array.from({ length: matrix.count }, (_, row) => row),
    { seed, config: defaultTopicTreeConfig, detectCommunities: detectCommunitiesLouvain }
  );
  return { hash: partitionHash(built.state), ms: performance.now() - started };
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

type Recorder = (name: string, pass: boolean, detail: string) => void;

/** Rows of each label value. */
function groupRows(labels: Int32Array): number[][] {
  const groups = new Map<number, number[]>();
  labels.forEach((label, row) => groups.set(label, [...(groups.get(label) ?? []), row]));
  return [...groups.values()];
}

/** Frozen articles and domain seeds at the scale of the corpus. */
async function verifyGroups(
  supervisor: WorkerSupervisor,
  dataset: ReplayDataset,
  seed: number,
  record: Recorder
): Promise<void> {
  const { matrix } = dataset;
  const frozenGroups = createRng(deriveSeed(seed, "frozen-articles"))
    .shuffle(groupRows(dataset.labels.group))
    .slice(0, 40);
  let started = performance.now();
  const frozen = await supervisor.clusterTopics({
    ...requestOf("rebuild", matrix, await pagedCopy(matrix), seed),
    frozenGroups
  });
  record(
    "rebuild with 40 frozen articles",
    frozen.metrics.reachability === 1 &&
      frozen.metrics.violations.hardCount === 0 &&
      frozen.frozenNodes?.length === 40,
    `${frozenGroups.reduce((total, group) => total + group.length, 0)} frozen rows, ` +
      `${frozen.nodes.length} topics in ${((performance.now() - started) / 1000).toFixed(1)} s, ` +
      `hard violations ${frozen.metrics.violations.hardCount}, ` +
      `awaiting approval ${frozen.metrics.violations.awaitingApproval}`
  );
  const seedGroups = groupRows(dataset.labels.domain).slice(0, 64);
  started = performance.now();
  const seeded = await supervisor.clusterTopics({
    ...requestOf("build", matrix, await pagedCopy(matrix), seed),
    seedGroups
  });
  record(
    `build seeded by ${seedGroups.length} domains`,
    seeded.metrics.reachability === 1 && seeded.metrics.violations.hardCount === 0,
    `${seeded.nodes.length} topics, ${seeded.nodes.filter((node) => node.parent === 0).length} root ` +
      `children in ${((performance.now() - started) / 1000).toFixed(1)} s, ` +
      `hard violations ${seeded.metrics.violations.hardCount}`
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dataset: { type: "string" },
      seed: { type: "string" },
      "expect-hash": { type: "string" },
      "in-process": { type: "boolean" },
      recall: { type: "boolean" },
      groups: { type: "boolean" },
      "no-synthetic": { type: "boolean" },
      "vectors-dir": { type: "string", multiple: true }
    }
  });
  if (!existsSync(builtHost)) {
    console.error(`${builtHost} is missing: run "npm run build -w @app/desktop" first.`);
    return 2;
  }
  const seed = Number(values.seed ?? "20261014");
  const supervisor = new WorkerSupervisor({ workerUrl: pathToFileURL(builtHost) });
  const checks: Check[] = [];
  const record = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
    console.info(`${pass ? "pass" : "FAIL"}  ${name}: ${detail}`);
  };
  try {
    if (!values["no-synthetic"]) {
      const data = gaussianClusters({
        groups: 4,
        clustersPerGroup: 5,
        pointsPerCluster: 50,
        dim: 256,
        groupSpread: 0.8,
        pointNoise: 0.5,
        seed: 7
      });
      const reference = inProcessHash(data.matrix, seed);
      const vectors = await pagedCopy(data.matrix);
      const started = performance.now();
      const result = await supervisor.clusterTopics(requestOf("build", data.matrix, vectors, seed));
      const hash = partitionHashOfNodes(result.nodes);
      record(
        "1k synthetic rows through the built worker host",
        hash === reference.hash && result.metrics.violations.hardCount === 0,
        `${result.nodes.length} topics in ${(performance.now() - started).toFixed(0)} ms, ` +
          `hash ${hash.slice(0, 16)} (in-process ${reference.hash.slice(0, 16)}), ` +
          `hard violations ${result.metrics.violations.hardCount}`
      );
    }

    const name = values.dataset ?? "corpus-notitle";
    const dirs = values["vectors-dir"]?.map((dir) => resolve(dir)) ?? defaultVectorDirs();
    const dataset = await loadReplayDataset(name, { dirs, twins: false });
    const { matrix } = dataset;
    console.info(`dataset ${name}: ${matrix.count} rows x ${matrix.dim}, seed ${seed}`);

    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const started = performance.now();
    const vectors = await pagedCopy(matrix);
    const pagedMs = performance.now() - started;
    const result = await supervisor.clusterTopics(requestOf("build", matrix, vectors, seed));
    const totalMs = performance.now() - started;
    delay.disable();
    const hash = partitionHashOfNodes(result.nodes);
    const p99 = delay.percentile(99) / 1e6;
    console.info(
      `worker build: paging ${pagedMs.toFixed(0)} ms, total ${(totalMs / 1000).toFixed(1)} s ` +
        `(kNN ${(result.timings.knnMs / 1000).toFixed(1)} s, communities ${(result.timings.communitiesMs / 1000).toFixed(1)} s, ` +
        `repair ${(result.timings.repairMs / 1000).toFixed(1)} s), ${result.nodes.length} topics, ` +
        `${result.nodes.filter((node) => node.parent === 0).length} root children, partition ${hash}`
    );
    record(
      "worker result is a sound tree",
      result.metrics.reachability === 1 && result.metrics.violations.hardCount === 0,
      `reachability ${result.metrics.reachability}, hard violations ${result.metrics.violations.hardCount}, ` +
        `transferred buffer detached ${vectors.byteLength === 0}`
    );
    record(
      "main event-loop delay during the build",
      p99 < eventLoopBarMs,
      `p50 ${(delay.percentile(50) / 1e6).toFixed(1)} ms, p99 ${p99.toFixed(1)} ms, ` +
        `max ${(delay.max / 1e6).toFixed(1)} ms (resolution 10 ms, bar p99 < ${eventLoopBarMs} ms)`
    );
    const expected = values["expect-hash"];
    if (expected) {
      record(
        "partition hash equals the recorded T09 hash",
        hash === expected,
        `${hash.slice(0, 16)} vs ${expected.slice(0, 16)}`
      );
    }
    if (values["in-process"]) {
      const reference = inProcessHash(matrix, seed);
      record(
        "partition hash equals the in-process build",
        hash === reference.hash,
        `${hash.slice(0, 16)} vs ${reference.hash.slice(0, 16)} (in-process ${(reference.ms / 1000).toFixed(1)} s)`
      );
    }
    if (values.recall) {
      const copy = await pagedCopy(matrix);
      const recallStarted = performance.now();
      const recall = await supervisor.clusterTopics(requestOf("knn-recall", matrix, copy, seed));
      record(
        "IVF recall@10 through the worker (production setting)",
        (recall.knn.recallAt10 ?? 0) >= 0.9 && !recall.knn.exact,
        `recall ${(recall.knn.recallAt10 ?? 0).toFixed(4)} over 200 sampled rows, ` +
          `${((performance.now() - recallStarted) / 1000).toFixed(1)} s`
      );
    }
    if (values.groups) await verifyGroups(supervisor, dataset, seed, record);
  } finally {
    await supervisor.shutdown();
  }
  const failed = checks.filter((entry) => !entry.pass);
  console.info(failed.length === 0 ? "all checks passed" : `${failed.length} check(s) failed`);
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
