import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { supportsTask, type AiCapability } from "@app/domain";

import type { AiTaskRequest } from "./contracts.js";
import { MlxAdapter, NodeLlamaCppAdapter } from "./local-adapters.js";
import {
  fitRankingSequence,
  MlxRerankerAdapter,
  NodeLlamaRankerAdapter,
  qwen3RankingTemplate,
  rankWithAdapter,
  resolveRankerRuntimeConfig,
  type GgufRankingRuntime
} from "./local-ranker-adapters.js";
import type { MlxHelperScoreResult } from "./local-runtime-protocol.js";
import { MlxHelperHost } from "./mlx-helper-host.js";
import { isDedicatedRanker, localParameterCapabilities } from "./parameter-capabilities.js";
import { isTransientAiError } from "./provider-error.js";
import { rankTaskRequest, type RankRequest } from "./ranker-input.js";
import { runRankerSmoke } from "./ranker-validation.js";

const rankerCapabilities: AiCapability[] = ["reranking", "offline", "local-files"];
const generativeCapabilities: AiCapability[] = [
  "text-generation",
  "structured-output",
  "summarization",
  "offline"
];
/** What profiles stored before D17: a generative model tagged `reranking`. */
const legacyTaggedCapabilities: AiCapability[] = [...generativeCapabilities, "reranking"];
const embeddingCapabilities: AiCapability[] = ["embedding", "offline"];

const rank: RankRequest = {
  instruction: "Decide whether the Document is about the Query's topic.",
  query: "Title: Photosynthesis",
  documents: ["Topic: Plant biology", "Topic: Football leagues"]
};

const roots: string[] = [];
const hosts: MlxHelperHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function scoreResult(count: number, overrides: Partial<MlxHelperScoreResult> = {}) {
  return {
    protocolVersion: 1 as const,
    requestId: "00000000-0000-4000-8000-000000000001",
    kind: "result" as const,
    ok: true as const,
    durationMs: 12,
    inputTokens: 100 * count,
    scores: Array.from({ length: count }, (_, index) => (index === 0 ? 0.99 : 0.02)),
    logOdds: Array.from({ length: count }, (_, index) => (index === 0 ? 4.5 : -3.875)),
    yesTokenId: 9_693,
    noTokenId: 2_152,
    tokenCounts: Array.from({ length: count }, (_, index) => 100 + index),
    truncated: Array.from({ length: count }, (_, index) => index === 1),
    timing: {
      loadMs: 0,
      modelCached: true,
      tokenizeMs: 0.1,
      inferenceMs: 10,
      perItemMs: 5,
      totalMs: 12,
      batches: [{ size: count, sequenceLength: 101, ms: 10 }]
    },
    ...overrides
  };
}

function mlxRanker(
  capabilities = rankerCapabilities,
  score?: ConstructorParameters<typeof MlxRerankerAdapter>[1]
) {
  return new MlxRerankerAdapter(
    {
      modelId: "Qwen/Qwen3-Reranker-0.6B",
      modelPath: "/managed/qwen3-reranker",
      helperPath: "/managed/helper",
      capabilities
    },
    score ?? (async (input) => scoreResult(input.documents?.length ?? 0))
  );
}

function fakeGgufRuntime(probabilities: (documents: readonly string[]) => number[]) {
  const calls: Array<{ instruction: string; documents: readonly string[] }> = [];
  let active = 0;
  let overlapped = false;
  const runtime: GgufRankingRuntime = {
    isLoaded: () => true,
    load: async () => undefined,
    rank: async (input) => {
      active += 1;
      if (active > 1) overlapped = true;
      calls.push({ instruction: input.instruction, documents: input.documents });
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        probabilities: probabilities(input.documents),
        tokenCounts: input.documents.map(() => 64),
        truncated: input.documents.map(() => false)
      };
    },
    runtimeBuild: async () => "node-llama-cpp@3.19.0+llama.cpp@b0000/metal/prebuilt",
    dispose: async () => undefined
  };
  return { runtime, calls, overlapped: () => overlapped };
}

function ggufRanker(runtime: GgufRankingRuntime, capabilities = rankerCapabilities) {
  return new NodeLlamaRankerAdapter(
    {
      modelId: "qwen3-reranker-0.6b-q8_0.gguf",
      modelPath: "/managed/qwen3-reranker-0.6b-q8_0.gguf",
      capabilities
    },
    runtime
  );
}

function request(
  taskType: AiTaskRequest["taskType"],
  requiredCapabilities: AiCapability[],
  input: unknown = "prompt"
): AiTaskRequest {
  return { taskType, input, requiredCapabilities, parameters: {}, metadata: {} };
}

