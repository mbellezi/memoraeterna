import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks,
  parseKnowledgeGraphBatchCheckpoints,
  type KnowledgeAiExecution,
  type KnowledgeCallContext,
  type KnowledgeGraphAtomicNoteInput,
  type KnowledgeGraphBatchCheckpoint
} from "./knowledge-processing.js";

/**
 * Parallel calls inside one import (F5 D22): the summary map and the graph extraction run their
 * batches up to the lane limit, and nothing they produce depends on the order the calls finish in.
 * A fake writer answers each prompt with a function of its text, after a random time; every seed
 * must give byte-equal outputs, prompts and checkpoints to the serial run.
 */

const seeds = Array.from({ length: 20 }, (_, index) => index + 1);

/** A small seeded generator, so a seed replays its latencies. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** An extraction answer that depends only on the prompt; about one in four first answers is cut. */
function graphAnswer(prompt: string, context: KnowledgeCallContext): string {
  const hash = digest(prompt);
  if (context.attempt === 0 && Number.parseInt(hash[0]!, 16) % 4 === 0)
    return '{"entities":[{"key":"e1"';
  const count = 1 + (Number.parseInt(hash[1]!, 16) % 3);
  const entities = Array.from({ length: count }, (_, index) => ({
    key: `e${index + 1}`,
    type: "Concept",
    canonicalName: `Concept ${hash.slice(2, 8)} ${index + 1}`,
    identityDescription: "A concept defined in the supplied evidence.",
    aliases: [],
    confidence: 0.9,
    evidenceChunkIds: ["c1"]
  }));
  const relations =
    count > 1
      ? [
          {
            subjectEntityKey: "e1",
            predicate: "relates_to",
            displayLabel: "Relates to",
            definition: "The subject has a general association with the object.",
            objectEntityKey: "e2",
            confidence: 0.8,
            evidenceChunkIds: ["c1"]
          }
        ]
      : [];
  return JSON.stringify({ entities, relations });
}

function summaryAnswer(prompt: string, context: KnowledgeCallContext): unknown {
  const hash = digest(prompt).slice(0, 8);
  return context.operation === "summary_map"
    ? { summary: `Partial ${hash}`, concepts: [{ idea: `Idea ${hash}`, evidenceChunkIds: ["c1"] }] }
    : `Reduced ${hash}`;
}

interface Call {
  prompt: string;
  batchIndex: number;
  attempt: number;
}

/**
 * The fake writer: answers after a random 0-40 ms (none when serial), records every call and its
 * peak concurrency, and fails the `crashAt`-th call (1-based) when asked.
 */
function writer(
  answer: (prompt: string, context: KnowledgeCallContext) => unknown,
  options: { seed?: number; crashAt?: number } = {}
) {
  const next = options.seed === undefined ? () => 0 : random(options.seed);
  const calls: Call[] = [];
  let running = 0;
  let peak = 0;
  const run = async (
    prompt: string,
    context: KnowledgeCallContext
  ): Promise<KnowledgeAiExecution | null> => {
    calls.push({ prompt, batchIndex: context.batchIndex, attempt: context.attempt });
    const call = calls.length;
    running += 1;
    peak = Math.max(peak, running);
    try {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(next() * 40)));
      if (call === options.crashAt) throw new Error("writer_crashed");
      return {
        output: answer(prompt, context),
        providerId: "fake",
        modelId: "writer",
        runtime: "remote",
        profileId: "profile-1",
        aiTaskRunId: `run-${digest(prompt).slice(0, 12)}`
      };
    } finally {
      running -= 1;
    }
  };
  return { run, calls, peak: () => peak };
}

/** Runs a generation to the end on the fake clock and returns what it resolved or threw. */
async function drive<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  await vi.runAllTimersAsync();
  return settled;
}

const source = { title: "A long source", language: "en" };
/** Fourteen excerpts, one per batch (the batch limit is below two excerpts). */
const excerpts: KnowledgeGraphAtomicNoteInput[] = Array.from({ length: 14 }, (_, index) => ({
  id: `chunk-${index}`,
  title: `Excerpt ${index}`,
  ideaStatement: "",
  bodyMarkdown: `Body ${index} `.repeat(6),
  evidenceChunkIds: [`chunk-${index}`]
}));
const positions = new Map(excerpts.map((excerpt, index) => [excerpt.id, index]));
const batchCharacters = 60;

/** The persisted job metadata, as the supervisor stores and reads it back. */
function store() {
  const writes: KnowledgeGraphBatchCheckpoint[][] = [];
  let writing = false;
  let overlapped = false;
  const progress: number[] = [];
  return {
    writes,
    progress,
    overlapped: () => overlapped,
    saved: () =>
      parseKnowledgeGraphBatchCheckpoints(JSON.parse(JSON.stringify(writes.at(-1) ?? []))),
    onBatchCompleted: async (input: {
      completed: number;
      total: number;
      checkpoints: KnowledgeGraphBatchCheckpoint[];
    }) => {
      if (writing) overlapped = true;
      writing = true;
      progress.push(input.completed);
      await new Promise((resolve) => setTimeout(resolve, 3));
      writes.push(input.checkpoints);
      writing = false;
    }
  };
}

