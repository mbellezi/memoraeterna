import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MlxAdapter, type MlxHelperHost } from "@app/ai";
import {
  grammarSchemaForContract,
  outputSchemaForContract,
  relationTypingCallSchema,
  relationTypingLimits,
  relationTypingOutputSchema,
  toGrammarJsonSchema,
  type AiOutputContract
} from "@app/domain";

import { AiService, type AiTaskLogContext } from "./ai-service.js";
import { renderPrompt } from "./prompt-runtime.js";
import {
  confirmMatchGroup,
  relationMatchCallSchema,
  relationMatchOutputSchema,
  type RelationMatchRow
} from "./relation-type-resolution.js";
import {
  typeRelationPairs,
  type TyperRoute,
  type TypingNote
} from "./relations/relation-typing.js";

/**
 * The call's own grammar (F4 D24 follow-up to T99): every identity confirmation (entity and relation
 * type) and every typing call that reaches an MLX helper announcing `schema` carries the schema of
 * that call's rows or pairs, first asks and repairs alike; the pinned path keeps the contract's static
 * grammar; and a remote runtime is sent exactly what it was sent before, byte for byte (D1).
 */

const state = vi.hoisted(() => ({
  selections: new Map<string, Record<string, unknown>>(),
  models: new Map<string, Record<string, unknown>>(),
  record: vi.fn()
}));
vi.mock("@app/db", async () => ({
  ...(await vi.importActual("@app/db")),
  createAiConfigRepository: () => ({
    getDefaultTask: async (task: string) => state.selections.get(task) ?? null,
    recordTaskRun: state.record
  }),
  createLocalModelRepository: () => ({
    findById: async (id: string) => state.models.get(id) ?? null
  })
}));

const ids = {
  remoteProfile: "00000000-0000-4000-8000-000000000001",
  codexConfig: "00000000-0000-4000-8000-0000000000c1",
  localProfile: "00000000-0000-4000-8000-000000000002",
  localModel: "00000000-0000-4000-8000-0000000000a1"
};
const capabilities = [
  "text-generation",
  "structured-output",
  "knowledge-graph-generation",
  "offline"
];
const remoteSelection = {
  profileId: ids.remoteProfile,
  providerConfigId: ids.codexConfig,
  localModelId: null,
  provider: "openai-codex",
  modelId: "writer",
  runtime: "remote",
  revision: null,
  repository: null,
  quantization: null,
  baseUrl: "https://chatgpt.com/backend-api/codex",
  parameters: {},
  modelDefaultParameters: {},
  providerMetadata: {},
  requiredCapabilities: ["structured-output"]
};
const localSelection = {
  ...remoteSelection,
  profileId: ids.localProfile,
  providerConfigId: null,
  localModelId: ids.localModel,
  provider: "local-mlx",
  modelId: "local-writer",
  runtime: "mlx",
  baseUrl: null
};

/** What a helper was sent: the prompt and the schema of each `generate`. */
interface Generation {
  prompt: string;
  schema: Record<string, unknown> | undefined;
}

/** A shared helper host that announced `capabilities` and answers each prompt with `answer`. */
function helperHost(
  announced: readonly string[],
  answer: (prompt: string) => string,
  generations: Generation[]
): MlxHelperHost {
  const host = {
    capabilities: new Set(announced),
    supports: (capability: string) => announced.includes(capability),
    loadedModel: () => "/models/local-writer",
    generate: async (input: { prompt: string; schema?: Record<string, unknown> }) => {
      generations.push({ prompt: input.prompt, schema: input.schema });
      return {
        protocolVersion: 1,
        requestId: randomUUID(),
        ok: true,
        output: answer(input.prompt),
        durationMs: 1,
        ...(input.schema ? { schemaMode: "grammar" } : {})
      };
    },
    dispose: async () => undefined
  };
  return host as unknown as MlxHelperHost;
}