describe("ranker and generative adapter separation", () => {
  const generativeMlx = (capabilities: AiCapability[]) =>
    new MlxAdapter({ modelId: "m", modelPath: "/m", helperPath: "/h", capabilities }, async () => ({
      output: "unused",
      durationMs: 1
    }));
  const generativeGguf = (capabilities: AiCapability[]) =>
    new NodeLlamaCppAdapter(
      { modelId: "g", modelPath: "/g.gguf", capabilities },
      async () => ({ output: "unused", durationMs: 1 }),
      async () => ({ output: [1], durationMs: 1 })
    );
  const fake = fakeGgufRuntime(() => [0.9, 0.1]).runtime;

  it("lets only the ranker adapters run a dedicated ranker", async () => {
    const rankRequest = rankTaskRequest(rank);
    expect(isDedicatedRanker(rankerCapabilities)).toBe(true);
    expect(mlxRanker().canHandle(rankRequest)).toBe(true);
    expect(ggufRanker(fake).canHandle(rankRequest)).toBe(true);

    for (const adapter of [generativeMlx(rankerCapabilities), generativeGguf(rankerCapabilities)]) {
      expect(adapter.canHandle(rankRequest)).toBe(false);
      expect(adapter.canHandle(request("text-generation", []))).toBe(false);
      await expect(adapter.run(rankRequest)).rejects.toThrow("errors.ai.unsupportedTask");
    }
    await expect(
      generativeGguf(rankerCapabilities).runStreaming(rankRequest, undefined, () => undefined)
    ).rejects.toThrow("errors.ai.unsupportedTask");
  });

  it("keeps rankers away from generative, legacy-tagged and embedding models and other tasks", async () => {
    for (const capabilities of [
      generativeCapabilities,
      legacyTaggedCapabilities,
      embeddingCapabilities
    ]) {
      expect(isDedicatedRanker(capabilities)).toBe(false);
      for (const adapter of [mlxRanker(capabilities), ggufRanker(fake, capabilities)]) {
        expect(adapter.canHandle(rankTaskRequest(rank))).toBe(false);
        await expect(adapter.run(rankTaskRequest(rank))).rejects.toThrow(
          "errors.ai.unsupportedTask"
        );
      }
    }
    for (const taskType of ["text-generation", "embedding", "structured-output"] as const) {
      expect(mlxRanker().canHandle(request(taskType, []))).toBe(false);
      expect(ggufRanker(fake).canHandle(request(taskType, []))).toBe(false);
    }
  });

  it("still routes old profiles that keep the tag to their generative decider", async () => {
    expect(supportsTask("reranking", legacyTaggedCapabilities)).toBe(true);
    expect(supportsTask("reranking", generativeCapabilities)).toBe(true);
    // AiService requires `reranking` of a model that declares it, else one generative capability.
    for (const required of [["reranking"], ["structured-output"]] as AiCapability[][]) {
      expect(
        generativeMlx(legacyTaggedCapabilities).canHandle(request("reranking", required))
      ).toBe(true);
      expect(
        generativeGguf(legacyTaggedCapabilities).canHandle(request("reranking", required))
      ).toBe(true);
    }
    expect(
      generativeMlx(generativeCapabilities).canHandle(request("reranking", ["structured-output"]))
    ).toBe(true);
    await expect(
      generativeMlx(legacyTaggedCapabilities).run(request("reranking", ["reranking"]))
    ).resolves.toMatchObject({ output: "unused" });
  });

  it("keeps embedding and generation apart on the GGUF generative adapter", () => {
    expect(
      generativeGguf(embeddingCapabilities).canHandle(request("embedding", ["embedding"]))
    ).toBe(true);
    expect(generativeGguf(embeddingCapabilities).canHandle(request("text-generation", []))).toBe(
      false
    );
    expect(generativeGguf(generativeCapabilities).canHandle(request("embedding", []))).toBe(false);
    expect(
      generativeMlx(embeddingCapabilities).canHandle(request("embedding", ["embedding"]))
    ).toBe(false);
  });

  it("gives a dedicated ranker no generation parameters", () => {
    for (const runtime of ["mlx", "gguf"] as const) {
      expect(
        localParameterCapabilities({
          runtime,
          modelId: "Qwen/Qwen3-Reranker-0.6B",
          capabilities: rankerCapabilities
        })
      ).toEqual({});
    }
    expect(mlxRanker().describe()).toMatchObject({
      providerId: "local-mlx",
      parameterCapabilities: {},
      limits: { maxDocuments: 32, maxSequenceTokens: 2_048 },
      requirements: { adapter: "mlx-swift-lm", kind: "ranker" }
    });
    expect(ggufRanker(fake).describe()).toMatchObject({
      providerId: "local-gguf",
      parameterCapabilities: {},
      requirements: { adapter: "node-llama-cpp", kind: "ranker" }
    });
  });
});

