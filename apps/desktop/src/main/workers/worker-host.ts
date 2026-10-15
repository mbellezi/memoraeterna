import { parentPort, workerData } from "node:worker_threads";

import { runAssetStorage } from "./asset-storage.worker.js";
import { runAtomicNoteGeneration } from "./atomic-note-generation.worker.js";
import { runChunking } from "./chunking.worker.js";
import { runEmbedding } from "./embedding.worker.js";
import { runIngestion } from "./ingestion.worker.js";
import { runMarkdownConversion } from "./markdown-conversion.worker.js";
import { runObsidianSync } from "./obsidian-sync.worker.js";
import {
  workerErrorMessage,
  workerTaskSchema,
  type WorkerMessage,
  type WorkerTask
} from "./worker-contracts.js";

const task = workerTaskSchema.parse(workerData);

function send(message: WorkerMessage): void {
  parentPort?.postMessage(message);
}

type WorkerRunner = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

const runners: Record<WorkerTask["type"], WorkerRunner> = {
  ingestion: runIngestion,
  "markdown-conversion": runMarkdownConversion,
  chunking: runChunking,
  embedding: runEmbedding,
  "atomic-note-generation": runAtomicNoteGeneration,
  "obsidian-sync": runObsidianSync,
  "asset-storage": runAssetStorage,
  // Loaded on demand: graphology and the Louvain detector stay out of every other worker thread.
  "topic-clustering": async (payload) =>
    (await import("./topic-clustering.worker.js")).runTopicClustering(payload)
};

async function run(): Promise<void> {
  send({ kind: "progress", progress: 0.05 });
  const result = await runners[task.type](task.payload);
  send({ kind: "progress", progress: 1 });
  send({ kind: "result", result });
}

void run().catch((error: unknown) => {
  send(workerErrorMessage(error));
});
