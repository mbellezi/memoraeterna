import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { routeCapacity, type RouteCapacitySelection } from "./ai-task-parameters.js";
import {
  buildAggregateSummaryPrompt,
  generateSummaryFromChunks,
  summarizeSubpartsWithinBudget,
  summaryReductionPrompt
} from "./knowledge-processing.js";
import {
  batchWithinBudget,
  combineWithinBudget,
  summaryBudget,
  summaryBudgetConfig
} from "./summary-batching.js";

// Plan decision 28: summaries are combined within the active writer's window. A source that fits
// in one call keeps the request it always made (proved over requests the golden library recorded);
// a larger one is combined in consecutive batches, recursively, until one call fits.

interface RecordedRequest {
  name: string;
  input: string;
  parameters: Record<string, unknown>;
  model: Record<string, unknown>;
}

const recorded = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "__fixtures__/recorded-aggregate-summary-request.json"),
      "utf8"
    )
  ) as { requests: RecordedRequest[] }
).requests;
const recordedRequest = (name: string): RecordedRequest => {
  const found = recorded.find((request) => request.name === name);
  if (!found) throw new Error(`no recorded ${name} request`);
  return found;
};
/** The application adds a language header before the prompt; the prompt is what the code builds. */
const promptOf = (input: string): string => input.slice(input.indexOf("\n\n") + 2);

const execution = (output: string, id = "run") => ({
  output,
  providerId: "test",
  modelId: "writer",
  runtime: "remote",
  profileId: "profile",
  aiTaskRunId: id
});
const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** The route of the writer a library runs (gpt-5.6-luna on the Codex route, the golden recording). */
const codexRoute: RouteCapacitySelection = {
  localModelId: null,
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: { modelLimits: { contextWindow: 272_000 } }
};
/** An imported local model: its catalog states a 4,096-token window and a 1,024-token output. */
const smallLocalRoute: RouteCapacitySelection = {
  localModelId: "local-model",
  parameters: {},
  modelDefaultParameters: { contextWindow: 4_096, maxTokens: 1_024 },
  providerMetadata: {}
};
/** A catalog MLX model: nothing states its window, its native limit is not metadata the app holds. */
const mlxRoute: RouteCapacitySelection = {
  localModelId: "mlx-model",
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {}
};
const budgetOf = (route: RouteCapacitySelection) =>
  summaryBudget(routeCapacity("summarization", route, "hierarchy_summary"));

describe("the budget of a summary call", () => {
  it("is large for the Codex route and small for a local writer, from the route's own metadata", () => {
    const codex = budgetOf(codexRoute);
    const small = budgetOf(smallLocalRoute);
    const unknown = budgetOf(mlxRoute);
    // The window admission plans a remote call against, minus the 16K output it reserves, 1,024 of
    // its own overhead, a tenth of safety and the room for the language instruction.
    expect(codex).toMatchObject({ contextWindow: 128_000, windowSource: "planning" });
    expect(codex.bytes).toBe(
      Math.floor((128_000 - 16_384 - 1_024) * summaryBudgetConfig.safetyFraction) -
        summaryBudgetConfig.instructionAllowanceBytes
    );
    expect(small).toMatchObject({
      contextWindow: 4_096,
      windowSource: "profile",
      outputReserve: 1_024
    });
    expect(small.bytes).toBe(
      Math.floor((4_096 - 1_024 - 1_024) * summaryBudgetConfig.safetyFraction) -
        summaryBudgetConfig.instructionAllowanceBytes
    );
    expect(codex.bytes).toBeGreaterThan(small.bytes * 50);
    // No window stated: the conservative fallback, with a bounded output reserve.
    expect(unknown).toMatchObject({
      contextWindow: summaryBudgetConfig.fallbackContextWindow,
      windowSource: "assumed",
      outputReserve: summaryBudgetConfig.fallbackOutputReserve
    });
    expect(unknown.bytes).toBeGreaterThan(small.bytes);
    expect(unknown.bytes).toBeLessThan(codex.bytes);
    // A route that cannot be read at all gets the same fallback.
    expect(summaryBudget(null)).toEqual(unknown);
  });

  it("uses the provider's discovered window when it is below the planning budget", () => {
    const route: RouteCapacitySelection = {
      ...codexRoute,
      providerMetadata: { modelLimits: { contextWindow: 32_000 } }
    };
    expect(budgetOf(route)).toMatchObject({ contextWindow: 32_000, windowSource: "provider" });
    expect(budgetOf(route).bytes).toBeLessThan(budgetOf(codexRoute).bytes);
  });

  it("never drops below a floor that still combines two summaries per call", () => {
    expect(
      summaryBudget({ contextWindow: 200, source: "profile", maxOutputTokens: 16_384 }).bytes
    ).toBe(summaryBudgetConfig.minimumBudgetBytes);
  });
});