describe("MlxRerankerAdapter", () => {
  it("scores a rank request on the helper and audits tokens at no cost", async () => {
    const calls: unknown[] = [];
    const adapter = mlxRanker(rankerCapabilities, async (input, options) => {
      calls.push({ input, timeoutMs: options.timeoutMs });
      return scoreResult(input.documents!.length);
    });

    const result = await adapter.run(rankTaskRequest(rank));

    expect(calls).toEqual([
      {
        input: {
          modelPath: "/managed/qwen3-reranker",
          instruction: rank.instruction,
          query: rank.query,
          documents: rank.documents,
          maxTokens: 2_048,
          batchSize: 16
        },
        timeoutMs: 600_000
      }
    ]);
    expect(result).toEqual({
      taskType: "reranking",
      output: {
        logOdds: [4.5, -3.875],
        scores: [0.99, 0.02],
        tokenCounts: [100, 101],
        truncated: [false, true]
      },
      providerId: "local-mlx",
      modelId: "Qwen/Qwen3-Reranker-0.6B",
      runtime: "local",
      durationMs: 12,
      inputTokens: 201,
      outputTokens: 0,
      costEstimate: 0
    });
    await expect(rankWithAdapter(adapter, rank)).resolves.toMatchObject({ logOdds: [4.5, -3.875] });
  });

  it("refuses a generative prompt and a result that does not score every document", async () => {
    await expect(
      mlxRanker().run(request("reranking", ["reranking"], "Rank these"))
    ).rejects.toThrow("errors.ai.unsupportedTask");
    const short = mlxRanker(rankerCapabilities, async () => scoreResult(1));
    await expect(short.run(rankTaskRequest(rank))).rejects.toThrow(
      "errors.localModels.invalidRuntimeResponse"
    );
  });

  it("maps the failures the helper answers with to non-transient keys through the real host", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mlx-ranker-"));
    roots.push(root);
    const helperPath = join(root, "fake-helper.mjs");
    await writeFile(
      helperPath,
      `#!/usr/bin/env node
import readline from "node:readline";
const send = (request, body) => process.stdout.write(JSON.stringify({
  protocolVersion: 1, requestId: request.requestId.toUpperCase(), ...body }) + "\\n");
const fail = (request, reason, code = "HelperError") => {
  process.stderr.write("memora-mlx-helper: request " + request.requestId.toUpperCase() + " failed: " + reason + "\\n");
  send(request, { kind: "result", ok: false,
    error: { code, messageKey: "errors.localModels.runtimeFailed", recoverable: true } });
};
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.modelPath === "/gemma") fail(request, "unsupported model architecture: Gemma3Model");
  else if (request.modelPath === "/embedding") fail(request, "tokenizer mismatch: unexpected yes/no token ids 1/2");
  else if (request.modelPath === "/request") fail(request, "invalid request: maxTokens is too small");
  else if (request.modelPath === "/weights") fail(request, 'keyNotFound(path: ["model", "norm"])', "UpdateError");
  else if (request.modelPath === "/garbled") send(request, { kind: "result", ok: true, logOdds: "x" });
  else if (request.modelPath === "/crash") process.exit(3);
  else {
    const count = request.documents.length;
    send(request, { kind: "result", ok: true, durationMs: 3, inputTokens: 10 * count,
      scores: request.documents.map(() => 0.5), logOdds: request.documents.map(() => 0),
      yesTokenId: 9693, noTokenId: 2152, tokenCounts: request.documents.map(() => 10),
      truncated: request.documents.map(() => false),
      timing: { loadMs: 0, modelCached: true, tokenizeMs: 0, inferenceMs: 1, perItemMs: 0.5,
        totalMs: 1, batches: [{ size: count, sequenceLength: 10, ms: 1 }] } });
  }
}
`
    );
    await chmod(helperPath, 0o755);
    const host = new MlxHelperHost({
      helperPath,
      environment: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }
    });
    hosts.push(host);
    const adapterFor = (modelPath: string) =>
      new MlxRerankerAdapter({
        modelId: modelPath,
        modelPath,
        helperPath,
        host,
        capabilities: rankerCapabilities
      });

    const failures: Array<[string, string]> = [
      ["/gemma", "errors.localModels.rankerInvalid"],
      ["/embedding", "errors.localModels.rankerInvalid"],
      ["/request", "errors.ai.unsupportedTask"],
      ["/weights", "errors.localModels.rankerInvalid"],
      ["/garbled", "errors.localModels.invalidRuntimeResponse"]
    ];
    for (const [modelPath, key] of failures) {
      const error = await adapterFor(modelPath)
        .run(rankTaskRequest(rank))
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(key);
      expect(isTransientAiError(error)).toBe(false);
      expect(causeMessages(error)).not.toContain("errors.localModels.runtimeFailed");
    }
    expect(
      (
        (await adapterFor("/gemma")
          .run(rankTaskRequest(rank))
          .catch((caught: unknown) => caught)) as { detail: string }
      ).detail
    ).toBe("HelperError: unsupported model architecture: Gemma3Model");

    // A crashed helper stays a transient runtime failure, and the next call respawns it.
    await expect(adapterFor("/crash").run(rankTaskRequest(rank))).rejects.toMatchObject({
      message: "errors.localModels.runtimeFailed",
      code: "helper_exited"
    });
    await expect(adapterFor("/ok").run(rankTaskRequest(rank))).resolves.toMatchObject({
      output: { logOdds: [0, 0] }
    });
  });
});

