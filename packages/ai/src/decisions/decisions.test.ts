import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { frozenRelationCalibrations } from "@app/domain";

import {
  AiCassette,
  AiCassetteMissError,
  aiCassetteReplayedUsageKey,
  aiCassetteRequestKey
} from "../cassette.js";
import type { AiTaskRequest } from "../contracts.js";
import { AiModelRegistry, setAiAdapterDecorator } from "../registry.js";
import { ProviderUnavailableError } from "../scheduler/breaker.js";
import { bindLanePermit } from "../scheduler/execution.js";
import { createAiScheduler } from "../scheduler/scheduler.js";
import { resolveAiLaneRuntimeConfig } from "../runtime-config.js";
import {
  classifyDecisionsFailure,
  cleanDecisionsError,
  OpenAiDecisionsAdapter,
  redactDecisionsSecrets
} from "./adapter.js";
import {
  buildDecisionsWireRequest,
  decisionsContract,
  decisionsLogOdds,
  decisionsOrderSeed,
  decisionsTaskRequest,
  readDecisionsAnswers,
  readDecisionsTaskInput,
  seededOrder,
  type DecisionsTaskInput
} from "./design.js";
import { decisionsRequestDesignSha256, decisionsSpikeFingerprint } from "./frozen-design.js";
import {
  decisionsCostUsd,
  decisionsLaneKey,
  defaultDecisionsLimits,
  resolveDecisionsLimits
} from "./limits.js";
import {
  combineDecisionAnswers,
  estimatePlanInputTokens,
  planDecisionRequests,
  type DecisionsList
} from "./plan.js";

const instruction = "Judge whether the Document relates to the Query note.";
const limits = resolveDecisionsLimits({ retry: { baseDelayMs: 1, maxDelayMs: 2 } });
const note = (title: string) => `Title: ${title}\nIdea: Idea of ${title}\nText: Body of ${title}.`;
const titles = (count: number) => Array.from({ length: count }, (_, index) => `Note ${index + 1}`);