/** The AI service with the writer tasks on one route: the MLX writer, or Codex. */
function service(
  route: "local" | "remote",
  answer: (prompt: string) => string,
  announced: readonly string[] = ["cancel", "schema", "stream", "unload"]
) {
  const generations: Generation[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const monitoring = {
    start: vi.fn<(input: Record<string, unknown>) => Promise<{ id: string; full: boolean }>>(
      async () => ({ id: "capture", full: false })
    ),
    finish: vi.fn(async () => undefined)
  };
  const selection = route === "local" ? localSelection : remoteSelection;
  for (const task of ["knowledge-graph-generation", "structured-output"])
    state.selections.set(task, { ...selection, requiredCapabilities: [task] });
  const ai = new AiService({
    userDataPath: "/tmp/call-output-schema-tests",
    getPool: () => ({}) as never,
    workspaceRoot: "/tmp",
    resourcesPath: "/tmp",
    isPackaged: false,
    monitoring: monitoring as never
  });
  const internals = ai as unknown as {
    createAdapter: () => Promise<unknown>;
    createLocalAdapter: () => Promise<unknown>;
    registerAdapter: (adapter: unknown) => unknown;
  };
  const mlx = new MlxAdapter({
    modelId: "local-writer",
    modelPath: "/models/local-writer",
    helperPath: "/helper",
    capabilities: [...capabilities] as never,
    host: helperHost(announced, answer, generations)
  });
  const codex = {
    describe: () => ({
      providerId: "openai-codex",
      modelId: "writer",
      runtime: "remote",
      capabilities,
      parameterCapabilities: { maxTokens: { min: 1, max: 16384 } }
    }),
    canHandle: () => true,
    run: vi.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      return {
        taskType: request.taskType,
        output: answer(String(request.input)),
        providerId: "openai-codex",
        modelId: "writer",
        runtime: "remote",
        durationMs: 1,
        schemaMode: request.outputSchema ? "strict" : "none"
      };
    })
  };
  vi.spyOn(internals, "createAdapter").mockImplementation(async () =>
    internals.registerAdapter(codex)
  );
  vi.spyOn(internals, "createLocalAdapter").mockImplementation(async () =>
    internals.registerAdapter(mlx)
  );
  // Every call a caller makes, as it made it: the prompt, the context and the limits it stated.
  const stated: Array<{
    task: Parameters<AiService["runDefaultTask"]>[0];
    prompt: string;
    context: AiTaskLogContext;
    limits: { maxOutputTokens: number } | undefined;
  }> = [];
  const run = ai.runDefaultTask.bind(ai);
  vi.spyOn(ai, "runDefaultTask").mockImplementation(
    async (task, prompt, context, signal, limits) => {
      stated.push({ task, prompt, context: context ?? {}, limits });
      return run(task, prompt, context, signal, limits);
    }
  );
  /** What the service sent and recorded for each call: the request, the monitoring and audit rows. */
  const sent = () => ({
    requests: requests.map((request) => JSON.stringify(request)),
    monitoring: monitoring.start.mock.calls.map(([input]) => JSON.stringify(input.context)),
    audit: state.record.mock.calls.map(([row]) => JSON.stringify(withoutTimes(row)))
  });
  return { ai, generations, requests, stated, run, sent };
}

/** An audit row without the times and durations it measured. */
function withoutTimes(row: unknown): unknown {
  return Object.fromEntries(
    Object.entries(row as Record<string, unknown>).filter(
      ([key]) => !/(Ms|At|duration)$/u.test(key)
    )
  );
}

const row = (key: string, candidates: string[]): RelationMatchRow => ({
  key,
  predicate: `Concept: ${key}`,
  definition: `Definition of ${key}.`,
  candidates: candidates.map((candidate) => ({
    key: candidate,
    predicate: `Concept: ${candidate}`,
    definition: `Definition of ${candidate}.`
  }))
});
// r3 lists r1, an earlier row's provisional identity (F4 D20); r4 has no candidate of its own.
const rows = [row("r1", ["c1", "c2"]), row("r2", ["c3"]), row("r3", ["r1", "c4"]), row("r4", [])];

