// A stand-in for the worker host in supervisor tests: it speaks the worker message protocol and
// acts out one behavior per task, chosen by `payload.mode` or, for a clustering request (which
// is strict and has no `mode`), by `payload.seed`.
import { parentPort, workerData } from "node:worker_threads";

import { createTopicTreeState, defaultTopicTreeConfig, shapeReport } from "@app/domain/topic-tree";

const { payload } = workerData;
const modeOfSeed = {
  1: "valid",
  2: "spin",
  3: "invalid-input",
  4: "crash",
  5: "malformed-result",
  6: "wrong-partition",
  7: "failure"
};
const mode = payload.mode ?? modeOfSeed[payload.seed];
const send = (message) => parentPort.postMessage(message);

function emptyMetrics() {
  const state = createTopicTreeState({ dim: 256, rootId: "0" });
  return shapeReport(state, defaultTopicTreeConfig, { expectedItems: [] });
}

function result(nodes) {
  return {
    nodes,
    metrics: emptyMetrics(),
    timings: { knnMs: 0, communitiesMs: 0, repairMs: 0 },
    knn: { exact: true }
  };
}

if (mode === "echo") {
  const vectors = payload.vectors;
  send({
    kind: "result",
    result: { length: vectors.length, sum: vectors.reduce((total, value) => total + value, 0) }
  });
} else if (mode === "valid") {
  const items = Array.from({ length: payload.rows }, (_, row) => row);
  send({ kind: "result", result: result([{ key: 0, parent: null, items }]) });
} else if (mode === "spin") {
  send({ kind: "progress", progress: 0.5 });
  for (;;) {
    // A synchronous loop, as a clustering run is: only terminating the thread stops it.
  }
} else if (mode === "invalid-input") {
  send({
    kind: "error",
    error: "row 3 is not of unit length",
    code: "topic_clustering_invalid_input"
  });
} else if (mode === "failure") {
  send({ kind: "error", error: "the detector failed" });
} else if (mode === "crash") {
  process.exit(3);
} else if (mode === "malformed-result") {
  send({ kind: "result", result: { nodes: "not a list" } });
} else if (mode === "wrong-partition") {
  send({ kind: "result", result: result([{ key: 0, parent: null, items: [0] }]) });
} else {
  send({ kind: "error", error: `unknown fixture mode ${String(mode)}` });
}