function extract(
  run: ReturnType<typeof writer>["run"],
  options: {
    concurrency?: number;
    completedBatches?: KnowledgeGraphBatchCheckpoint[];
    onBatchCompleted?: ReturnType<typeof store>["onBatchCompleted"];
  } = {}
) {
  return generateKnowledgeGraphFromAtomicNotes(source, excerpts, run, batchCharacters, {
    inputKind: "source_chunks",
    checkpointNamespace: "source",
    chunkPositions: positions,
    contentLanguage: "en",
    ...options
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("graph extraction in parallel (F5 D22)", () => {
  it("gives byte-equal outputs, prompts and checkpoints to the serial run for 20 seeds", async () => {
    const serialWriter = writer(graphAnswer);
    const serialStore = store();
    const serial = await drive(
      extract(serialWriter.run, { onBatchCompleted: serialStore.onBatchCompleted })
    );
    expect(serial.error).toBeUndefined();
    expect(serial.value?.batches).toHaveLength(excerpts.length);
    expect(serialWriter.peak()).toBe(1);
    expect(
      serialWriter.calls.some((call) => call.attempt === 1),
      "some batches repair"
    ).toBe(true);
    const expected = JSON.stringify(serial.value);
    const expectedSaved = JSON.stringify(serialStore.writes.at(-1));
    const expectedPrompts = serialWriter.calls.map((call) => call.prompt).sort();

    for (const seed of seeds) {
      const parallelWriter = writer(graphAnswer, { seed });
      const parallelStore = store();
      const parallel = await drive(
        extract(parallelWriter.run, {
          concurrency: 4,
          onBatchCompleted: parallelStore.onBatchCompleted
        })
      );
      expect(parallel.error, `seed ${seed}`).toBeUndefined();
      expect(JSON.stringify(parallel.value), `seed ${seed}: outputs`).toBe(expected);
      expect(JSON.stringify(parallelStore.writes.at(-1)), `seed ${seed}: checkpoints`).toBe(
        expectedSaved
      );
      expect(
        parallelWriter.calls.map((call) => call.prompt).sort(),
        `seed ${seed}: prompts`
      ).toEqual(expectedPrompts);
      expect(parallelWriter.peak(), `seed ${seed}: lane limit`).toBeLessThanOrEqual(4);
      expect(parallelWriter.peak(), `seed ${seed}: batches overlap`).toBeGreaterThan(1);
      // One write at a time, one per batch, each holding every batch done so far in batch order.
      expect(parallelStore.overlapped(), `seed ${seed}: serialized writes`).toBe(false);
      expect(parallelStore.progress).toEqual(excerpts.map((_, index) => index + 1));
      for (const write of parallelStore.writes)
        expect(write.map((checkpoint) => checkpoint.batchIndex)).toEqual(
          [...write.map((checkpoint) => checkpoint.batchIndex!)].sort((a, b) => a - b)
        );
    }
  });

  it("reuses checkpoints by key after a crash at a random point, for 20 seeds", async () => {
    const serialWriter = writer(graphAnswer);
    const serial = await drive(extract(serialWriter.run));
    const expected = JSON.stringify(serial.value);
    // A crash point among all the calls of the source, repairs included.
    const totalCalls = serialWriter.calls.length;
    let crashedOnRepair = 0;

    for (const seed of seeds) {
      const crashAt = 1 + Math.floor(random(seed * 7919)() * totalCalls);
      const crashed = writer(graphAnswer, { seed, crashAt });
      const crashedStore = store();
      const first = await drive(
        extract(crashed.run, { concurrency: 3, onBatchCompleted: crashedStore.onBatchCompleted })
      );
      expect(first.error, `seed ${seed}`).toEqual(new Error("writer_crashed"));
      if (crashed.calls[crashAt - 1]?.attempt === 1) crashedOnRepair += 1;
      const saved = crashedStore.saved();
      // The batches in flight at the crash finished and were kept; the saved ones need not be a
      // prefix of the source.
      expect(saved.every((checkpoint) => checkpoint.batchIndex !== undefined)).toBe(true);

      const resumed = writer(graphAnswer, { seed: seed + 100 });
      const second = await drive(extract(resumed.run, { concurrency: 3, completedBatches: saved }));
      expect(second.error, `seed ${seed}`).toBeUndefined();
      expect(JSON.stringify(second.value), `seed ${seed}: resumed outputs`).toBe(expected);
      const savedIndexes = new Set(saved.map((checkpoint) => checkpoint.batchIndex));
      const called = new Set(resumed.calls.map((call) => call.batchIndex));
      expect(
        [...called].filter((index) => savedIndexes.has(index)),
        `seed ${seed}`
      ).toEqual([]);
      expect(called.size + savedIndexes.size, `seed ${seed}`).toBe(excerpts.length);
    }
    expect(crashedOnRepair, "some seeds crash a repair call").toBeGreaterThan(0);
  });

  it("reuses a checkpoint stored before F5 at its place in the list", async () => {
    const serial = await drive(extract(writer(graphAnswer).run));
    const legacy = serial.value!.checkpoints.slice(0, 5).map((checkpoint) => ({
      batchKey: checkpoint.batchKey,
      batch: checkpoint.batch,
      execution: checkpoint.execution
    }));
    const resumed = writer(graphAnswer);
    const result = await drive(extract(resumed.run, { completedBatches: legacy }));
    expect(JSON.stringify(result.value)).toBe(JSON.stringify(serial.value));
    expect(Math.min(...resumed.calls.map((call) => call.batchIndex))).toBe(5);
  });

  it("reuses each checkpoint whose key matches, past one that does not", async () => {
    const serial = await drive(extract(writer(graphAnswer).run));
    const stored = serial.value!.checkpoints.map((checkpoint) => ({ ...checkpoint }));
    // Batch 3's input changed since it was stored; batch 6's checkpoint claims batch 7's place.
    stored[3] = { ...stored[3]!, batchKey: "source:stale" };
    stored[6] = { ...stored[6]!, batchIndex: 7 };
    stored.splice(7, 1);
    const resumed = writer(graphAnswer);
    const result = await drive(extract(resumed.run, { completedBatches: stored }));
    expect(JSON.stringify(result.value)).toBe(JSON.stringify(serial.value));
    expect(
      [...new Set(resumed.calls.map((call) => call.batchIndex))].sort((a, b) => a - b)
    ).toEqual([3, 6, 7]);
  });

  it("resolves null and starts no further batch when no model is routed", async () => {
    let calls = 0;
    const result = await drive(
      extract(
        async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return null;
        },
        { concurrency: 2 }
      )
    );
    expect(result).toEqual({ value: null });
    expect(calls).toBe(2);
  });

  it("starts no further batch once the caller's signal is aborted", async () => {
    const controller = new AbortController();
    const slow = writer(graphAnswer, { seed: 3 });
    const pending = generateKnowledgeGraphFromAtomicNotes(
      source,
      excerpts,
      slow.run,
      batchCharacters,
      {
        inputKind: "source_chunks",
        chunkPositions: positions,
        concurrency: 2,
        signal: controller.signal
      }
    );
    const reason = new Error("job_cancelled");
    controller.abort(reason);
    const result = await drive(pending);
    expect(result.error).toBe(reason);
    expect(slow.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("the summary map in parallel (F5 D22)", () => {
  const chunks = Array.from({ length: 11 }, (_, index) => ({
    id: `chunk-${index}`,
    content: `Paragraph ${index} holds substantive words about memory and recall. `.repeat(3)
  }));

  it("gives byte-equal summaries, concepts and calls to the serial run for 20 seeds", async () => {
    const serialWriter = writer(summaryAnswer);
    const serial = await drive(generateSummaryFromChunks(chunks, serialWriter.run, 250, 0));
    expect(serial.value?.mapReduce).toBe(true);
    expect(serialWriter.calls.filter((call) => call.attempt === 0).length).toBe(chunks.length + 1);
    const expected = JSON.stringify(serial.value);
    const expectedPrompts = serialWriter.calls.map((call) => call.prompt);

    for (const seed of seeds) {
      const parallelWriter = writer(summaryAnswer, { seed });
      const concurrency = vi.fn(async () => 4);
      const parallel = await drive(
        generateSummaryFromChunks(chunks, parallelWriter.run, 250, 0, null, { concurrency })
      );
      expect(JSON.stringify(parallel.value), `seed ${seed}`).toBe(expected);
      // The reduction's prompt (the last call) joins the partials in chunk order.
      expect(parallelWriter.calls.at(-1)?.prompt).toBe(expectedPrompts.at(-1));
      expect(parallelWriter.calls.map((call) => call.prompt).sort()).toEqual(
        [...expectedPrompts].sort()
      );
      expect(parallelWriter.peak()).toBeGreaterThan(1);
      expect(parallelWriter.peak()).toBeLessThanOrEqual(4);
      expect(concurrency).toHaveBeenCalledOnce();
    }
  });

  it("asks for no concurrency when the source fits one call", async () => {
    const concurrency = vi.fn(async () => 4);
    const single = writer(summaryAnswer);
    await drive(
      generateSummaryFromChunks(chunks.slice(0, 1), single.run, 5_000, 0, null, { concurrency })
    );
    expect(concurrency).not.toHaveBeenCalled();
    expect(single.calls).toHaveLength(1);
  });
});