describe("the request design", () => {
  const input: DecisionsTaskInput = {
    contract: decisionsContract,
    instruction,
    query: note("Query"),
    candidates: [note("First"), note("Second")]
  };

  it("builds the validated wire request: instruction, context, query, aliased candidates, one predicate each", () => {
    const wire = buildDecisionsWireRequest(input, "gpt-6-luna");
    expect(wire.model).toBe("gpt-6-luna");
    expect(wire.input).toBe(
      [
        instruction,
        'In this request, "Query" is the query note and each "Document" is one candidate note ' +
          "(c1, c2, ...). Answer every question about its own candidate only, independently of the others.",
        `Query note:\n${note("Query")}`,
        "Candidate notes:",
        `[c1]\n${note("First")}`,
        `[c2]\n${note("Second")}`
      ].join("\n\n")
    );
    expect(wire.questions).toEqual([
      {
        type: "predicate",
        name: "rel_c1",
        instructions:
          "c1 has a substantive conceptual relationship with the query note (supports, contradicts, extends, depends on, exemplifies or clarifies it); sharing a topic alone does not count."
      },
      {
        type: "predicate",
        name: "rel_c2",
        instructions: expect.stringMatching(/^c2 has a substantive conceptual relationship/u)
      }
    ]);
  });

  it("reads a task input only in its own shape", () => {
    expect(readDecisionsTaskInput(JSON.stringify(input))).toEqual(input);
    expect(readDecisionsTaskInput(input)).toEqual(input);
    expect(readDecisionsTaskInput("not json")).toBeNull();
    expect(readDecisionsTaskInput({ query: "q", documents: ["d"] })).toBeNull();
    expect(readDecisionsTaskInput({ ...input, extra: true })).toBeNull();
    expect(readDecisionsTaskInput({ ...input, candidates: [] })).toBeNull();
    const request = decisionsTaskRequest(input, limits);
    expect(request).toMatchObject({
      taskType: "reranking",
      modelId: "gpt-6-luna",
      workloadClass: "decide",
      parameters: {}
    });
    // The task carries no credential and no ID: it is a function of content.
    expect(JSON.stringify(request)).not.toMatch(/sk-|Bearer|[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it("reads answers by their echoed name, then by position; a refusal or a gap is none", () => {
    expect(
      readDecisionsAnswers(
        [
          { type: "predicate", name: "rel_c2", probability: 0.9 },
          { type: "refusal", name: "rel_c1" },
          { type: "predicate", name: "rel_c9", probability: 0.5 }
        ],
        3
      )
    ).toEqual([null, 0.9, null]);
    expect(
      readDecisionsAnswers(
        [
          { type: "predicate", name: null, probability: 0.1 },
          { type: "predicate", name: null, probability: 0.2 }
        ],
        2
      )
    ).toEqual([0.1, 0.2]);
    expect(readDecisionsAnswers([{ type: "score", name: "rel_c1", score: 3 }], 1)).toEqual([null]);
  });

  it("clips the log-odds to the bake-off scale", () => {
    expect(decisionsLogOdds(0.5, 1e-7)).toBe(0);
    expect(decisionsLogOdds(0, 1e-7)).toBeCloseTo(-16.118, 3);
    expect(decisionsLogOdds(1, 1e-7)).toBeCloseTo(16.118, 3);
    expect(decisionsLogOdds(0.79, 1e-7)).toBeCloseTo(1.3249, 3);
  });

  it("reproduces the frozen request design: Spike A2's fingerprint and the identity's requestDesignSha256", () => {
    // Spike A's `mechanism` instruction, the Decisions decider's own (sha256 1fc9a2ee...).
    const mechanism =
      "Given a note (Query), decide whether the Document note makes a claim about the same underlying " +
      "mechanism, rule or phenomenon, so that a careful reader would link the two notes. Shared names, " +
      "titles, vocabulary, catalogs or credits do not count.";
    expect(createHash("sha256").update(mechanism).digest("hex")).toBe(
      "1fc9a2eee90e36636d344db2c7c2566974ac47e67bcbc43eeff250bfd78b0164"
    );
    // The spike's `designFingerprint(mechanism)`, run once from scripts/spikes/decisions/design.ts.
    expect(decisionsSpikeFingerprint(mechanism, limits)).toBe(
      "2824e0cdd2c68756206913454e8a083638442a2d048373de8650392e219e6531"
    );
    const frozen = frozenRelationCalibrations.find(
      (entry) => entry.identity.runtimeKind === "remote"
    )!;
    expect(decisionsRequestDesignSha256(mechanism, limits, 600)).toBe(
      "0e1ebd94857f256b1ea72cd5883c803c2b0db6d87277009b78c6679eaca4098c"
    );
    // The shipped calibration names exactly this design, and its parity is the same fingerprint.
    expect(frozen.identity).toMatchObject({
      requestDesignSha256: decisionsRequestDesignSha256(mechanism, limits, 600),
      instructionSha256: "1fc9a2eee90e36636d344db2c7c2566974ac47e67bcbc43eeff250bfd78b0164"
    });
    expect(frozen.kind === "isotonic" && frozen.parity).toEqual({
      requestDesignSha256: decisionsRequestDesignSha256(mechanism, limits, 600)
    });
  });

  it("changes the request design with the instruction, the model, the chunking, the orders, the scale and the body", () => {
    const base = decisionsRequestDesignSha256(instruction, limits, 600);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(decisionsRequestDesignSha256(instruction, limits, 600)).toBe(base);
    for (const changed of [
      decisionsRequestDesignSha256(`${instruction} `, limits, 600),
      decisionsRequestDesignSha256(instruction, { ...limits, model: "gpt-6-terra" }, 600),
      decisionsRequestDesignSha256(instruction, { ...limits, maxCandidatesPerRequest: 10 }, 600),
      decisionsRequestDesignSha256(instruction, { ...limits, orderSalts: ["a", "b"] }, 600),
      decisionsRequestDesignSha256(instruction, { ...limits, probabilityEpsilon: 1e-3 }, 600),
      decisionsRequestDesignSha256(instruction, limits, 400)
    ])
      expect(changed).not.toBe(base);
    // Retries, deadlines and the price are not the design.
    expect(
      decisionsRequestDesignSha256(
        instruction,
        resolveDecisionsLimits({ totalDeadlineMs: 5_000, pricePerMillionInputTokensUsd: 9 }),
        600
      )
    ).toBe(base);
  });

  it("shuffles by a seed alone: the same seed gives the same permutation, another seed another", () => {
    const seed = decisionsOrderSeed("bakeoff-1", note("Query"), 0);
    expect(seededOrder(8, seed)).toEqual(seededOrder(8, seed));
    expect([...seededOrder(8, seed)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(seededOrder(8, decisionsOrderSeed("bakeoff-2", note("Query"), 0))).not.toEqual(
      seededOrder(8, seed)
    );
    expect(seededOrder(8, decisionsOrderSeed("bakeoff-1", note("Other"), 0))).not.toEqual(
      seededOrder(8, seed)
    );
    expect(seededOrder(1, seed)).toEqual([0]);
  });
});

describe("the plan: two candidate orders, balanced chunks of at most twenty", () => {
  const list = (count: number): DecisionsList => ({
    query: note("Query"),
    candidates: titles(count).map(note)
  });

  it("sends each chunk in both orders, each order a permutation of the same candidates", () => {
    const requests = planDecisionRequests([list(45)], instruction, limits);
    // 45 candidates are three balanced chunks (15, 15, 15), the frozen design's cut; two orders each.
    expect(requests).toHaveLength(6);
    expect(requests.map((request) => request.input.candidates.length)).toEqual([
      15, 15, 15, 15, 15, 15
    ]);
    // 41 candidates are 14, 14, 13.
    expect(
      planDecisionRequests([list(41)], instruction, limits)
        .filter((request) => request.orders[0] === "A")
        .map((request) => request.input.candidates.length)
    ).toEqual([14, 14, 13]);
    expect(requests.map((request) => request.orders)).toEqual([
      ["A"],
      ["B"],
      ["A"],
      ["B"],
      ["A"],
      ["B"]
    ]);
    for (let chunk = 0; chunk < 3; chunk += 1) {
      const [first, second] = [requests[chunk * 2]!, requests[chunk * 2 + 1]!];
      expect([...first.candidateIndices].sort((a, b) => a - b)).toEqual(
        [...second.candidateIndices].sort((a, b) => a - b)
      );
      expect(first.candidateIndices).not.toEqual(second.candidateIndices);
      expect(first.input.candidates).toEqual(
        first.candidateIndices.map((index) => list(45).candidates[index])
      );
    }
    // Every candidate of the list is in exactly one request per order.
    for (const label of ["A", "B"] as const) {
      const covered = requests
        .filter((request) => request.orders.includes(label))
        .flatMap((request) => request.candidateIndices)
        .sort((a, b) => a - b);
      expect(covered).toEqual(Array.from({ length: 45 }, (_, index) => index));
    }
  });

  it("sends a request the two orders make identical once, for both", () => {
    const [single] = planDecisionRequests([list(1)], instruction, limits);
    expect(planDecisionRequests([list(1)], instruction, limits)).toHaveLength(1);
    expect(single!.orders).toEqual(["A", "B"]);
  });

  it("is a function of content: the same lists make the same requests whatever follows or precedes", () => {
    const first = planDecisionRequests([list(7)], instruction, limits)[0]!.input;
    const again = planDecisionRequests([list(3), list(7)], instruction, limits).find(
      (request) => request.input.candidates.length === 7
    )!.input;
    expect(again).toEqual(first);
  });

  it("estimates the input tokens a plan will bill, questions included", () => {
    const requests = planDecisionRequests([list(10)], instruction, limits);
    const estimate = estimatePlanInputTokens(requests, limits);
    const characters = requests.reduce(
      (sum, request) =>
        sum +
        request.input.instruction.length +
        request.input.query.length +
        request.input.candidates.reduce((total, text) => total + text.length, 0),
      0
    );
    expect(estimate).toBe(Math.ceil(characters / 2.5) + 2 * 10 * limits.estimate.tokensPerQuestion);
  });

  it("scores the mean of the two orders' probabilities on the bake-off scale", () => {
    const lists = [list(3)];
    const requests = planDecisionRequests(lists, instruction, limits);
    expect(requests).toHaveLength(2);
    const [a, b] = requests as [(typeof requests)[number], (typeof requests)[number]];
    // The answer of a request is by the position it sent a candidate at.
    const answer = (request: typeof a, byCandidate: number[]) =>
      request.candidateIndices.map((index) => byCandidate[index]!);
    const answers = new Map<number, Array<number | null>>([
      [a.id, answer(a, [0.9, 0.2, 0.0])],
      [b.id, answer(b, [0.5, 0.2, 0.0])]
    ]);
    const [decisions] = combineDecisionAnswers(lists, requests, answers, limits);
    expect(decisions!.map((decision) => decision.probability)).toEqual([0.7, 0.2, 0]);
    expect(decisions![0]!.logOdds).toBeCloseTo(Math.log(0.7 / 0.3), 6);
    // A probability of 0.00 is -16.1, not minus infinity.
    expect(decisions![2]!.logOdds).toBeCloseTo(-16.118, 3);
  });

  it("has no score for a candidate an order did not answer, and applies a shared request to both", () => {
    const lists = [list(2), list(1)];
    const requests = planDecisionRequests(lists, instruction, limits);
    const answers = new Map<number, Array<number | null>>();
    for (const request of requests)
      answers.set(
        request.id,
        request.candidateIndices.map((index) =>
          request.listIndex === 0 && request.orders[0] === "B" && index === 0 ? null : 0.8
        )
      );
    const [first, second] = combineDecisionAnswers(lists, requests, answers, limits);
    expect(first![0]).toEqual({ probability: null, logOdds: null });
    expect(first![1]!.probability).toBeCloseTo(0.8, 12);
    // One request for the single candidate stood for both orders.
    expect(second![0]!.probability).toBeCloseTo(0.8, 12);
    expect(() => combineDecisionAnswers(lists, requests, new Map(), limits)).toThrow();
  });
});

// --- the adapter ---------------------------------------------------------------------------------

const key = "sk-proj-0123456789abcdefghij";
const taskInput: DecisionsTaskInput = {
  contract: decisionsContract,
  instruction,
  query: note("Query"),
  candidates: [note("First"), note("Second")]
};
const task = (): AiTaskRequest => decisionsTaskRequest(taskInput, limits);
const answer = (probabilities: number[], tokens = 5_406) =>
  Response.json({
    model: "gpt-6-luna",
    answers: probabilities.map((probability, index) => ({
      type: "predicate",
      name: `rel_c${index + 1}`,
      probability
    })),
    usage: { input_tokens: tokens, output_tokens: 0 }
  });
const adapterWith = (fetch: typeof globalThis.fetch, extra: Partial<typeof limits> = {}) =>
  new OpenAiDecisionsAdapter({
    apiKey: () => key,
    limits: { ...limits, ...extra },
    fetch,
    random: () => 0.5
  });

describe("the Decisions adapter", () => {
  it("posts one request to the fixed endpoint with the key, and returns the probabilities, tokens and cost", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(answer([0.9, 0.1]));
    const result = await adapterWith(fetch).run(task());
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init!.headers).toMatchObject({
      authorization: `Bearer ${key}`,
      "content-type": "application/json"
    });
    expect(JSON.parse(init!.body as string)).toEqual(
      buildDecisionsWireRequest(taskInput, "gpt-6-luna")
    );
    expect(result).toMatchObject({
      taskType: "reranking",
      output: { probabilities: [0.9, 0.1] },
      providerId: "openai-decisions",
      modelId: "gpt-6-luna",
      runtime: "remote",
      inputTokens: 5_406,
      outputTokens: 0,
      attempts: 1
    });
    // US$ 0.10 per million input tokens, the published price.
    expect(result.costEstimate).toBeCloseTo(0.0005406, 10);
    expect(decisionsCostUsd(1_000_000, defaultDecisionsLimits)).toBe(0.1);
    // The key is in the Authorization header only.
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("describes a remote reranking model on its own provider, which only its own tasks reach", () => {
    const adapter = adapterWith(vi.fn());
    expect(adapter.describe()).toMatchObject({
      providerId: "openai-decisions",
      modelId: "gpt-6-luna",
      runtime: "remote",
      capabilities: expect.arrayContaining(["reranking", "requires-api-key", "requires-network"])
    });
    expect(adapter.canHandle(task())).toBe(true);
    expect(
      adapter.canHandle({
        taskType: "reranking",
        input: JSON.stringify({ query: "q", documents: ["d"], instruction: "i" }),
        requiredCapabilities: [],
        parameters: {},
        metadata: {}
      })
    ).toBe(false);
    expect(adapter.canHandle({ ...task(), taskType: "text-generation" })).toBe(false);
  });

  it("refuses a request over the candidate limit, and a task that is not its own, before any call", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const adapter = adapterWith(fetch);
    await expect(
      adapter.run(decisionsTaskRequest({ ...taskInput, candidates: titles(21).map(note) }, limits))
    ).rejects.toThrow("errors.ai.unsupportedTask");
    await expect(adapter.run({ ...task(), input: "not a decisions request" })).rejects.toThrow(
      "errors.ai.unsupportedTask"
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a 429 after the delay Retry-After asks for, and a 5xx, then answers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
      )
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(answer([0.3, 0.6]));
    const result = await adapterWith(fetch).run(task());
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ output: { probabilities: [0.3, 0.6] }, attempts: 3 });
  });

  it("gives up after its attempts on a provider that keeps failing, as a transient network failure", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("down", { status: 503 }));
    const error = await adapterWith(fetch)
      .run(task())
      .catch((caught: unknown) => caught);
    expect(fetch).toHaveBeenCalledTimes(limits.retry.maxAttempts);
    expect(error).toMatchObject({ status: 503, transient: true });
    expect(classifyDecisionsFailure(error)).toBe("network");
  });

  it("does not retry a refused key or an exhausted quota, and tells them apart", async () => {
    const refused = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("invalid api key", { status: 401 }));
    const unauthorized = await adapterWith(refused)
      .run(task())
      .catch((caught: unknown) => caught);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(classifyDecisionsFailure(unauthorized)).toBe("invalid_key");

    const quota = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 }));
    const exhausted = await adapterWith(quota)
      .run(task())
      .catch((caught: unknown) => caught);
    expect(quota).toHaveBeenCalledTimes(1);
    expect(classifyDecisionsFailure(exhausted)).toBe("quota");

    const invalid = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("bad request", { status: 400 }));
    const rejected = await adapterWith(invalid)
      .run(task())
      .catch((caught: unknown) => caught);
    expect(invalid).toHaveBeenCalledTimes(1);
    expect(classifyDecisionsFailure(rejected)).toBe("error");
  });

  it("never lets the key into an error: a provider that echoes it is redacted", async () => {
    const echo = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(`Incorrect API key provided: ${key}. Authorization: Bearer ${key}`, {
        status: 401
      })
    );
    const error = (await adapterWith(echo)
      .run(task())
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain(key);
    expect(error.message).not.toContain("0123456789abcdefghij");
    expect(error.message).toContain("[redacted]");
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError(`fetch failed for ${key}`));
    const failure = (await adapterWith(transport, { retry: { ...limits.retry, maxAttempts: 1 } })
      .run(task())
      .catch((caught: unknown) => caught)) as Error;
    expect(String(failure.message)).not.toContain(key);
    expect(redactDecisionsSecrets(`x ${key} y Bearer abc.def`, key)).toBe(
      "x [redacted] y Bearer [redacted]"
    );
    expect(cleanDecisionsError(new Error("plain"), key)).toMatchObject({ message: "plain" });
  });

  it("fails a response that is not JSON, does not match the schema or is too large, without a retry", async () => {
    for (const response of [
      () => new Response("<html>", { status: 200 }),
      () => Response.json({ answers: "none" }),
      () =>
        new Response("x".repeat(100), { status: 200, headers: { "content-length": "9999999999" } })
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response());
      await expect(adapterWith(fetch).run(task())).rejects.toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("stops at the caller's abort without a retry", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      controller.abort(new Error("canceled"));
      throw init?.signal?.reason ?? new Error("aborted");
    });
    await expect(adapterWith(fetch).run(task(), controller.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the Decisions lane and its breaker", () => {
  it("runs on a remote lane of its own, which opens after consecutive transient failures and fails new calls fast", async () => {
    const scheduler = createAiScheduler(resolveAiLaneRuntimeConfig({}, { environment: {} }));
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response("down", { status: 503 }));
    const adapter = adapterWith(fetch);
    const lane = decisionsLaneKey(limits);
    expect(lane).toBe("remote:openai-decisions");
    const call = () =>
      scheduler.run(
        {
          lane,
          remoteKind: "api-key",
          priority: "P2",
          workloadClass: "decide",
          label: "decisions"
        },
        (permit) => {
          const signal = AbortSignal.any([]);
          bindLanePermit(signal, permit);
          return adapter.run(task(), signal);
        }
      );
    // Four attempts per call, five failures in a row open the breaker (typed lane config).
    await expect(call()).rejects.toMatchObject({ status: 503 });
    await expect(call()).rejects.toMatchObject({ status: 503 });
    const refused = await call().catch((caught: unknown) => caught);
    expect(refused).toBeInstanceOf(ProviderUnavailableError);
    expect(classifyDecisionsFailure(refused)).toBe("breaker_open");
    expect(scheduler.snapshot().find((entry) => entry.lane === lane)?.breaker).toMatchObject({
      state: "open",
      refused: 1
    });
    // Eight requests were sent for two calls; the refused one sent none.
    expect(fetch).toHaveBeenCalledTimes(8);
  });
});

describe("cassettes of Decisions requests", () => {
  it("records a request with its answer, replays it with no network and no key, and holds no key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decisions-cassette-"));
    try {
      const recordFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(answer([0.75, 0.05]));
      const recorder = new AiCassette({ mode: "record", directory });
      const recorded = await recorder.wrap(adapterWith(recordFetch)).run(task());
      expect(recordFetch).toHaveBeenCalledTimes(1);
      expect(recorder.stats()).toMatchObject({ recorded: 1, served: 0 });

      // A replay needs no key and never reaches the provider: the key is no part of the entry.
      const neverFetch = vi.fn<typeof globalThis.fetch>();
      const keyless = new OpenAiDecisionsAdapter({
        apiKey: () => {
          throw new Error("a replay reads no key");
        },
        limits,
        fetch: neverFetch
      });
      const replayer = new AiCassette({ mode: "replay", directory });
      const replayed = await replayer.wrap(keyless).run(task());
      expect(neverFetch).not.toHaveBeenCalled();
      expect(replayed.output).toEqual(recorded.output);
      // The recorded token counts come back; the recorded cost does not: nothing was spent.
      expect(replayed).toMatchObject({
        inputTokens: 5_406,
        tokenUsage: { [aiCassetteReplayedUsageKey]: 1 }
      });
      expect(replayed.costEstimate).toBeUndefined();
      expect(recorded.costEstimate).toBeCloseTo(0.0005406, 10);
      expect(replayer.stats()).toMatchObject({ served: 1, misses: 0 });

      for (const file of await readdir(directory, { recursive: true })) {
        if (!file.endsWith(".json")) continue;
        const text = await readFile(join(directory, file), "utf8");
        expect(text).not.toContain(key);
        expect(text).not.toMatch(/Bearer|authorization/iu);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keys a request by its content: another candidate order is a miss, and the key does not depend on the secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decisions-cassette-"));
    try {
      const recorder = new AiCassette({ mode: "record", directory });
      await recorder
        .wrap(adapterWith(vi.fn<typeof globalThis.fetch>().mockResolvedValue(answer([0.5, 0.5]))))
        .run(task());
      const replayer = new AiCassette({ mode: "replay", directory });
      const adapter = replayer.wrap(adapterWith(vi.fn()));
      const reordered = decisionsTaskRequest(
        { ...taskInput, candidates: [...taskInput.candidates].reverse() },
        limits
      );
      await expect(adapter.run(reordered)).rejects.toBeInstanceOf(AiCassetteMissError);
      await expect(adapter.run(task())).resolves.toMatchObject({
        output: { probabilities: [0.5, 0.5] }
      });
      const first = aiCassetteRequestKey(adapterWith(vi.fn()).describe(), task());
      const second = aiCassetteRequestKey(
        new OpenAiDecisionsAdapter({ apiKey: () => "another-key-value", limits }).describe(),
        task()
      );
      expect(second.key).toBe(first.key);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("registers under the DEV decorator, so the cassette wraps the adapter the service runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "decisions-cassette-"));
    try {
      const cassette = new AiCassette({ mode: "record", directory });
      setAiAdapterDecorator((adapter) => cassette.wrap(adapter));
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(answer([0.4, 0.6]));
      const held = new AiModelRegistry().register(adapterWith(fetch));
      await held.run(task());
      expect(cassette.stats()).toMatchObject({ recorded: 1 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      setAiAdapterDecorator(null);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