describe("batching consecutive items within a budget", () => {
  const render = (items: readonly string[]) => items.join("|");

  it("keeps the order, closes a batch at the budget and gives every batch but the last two items", () => {
    const items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
    const batches = batchWithinBudget(items, render, 30);
    expect(batches.flat()).toEqual(items);
    for (const batch of batches.slice(0, -1)) expect(batch.length).toBeGreaterThanOrEqual(2);
    for (const batch of batches.filter((entry) => entry.length > 2))
      expect(bytes(render(batch))).toBeLessThanOrEqual(30);
  });

  it("forms pairs when no pair fits, so the next level always has fewer items", () => {
    const items = ["aaaa", "bbbb", "cccc", "dddd", "eeee"];
    expect(batchWithinBudget(items, render, 1)).toEqual([
      ["aaaa", "bbbb"],
      ["cccc", "dddd"],
      ["eeee"]
    ]);
  });
});

describe("combining within a budget", () => {
  const render = (items: readonly string[]) => `Combine:\n${items.join("\n")}`;
  const join = (_batch: readonly string[], text: string) => text;

  it("makes one call, with the prompt it always made, while the items fit", async () => {
    const items = ["one", "two", "three"];
    const run = vi.fn(async (step: { prompt: string }) => ({
      text: "combined",
      execution: step.prompt
    }));
    const result = await combineWithinBudget({
      items,
      render,
      budgetBytes: bytes(render(items)),
      run,
      join
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({ prompt: render(items), level: 0, batches: 1 });
    expect(result).toMatchObject({ item: "combined", batched: false, calls: 1, levels: 0 });
  });

  it("combines batches, then their results, until one call fits", async () => {
    const items = Array.from(
      { length: 12 },
      (_, index) => `chapter ${index + 1} ${"x".repeat(40)}`
    );
    const prompts: string[] = [];
    const result = await combineWithinBudget({
      items,
      render,
      budgetBytes: 200,
      run: async (step) => {
        prompts.push(step.prompt);
        // The summary of a batch is short, so the levels above it fit.
        return { text: `s${prompts.length}`, execution: step.prompt };
      },
      join
    });
    expect(result).toMatchObject({ batched: true });
    expect(result!.calls).toBe(prompts.length);
    expect(result!.executions).toEqual(prompts);
    // Every call but a forced pair fits the budget, and the last call is the single final one.
    for (const prompt of prompts) expect(bytes(prompt)).toBeLessThanOrEqual(200);
    expect(prompts.at(-1)).toMatch(/^Combine:\ns\d+(\ns\d+)*$/);
    // Every original item went through exactly one first-level call, in order.
    const firstLevel = prompts.filter((prompt) => prompt.includes("chapter"));
    expect(firstLevel.flatMap((prompt) => prompt.split("\n").slice(1))).toEqual(items);
  });

  it("ends whatever the budget: a pair too large for any prompt is still combined", async () => {
    const items = Array.from({ length: 9 }, (_, index) => `item ${index}`);
    const run = vi.fn(async (step: { prompt: string }) => ({ text: "s", execution: step.prompt }));
    const result = await combineWithinBudget({ items, render, budgetBytes: 1, run, join });
    expect(result).toMatchObject({ item: "s", batched: true });
    // Each call combines two items into one, so n - 1 calls leave one.
    expect(run).toHaveBeenCalledTimes(items.length - 1);
  });

  it("drops the batches that came back empty and resolves null when no model answers", async () => {
    const items = ["a".repeat(60), "b".repeat(60), "c".repeat(60), "d".repeat(60)];
    const answers = ["", "kept"];
    const dropped = await combineWithinBudget({
      items,
      render,
      budgetBytes: 150,
      run: async (step) => ({ text: answers.shift() ?? "final", execution: step.prompt }),
      join
    });
    expect(dropped?.item).toBe("kept");
    const none = await combineWithinBudget({
      items,
      render,
      budgetBytes: 150,
      run: async () => null,
      join
    });
    expect(none).toBeNull();
    const empty = await combineWithinBudget({
      items: ["a", "b"],
      render,
      budgetBytes: 1_000,
      run: async (step) => ({ text: "", execution: step.prompt }),
      join
    });
    expect(empty).toMatchObject({ item: null, calls: 1 });
  });

  it("stops at a cancellation between calls", async () => {
    const controller = new AbortController();
    const run = vi.fn(async (step: { prompt: string }) => {
      controller.abort();
      return { text: "s", execution: step.prompt };
    });
    await expect(
      combineWithinBudget({
        items: ["a".repeat(60), "b".repeat(60), "c".repeat(60), "d".repeat(60)],
        render,
        budgetBytes: 150,
        run,
        join,
        signal: controller.signal
      })
    ).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("a book's aggregate summary", () => {
  const source = { kind: "book", title: "Learning mechanisms" };
  const chapters = (count: number, size: number) =>
    Array.from({ length: count }, (_, index) => ({
      title: `Chapter ${index + 1}`,
      summary: `Chapter ${index + 1} argues point ${index + 1}. ${"It builds on the earlier chapters. ".repeat(Math.ceil(size / 35))}`
    }));

  it("makes the request the golden library recorded, byte for byte, within a Codex-sized budget", async () => {
    const request = recordedRequest("aggregate");
    // The recording ran on the Codex route with the planning window of a remote call.
    expect(request.parameters).toMatchObject({ contextWindow: 128_000 });
    const subparts = [...request.input.matchAll(/\[Subpart \d+: ([^\]\n]*)\]\n([^\n]*)/gu)].map(
      (match) => ({ title: match[1]!, summary: match[2]! })
    );
    expect(subparts).toHaveLength(3);
    const prompts: string[] = [];
    const result = await summarizeSubpartsWithinBudget({
      source: { kind: "book", title: "O Alienista" },
      subparts,
      budgetBytes: budgetOf(codexRoute).bytes,
      run: async (prompt) => {
        prompts.push(prompt);
        return execution("O resumo do livro.");
      }
    });
    expect(prompts).toEqual([promptOf(request.input)]);
    expect(prompts[0]).toBe(
      buildAggregateSummaryPrompt({ kind: "book", title: "O Alienista" }, subparts)
    );
    expect(result).toMatchObject({ summary: "O resumo do livro.", levels: 0, calls: 1 });
  });

  it("combines a book larger than a Codex-sized window in consecutive batches", async () => {
    const subparts = chapters(60, 2_000);
    const total = bytes(buildAggregateSummaryPrompt(source, subparts));
    const budget = budgetOf(codexRoute).bytes;
    expect(total).toBeGreaterThan(budget);
    const prompts: string[] = [];
    const result = await summarizeSubpartsWithinBudget({
      source,
      subparts,
      budgetBytes: budget,
      run: async (prompt, step) => {
        prompts.push(prompt);
        return execution(`Batch ${step.call + 1} of the book.`);
      }
    });
    // Two batches of consecutive chapters, then the one call over their two summaries.
    expect(result).toMatchObject({ levels: 1, calls: 3 });
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(bytes(prompt)).toBeLessThanOrEqual(budget);
    const covered = prompts
      .slice(0, 2)
      .flatMap((prompt) => [...prompt.matchAll(/Chapter (\d+) argues/gu)]);
    expect(covered.map((match) => Number(match[1]))).toEqual(subparts.map((_, index) => index + 1));
    // The next level reads each batch as the span of chapters it covers, in the same prompt.
    expect(prompts[2]).toContain("[Subpart 1: Chapter 1 – Chapter ");
    expect(prompts[2]).toContain("Batch 1 of the book.");
    expect(prompts[2]).toContain("Batch 2 of the book.");
    expect(result!.summary).toBe("Batch 3 of the book.");
  });

  it("combines it in many more, smaller batches for a local writer with a small window", async () => {
    const subparts = chapters(8, 600);
    const budget = budgetOf(smallLocalRoute).bytes;
    const prompts: string[] = [];
    const result = await summarizeSubpartsWithinBudget({
      source,
      subparts,
      budgetBytes: budget,
      run: async (prompt) => {
        prompts.push(prompt);
        return execution(`Merged ${prompts.length}.`);
      }
    });
    // No pair of 600-byte summaries fits 1,331 bytes: the chapters are combined two at a time (four
    // calls), and the four short results fit the one call that follows.
    expect(result).toMatchObject({ calls: 5, levels: 1 });
    expect(
      prompts.slice(0, 4).map((prompt) => [...prompt.matchAll(/\[Subpart \d+:/gu)].length)
    ).toEqual([2, 2, 2, 2]);
    expect(prompts[4]).toContain("[Subpart 1: Chapter 1 – Chapter 2]");
    expect(prompts[4]).toContain("[Subpart 4: Chapter 7 – Chapter 8]");
    expect(result!.summary).toBe("Merged 5.");
    // A Codex-sized window takes the same book in one call.
    const single: string[] = [];
    await summarizeSubpartsWithinBudget({
      source,
      subparts,
      budgetBytes: budgetOf(codexRoute).bytes,
      run: async (prompt) => {
        single.push(prompt);
        return execution("One call.");
      }
    });
    expect(single).toEqual([buildAggregateSummaryPrompt(source, subparts)]);
  });

  it("uses the fallback window for a local writer whose window nothing states", async () => {
    const subparts = chapters(60, 2_000);
    const budget = budgetOf(mlxRoute).bytes;
    const prompts: string[] = [];
    const result = await summarizeSubpartsWithinBudget({
      source,
      subparts,
      budgetBytes: budget,
      run: async (prompt) => {
        prompts.push(prompt);
        return execution("Short.");
      }
    });
    expect(result!.calls).toBeGreaterThan(3);
    expect(result!.calls).toBeLessThan(subparts.length);
    for (const prompt of prompts) expect(bytes(prompt)).toBeLessThanOrEqual(budget);
  });

  it("builds the same requests whatever the order the sources were created in (a function of content)", async () => {
    const subparts = chapters(30, 2_000);
    const runs: string[][] = [];
    for (const budgetBytes of [20_000, 20_000]) {
      const prompts: string[] = [];
      await summarizeSubpartsWithinBudget({
        source,
        subparts: subparts.map((subpart) => ({ ...subpart })),
        budgetBytes,
        run: async (prompt) => {
          prompts.push(prompt);
          return execution("Same.");
        }
      });
      runs.push(prompts);
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]!.join("\n")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it("resolves an empty summary when nothing substantive came back, and null with no model", async () => {
    const subparts = chapters(6, 1_500);
    const empty = await summarizeSubpartsWithinBudget({
      source,
      subparts,
      budgetBytes: 4_000,
      run: async () => execution("<NO_SUMMARY>")
    });
    expect(empty?.summary).toBe("");
    const none = await summarizeSubpartsWithinBudget({
      source,
      subparts,
      budgetBytes: 4_000,
      run: async () => null
    });
    expect(none).toBeNull();
  });
});

describe("a long source's reduction", () => {
  const chunk = (index: number) => ({
    id: `chunk-${index}`,
    content: `Part ${index}. ${"alpha ".repeat(30)}`
  });
  /** The writer: a partial for each group of chunks, a reduction for the partials. */
  const writer = () => {
    const reductions: string[] = [];
    const run = vi.fn<
      (input: string, context?: { chunkIds: string[] }) => Promise<ReturnType<typeof execution>>
    >(async (input) => {
      if (input.includes("partial summaries")) {
        reductions.push(input);
        return execution(`Reduced ${reductions.length}.`);
      }
      return execution(
        `Partial of ${input.match(/Part \d+/u)?.[0] ?? "?"}. ${"Point. ".repeat(20)}`
      );
    });
    return { run, reductions };
  };

  it("makes the request the golden library recorded, byte for byte, within a Codex-sized budget", async () => {
    const request = recordedRequest("reduce");
    const partials = promptOf(request.input)
      .split("\n\n")
      .slice(1)
      .join("\n\n")
      .split("\n\n---\n\n");
    expect(partials).toHaveLength(2);
    const prompts: string[] = [];
    const run = vi.fn(async (input: string) => {
      if (input.includes("partial summaries")) {
        prompts.push(input);
        return execution("O resumo.");
      }
      return execution(partials[input.includes("[c1]\nPart 1") ? 0 : 1]!);
    });
    const result = await generateSummaryFromChunks(
      [chunk(1), chunk(2)],
      run,
      100,
      0,
      budgetOf(codexRoute).bytes
    );
    expect(prompts).toEqual([promptOf(request.input)]);
    expect(prompts[0]).toBe(summaryReductionPrompt(partials));
    expect(result).toMatchObject({ summary: "O resumo.", mapReduce: true });
    expect(result).not.toHaveProperty("reductionLevels");
    // The same call as with no budget at all.
    const legacy = writer();
    await generateSummaryFromChunks([chunk(1), chunk(2)], legacy.run, 100, 0);
    expect(legacy.reductions).toHaveLength(1);
  });

  it("combines the partial summaries of a source larger than the window in batches", async () => {
    const chunks = Array.from({ length: 12 }, (_, index) => chunk(index + 1));
    const { run, reductions } = writer();
    const budget = 1_100;
    const result = await generateSummaryFromChunks(chunks, run, 100, 0, budget);
    // Twelve partial summaries of about 150 bytes do not fit 1,100 bytes in one call.
    expect(reductions.length).toBeGreaterThan(1);
    for (const prompt of reductions) expect(bytes(prompt)).toBeLessThanOrEqual(budget);
    expect(result).toMatchObject({ mapReduce: true });
    expect(result!.reductionLevels).toBeGreaterThanOrEqual(1);
    expect(result!.summary).toBe(`Reduced ${reductions.length}.`);
    // Every call is on the record, the map calls then the reductions, the last one the answer.
    expect(result!.executions).toHaveLength(12 + reductions.length);
    const reduceCalls = run.mock.calls.filter(([input]) => input.includes("partial summaries"));
    expect(reduceCalls.map(([, context]) => context)).toEqual(
      reduceCalls.map((_, call) =>
        expect.objectContaining({ operation: "summary_reduce", batchIndex: 12 + call })
      )
    );
    // The first batch names the consecutive chunks it covers, from the first.
    const first = reduceCalls[0]![1]!.chunkIds;
    expect(first.length).toBeGreaterThan(1);
    expect(first).toEqual(chunks.slice(0, first.length).map((entry) => entry.id));
  });

  it("reads the budget when the partial summaries are there, once", async () => {
    const budget = vi.fn(async () => 1_100);
    const { run } = writer();
    await generateSummaryFromChunks([chunk(1)], run, 5_000, 0, budget);
    expect(budget).not.toHaveBeenCalled();
    await generateSummaryFromChunks([chunk(1), chunk(2), chunk(3)], run, 100, 0, budget);
    expect(budget).toHaveBeenCalledTimes(1);
  });
});