/** A first answer that decides r1 only, then the repair's answer for the rest. */
const repairs = ["graph.entity_identity.repair", "graph.relation_identity.repair"].map((id) =>
  renderPrompt(id).trim()
);
const confirmationAnswers = () => (prompt: string) =>
  repairs.some((repair) => prompt.includes(repair))
    ? '{"matches":[["r2","c3"],["r3","r1"],["r4",null]]}'
    : '{"matches":[["r1","c2"]]}';

const confirm = (
  ai: AiService,
  options: { entityIdentity: boolean; pinned?: boolean; group?: RelationMatchRow[] }
) =>
  confirmMatchGroup({
    ai,
    group: options.group ?? rows,
    entityIdentity: options.entityIdentity,
    context: { sourceItemId: "00000000-0000-4000-8000-0000000000f1" },
    promptVersion: "relation-type-resolution-v1",
    stage: options.entityIdentity ? "entity_identity_resolution" : "relation_type_resolution",
    pinned: options.pinned ?? false,
    invalidOutputError: "errors.entityIdentity.invalidOutput"
  });

const note = (title: string): TypingNote => {
  const text = `${title}\nIdea of ${title}`;
  return { id: randomUUID(), text, hash: `hash-${title}` };
};
const typingPairs = ["A", "B", "C"].map((letter) => ({
  first: note(`${letter} one`),
  second: note(`${letter} two`),
  band: "apply" as const
}));
/** p2 is left out of the first answer, so the re-ask asks it alone under its own id. */
const typingAnswer = (prompt: string) =>
  prompt.includes("The previous answer was missing or invalid")
    ? '{"pairs":[{"p":"p2","t":"extends","d":"ab"}]}'
    : '{"pairs":[{"p":"p1","t":"supports","d":"ab"},{"p":"p3","t":"none","d":"none"}]}';
const typerRoute = (lane: "local" | "remote"): TyperRoute => ({
  lane,
  provider: lane === "local" ? "local-mlx" : "openai-codex",
  modelId: lane === "local" ? "local-writer" : "writer",
  runtime: lane === "local" ? "mlx" : "remote",
  repository: null,
  revision: null,
  quantization: null,
  parameters: {}
});
const typeAll = (ai: AiService, lane: "local" | "remote") =>
  typeRelationPairs(
    { ai, store: null, resolveRoute: async () => typerRoute(lane), contentLanguage: "en" },
    typingPairs
  );

beforeEach(() => {
  state.record.mockReset().mockResolvedValue("run-id");
  state.selections.clear();
  state.models.clear();
  state.models.set(ids.localModel, {
    id: ids.localModel,
    catalogId: null,
    capabilities: ["text-generation", "offline"]
  });
});
afterEach(() => vi.restoreAllMocks());