function causeMessages(error: unknown): string[] {
  const messages: string[] = [];
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

describe("NodeLlamaRankerAdapter", () => {
  it("returns clamped log-odds of the runtime's probabilities and audits at no cost", async () => {
    const { runtime, calls } = fakeGgufRuntime(() => [0.999_5, 0]);
    const adapter = ggufRanker(runtime);

    const result = await adapter.run(rankTaskRequest(rank));

    expect(calls).toEqual([{ instruction: rank.instruction, documents: rank.documents }]);
    const output = result.output as { logOdds: number[]; scores: number[] };
    expect(output.logOdds[0]).toBeCloseTo(Math.log(0.999_5 / 0.000_5), 9);
    expect(output.logOdds[1]).toBeCloseTo(-16.118, 3);
    expect(output.scores).toEqual([0.999_5, 0]);
    expect(result).toMatchObject({
      providerId: "local-gguf",
      inputTokens: 128,
      outputTokens: 0,
      costEstimate: 0
    });
    await expect(adapter.runtimeBuild()).resolves.toMatch(/^node-llama-cpp@/u);
  });

  it("runs one rank call at a time and refuses a non-finite score", async () => {
    const serial = fakeGgufRuntime(() => [0.5, 0.5]);
    const adapter = ggufRanker(serial.runtime);
    await Promise.all([
      adapter.run(rankTaskRequest(rank)),
      adapter.run(rankTaskRequest({ ...rank, instruction: "Another instruction." })),
      adapter.run(rankTaskRequest(rank))
    ]);
    expect(serial.calls).toHaveLength(3);
    expect(serial.overlapped()).toBe(false);

    const broken = ggufRanker(fakeGgufRuntime(() => [Number.NaN, 0.5]).runtime);
    await expect(broken.run(rankTaskRequest(rank))).rejects.toThrow(
      "errors.localModels.rankerInvalid"
    );
  });

  it("passes the smoke test through the adapter when the runtime ranks like the model card", async () => {
    const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));
    const { runtime } = fakeGgufRuntime((documents) =>
      documents[0]!.includes("Beijing") ? [sigmoid(7.6), sigmoid(-11.2)] : [sigmoid(3), sigmoid(-4)]
    );
    const adapter = ggufRanker(runtime);
    const report = await runRankerSmoke((input) => rankWithAdapter(adapter, input));
    expect(report.passed).toBe(true);
  });
});

describe("GGUF ranking sequence", () => {
  it("cuts the document's end first and reports the truncation", () => {
    const query = [1, 2, 3];
    const document = [4, 5, 6, 7, 8];
    expect(
      fitRankingSequence({ templateTokens: 10, query, document, maxSequenceTokens: 18 })
    ).toEqual({ query, document, tokenCount: 18, truncated: false });
    expect(
      fitRankingSequence({ templateTokens: 10, query, document, maxSequenceTokens: 15 })
    ).toEqual({ query, document: [4, 5], tokenCount: 15, truncated: true });
    expect(
      fitRankingSequence({ templateTokens: 10, query, document, maxSequenceTokens: 12 })
    ).toEqual({ query: [1, 2], document: [], tokenCount: 12, truncated: true });
    expect(() =>
      fitRankingSequence({ templateTokens: 10, query, document, maxSequenceTokens: 10 })
    ).toThrow("errors.ai.unsupportedTask");
  });

  it("builds the model card template around one query and one document placeholder", () => {
    const template = qwen3RankingTemplate("Judge relevance.");
    expect(template).toContain(
      "<Instruct>: Judge relevance.\n<Query>: {{query}}\n<Document>: {{document}}"
    );
    expect(template.startsWith("<|im_start|>system\n")).toBe(true);
    expect(template.endsWith("<|im_start|>assistant\n<think>\n\n</think>\n\n")).toBe(true);
  });

  it("bounds the runtime configuration", () => {
    expect(resolveRankerRuntimeConfig()).toEqual({
      maxSequenceTokens: 2_048,
      mlxBatchSize: 16,
      ggufCachedContexts: 2
    });
    expect(resolveRankerRuntimeConfig({ mlxBatchSize: 8 }).mlxBatchSize).toBe(8);
    expect(() => resolveRankerRuntimeConfig({ maxSequenceTokens: 64 })).toThrow();
  });
});