describe("an MLX helper that announces schema", () => {
  it.each([
    [true, "entity_identity"],
    [false, "relation_identity"]
  ] as const)(
    "decodes every confirmation call under its own rows' grammar (entity identity %s)",
    async (entityIdentity, name) => {
      const { ai, generations } = service("local", confirmationAnswers());
      const decisions = await confirm(ai, { entityIdentity });
      expect(decisions.size).toBe(4);
      // The first ask and the repair, each with the schema of exactly the rows it asks.
      const asked = [rows, rows.slice(1)];
      expect(generations).toHaveLength(2);
      generations.forEach((generation, index) =>
        expect(generation.schema).toEqual(
          toGrammarJsonSchema(relationMatchCallSchema(asked[index]!), name)!.schema
        )
      );
      const matches = (generations[1]!.schema as { properties: { matches: unknown } }).properties
        .matches;
      expect(matches).toMatchObject({ items: false, minItems: 3, maxItems: 3 });
      expect((matches as { prefixItems: unknown[] }).prefixItems).toEqual([
        {
          type: "array",
          prefixItems: [
            { type: "string", const: "r2" },
            { anyOf: [{ type: "string", enum: ["c3"] }, { type: "null" }] }
          ],
          items: false,
          minItems: 2,
          maxItems: 2
        },
        {
          type: "array",
          prefixItems: [
            { type: "string", const: "r3" },
            { anyOf: [{ type: "string", enum: ["r1", "c4"] }, { type: "null" }] }
          ],
          items: false,
          minItems: 2,
          maxItems: 2
        },
        {
          type: "array",
          prefixItems: [{ type: "string", const: "r4" }, { type: "null" }],
          items: false,
          minItems: 2,
          maxItems: 2
        }
      ]);
    }
  );

  it("decodes every typing call under its own pairs' grammar, the re-ask included", async () => {
    const { ai, generations } = service("local", typingAnswer);
    const result = await typeAll(ai, "local");
    expect(result.calls).toBe(2);
    expect(generations.map((generation) => generation.schema)).toEqual([
      toGrammarJsonSchema(relationTypingCallSchema(["p1", "p2", "p3"]), "relation_typing")!.schema,
      toGrammarJsonSchema(relationTypingCallSchema(["p2"]), "relation_typing")!.schema
    ]);
  });

  it("keeps the contract's static grammar on the pinned path", async () => {
    const answer = '{"matches":[["r1","c2"],["r2","c3"],["r3","r1"],["r4",null]]}';
    const { ai, generations } = service("local", () => answer);
    await confirm(ai, { entityIdentity: true, pinned: true });
    expect(generations.map((generation) => generation.schema)).toEqual([
      grammarSchemaForContract({ name: "entity_identity", contract: relationMatchOutputSchema })!
        .schema
    ]);
  });

  it("sends no schema to a helper that did not announce it, as before", async () => {
    const { ai, generations } = service("local", confirmationAnswers(), ["cancel", "stream"]);
    await confirm(ai, { entityIdentity: true });
    expect(generations).toHaveLength(2);
    expect(generations.every((generation) => generation.schema === undefined)).toBe(true);
  });
});

describe("a remote runtime is sent what it was sent before (D1)", () => {
  /** The context a caller stated with its call contract taken out: what T99's callers stated. */
  const withoutCallContract = (context: AiTaskLogContext): AiTaskLogContext => {
    const contract = context.outputContract as AiOutputContract;
    expect(contract.callContract).toBeDefined();
    return { ...context, outputContract: { name: contract.name, contract: contract.contract } };
  };

  it.each([true, false])(
    "sends a confirmation no schema, byte for byte the request without the call contract (entity identity %s)",
    async (entityIdentity) => {
      const { ai, requests, stated, run, sent } = service("remote", confirmationAnswers());
      await confirm(ai, { entityIdentity });
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request).not.toHaveProperty("outputSchema");
      const now = sent();
      // The static contract is the one T99 stated: identity's tuple never reaches Codex as a schema.
      expect(
        outputSchemaForContract({
          name: entityIdentity ? "entity_identity" : "relation_identity",
          contract: relationMatchOutputSchema
        })
      ).toBeNull();
      for (const call of stated.splice(0))
        await run(
          call.task,
          call.prompt,
          withoutCallContract(call.context),
          undefined,
          call.limits
        );
      expect(requests).toHaveLength(4);
      const all = sent();
      expect(now.monitoring).toHaveLength(2);
      expect(now.audit).toHaveLength(2);
      for (const kind of ["requests", "monitoring", "audit"] as const)
        expect(all[kind].slice(2)).toEqual(now[kind]);
    }
  );

  it("sends a typing call the batch-size strict schema, byte for byte the request without the call contract", async () => {
    const { ai, requests, stated, run, sent } = service("remote", typingAnswer);
    await typeAll(ai, "remote");
    expect(requests).toHaveLength(2);
    const strict = outputSchemaForContract({
      name: "relation_typing",
      contract: relationTypingOutputSchema(relationTypingLimits.pairsPerCall)
    });
    expect(strict).not.toBeNull();
    for (const request of requests) expect(request.outputSchema).toEqual(strict);
    const now = sent();
    for (const call of stated.splice(0))
      await run(call.task, call.prompt, withoutCallContract(call.context), undefined, call.limits);
    const all = sent();
    for (const kind of ["requests", "monitoring", "audit"] as const)
      expect(all[kind].slice(2)).toEqual(now[kind]);
  });
});
