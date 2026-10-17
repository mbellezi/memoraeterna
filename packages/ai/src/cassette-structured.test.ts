import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toStrictJsonSchema, type AiOutputSchema } from "@app/domain";
import { z } from "zod";

import {
  AiCassette,
  AiCassetteMissError,
  aiCassetteRequestKey,
  readAiCassetteLocalMisses,
  resolveAiCassetteConfig,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult
} from "./index.js";

const outputSchema = toStrictJsonSchema(
  z.object({ verdict: z.enum(["same", "different"]) }).strict(),
  "pair_verdict"
) as AiOutputSchema;

const remote: AiModelDescriptor = {
  providerId: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  capabilities: ["structured-output"],
  parameterCapabilities: {},
  limits: {},
  requirements: { network: true }
};
const local: AiModelDescriptor = {
  providerId: "local-mlx",
  modelId: "qwen-local",
  runtime: "local",
  capabilities: ["structured-output", "offline"],
  parameterCapabilities: {},
  limits: {},
  requirements: { adapter: "mlx-swift-lm", repository: "mlx-community/qwen", revision: "r1" }
};

const request = (overrides: Partial<AiTaskRequest> = {}): AiTaskRequest => ({
  taskType: "structured-output",
  input: "Decide whether the notes say the same thing.",
  modelId: "gpt-test",
  requiredCapabilities: [],
  parameters: { maxTokens: 500 },
  metadata: { applicationInstruction: "Return JSON only." },
  ...overrides
});

class FakeAdapter implements AiModelAdapter {
  public calls = 0;
  public constructor(private readonly description: AiModelDescriptor) {}
  public describe() {
    return this.description;
  }
  public canHandle() {
    return true;
  }
  public async run(input: AiTaskRequest): Promise<AiTaskResult> {
    this.calls += 1;
    return {
      taskType: input.taskType,
      output: `{"verdict":"same"}`,
      providerId: this.description.providerId,
      modelId: this.description.modelId,
      runtime: this.description.runtime,
      durationMs: 7,
      inputTokens: 10,
      outputTokens: 2
    };
  }
}

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memora-cassette-structured-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the cassette key and the output schema (D35, C2)", () => {
  it("ignores the request's output schema, so recorded entries keep serving", () => {
    expect(aiCassetteRequestKey(remote, request({ outputSchema })).key).toBe(
      aiCassetteRequestKey(remote, request()).key
    );
  });

  it("keeps the recorded key of the legacy metadata schema, which still takes part", () => {
    const legacy = request({ metadata: { applicationInstruction: "x", outputSchema: { a: 1 } } });
    expect(aiCassetteRequestKey(remote, legacy).key).not.toBe(
      aiCassetteRequestKey(remote, request()).key
    );
  });

  it("keeps the keys of fixed requests byte for byte (a change here invalidates recorded cassettes)", () => {
    expect(aiCassetteRequestKey(remote, request()).key).toBe(
      "269aa66b037eb90e13657c7f383857b0ef2ebc9574c3e8ce108ad892fa01be2a"
    );
    expect(
      aiCassetteRequestKey(
        local,
        request({
          taskType: "knowledge-graph-generation",
          modelId: "qwen-local",
          input: "Extract entities.\n[c1]\nText.",
          parameters: { temperature: 0.7, topK: 20, topP: 0.8, maxTokens: 16384 },
          metadata: {}
        })
      ).key
    ).toBe("cac58084776139899388fe7b1014942351420c3d4dca9dd3e9025620fd4c0fcd");
    expect(
      aiCassetteRequestKey(
        remote,
        request({
          taskType: "embedding",
          input: "A chunk of text.",
          parameters: { dimensions: 768 }
        })
      ).key
    ).toBe("a18a7eba7fcb9b673785a07da239794322223e28d81e5347504ce3e08453b1cd");
  });

  it("stores the schema in the entry body for audit and serves the answer without it", async () => {
    const cassette = new AiCassette({ mode: "record", directory });
    const adapter = new FakeAdapter(remote);
    await cassette.wrap(adapter).run(request({ outputSchema }));
    const key = aiCassetteRequestKey(remote, request()).key;
    const entry = JSON.parse(
      await readFile(join(directory, "entries", key.slice(0, 2), `${key}.json`), "utf8")
    ) as { outputSchema?: unknown; key: string };
    expect(entry.key).toBe(key);
    expect(entry.outputSchema).toEqual(outputSchema);
    const replay = new AiCassette({ mode: "replay", directory });
    const served = await replay.wrap(new FakeAdapter(remote)).run(request());
    expect(served.output).toBe(`{"verdict":"same"}`);
    expect(replay.stats()).toMatchObject({ served: 1, misses: 0 });
  });
});

describe("the local-miss replay policy (D41)", () => {
  const record = async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    await recorder.wrap(new FakeAdapter(remote)).run(request());
  };

  it("fails a local miss by default", async () => {
    await record();
    const replay = new AiCassette({ mode: "replay", directory });
    const adapter = new FakeAdapter(local);
    await expect(
      replay.wrap(adapter).run(request({ modelId: "qwen-local", input: "A new local request" }))
    ).rejects.toBeInstanceOf(AiCassetteMissError);
    expect(adapter.calls).toBe(0);
    expect(replay.stats()).toMatchObject({ misses: 1 });
  });

  it("runs a local miss live under the live policy, records it in the copy and counts it by task", async () => {
    await record();
    const replay = new AiCassette({ mode: "replay", directory, localMisses: "live" });
    const adapter = new FakeAdapter(local);
    const wrapped = replay.wrap(adapter);
    const missing = request({ modelId: "qwen-local", input: "A new local request" });
    await expect(wrapped.run(missing)).resolves.toMatchObject({ output: `{"verdict":"same"}` });
    expect(adapter.calls).toBe(1);
    expect(replay.stats()).toMatchObject({
      misses: 0,
      recorded: 0,
      liveLocalMisses: 1,
      byTask: { "structured-output": { liveLocalMisses: 1, misses: 0 } }
    });
    // The copy holds the answer now: a second replay serves it with no live call.
    const second = new AiCassette({ mode: "replay", directory });
    const again = new FakeAdapter(local);
    await second.wrap(again).run(missing);
    expect(again.calls).toBe(0);
    expect(second.stats()).toMatchObject({ served: 1, misses: 0, liveLocalMisses: 0 });
  });

  it("still fails a remote miss under the live policy", async () => {
    await record();
    const replay = new AiCassette({ mode: "replay", directory, localMisses: "live" });
    const adapter = new FakeAdapter(remote);
    await expect(
      replay.wrap(adapter).run(request({ input: "A new remote request" }))
    ).rejects.toBeInstanceOf(AiCassetteMissError);
    expect(adapter.calls).toBe(0);
    expect(replay.stats()).toMatchObject({ misses: 1, liveLocalMisses: 0 });
  });

  it("is read from the environment, defaults to failing and rejects other values", () => {
    expect(readAiCassetteLocalMisses({})).toBe("fail");
    expect(readAiCassetteLocalMisses({ MEMORA_AI_CASSETTE_LOCAL_MISSES: " live " })).toBe("live");
    expect(() => readAiCassetteLocalMisses({ MEMORA_AI_CASSETTE_LOCAL_MISSES: "always" })).toThrow(
      expect.objectContaining({ code: "invalid_local_misses" })
    );
    const base = { isPackaged: false, baseDirectory: "/repo" };
    expect(
      resolveAiCassetteConfig(
        {
          MEMORA_AI_CASSETTE: "replay",
          MEMORA_AI_CASSETTE_DIR: ".cache/golden/cassettes/a",
          MEMORA_AI_CASSETTE_LOCAL_MISSES: "live"
        },
        base
      )
    ).toEqual({
      mode: "replay",
      directory: "/repo/.cache/golden/cassettes/a",
      localMisses: "live"
    });
    // A packaged build refuses cassettes altogether, whatever the policy says.
    expect(() =>
      resolveAiCassetteConfig(
        {
          MEMORA_AI_CASSETTE: "replay",
          MEMORA_AI_CASSETTE_DIR: ".cache/x",
          MEMORA_AI_CASSETTE_LOCAL_MISSES: "live"
        },
        { ...base, isPackaged: true }
      )
    ).toThrow(expect.objectContaining({ code: "packaged_build" }));
  });
});

/**
 * Opt-in check against the cassettes on disk (they are git-ignored library data): the keys of 200
 * sampled entries, recomputed by the current key function from the canonical request each entry
 * stores, equal the keys they were recorded under. Point `MEMORA_CASSETTE_KEY_SAMPLE` at one or
 * more cassette folders (comma separated).
 */
const sampleFolders = (process.env.MEMORA_CASSETTE_KEY_SAMPLE ?? "")
  .split(",")
  .map((folder) => folder.trim())
  .filter((folder) => folder && existsSync(join(folder, "cassette.json")));

describe.skipIf(sampleFolders.length === 0)("recorded cassette keys (sampled from disk)", () => {
  it("are unchanged for 200 sampled entries per cassette", () => {
    for (const folder of sampleFolders) {
      const files = readdirSync(join(folder, "entries"), { recursive: true })
        .map(String)
        .filter((name) => name.endsWith(".json"))
        .sort();
      const stride = Math.max(1, Math.floor(files.length / 200));
      const sample = files.filter((_name, index) => index % stride === 0).slice(0, 200);
      expect(sample.length).toBeGreaterThan(0);
      for (const name of sample) {
        const entry = JSON.parse(readFileSync(join(folder, "entries", name), "utf8")) as {
          key: string;
          request: {
            taskType: AiTaskRequest["taskType"];
            model: Record<string, string | undefined>;
            parameters: Record<string, unknown>;
            input: unknown;
            instruction: string | null;
            schema: unknown;
          };
        };
        const { model, instruction, schema } = entry.request;
        const rebuilt = aiCassetteRequestKey(
          {
            providerId: model.providerId!,
            modelId: model.modelId!,
            runtime: model.runtime as "remote" | "local" | "sidecar",
            capabilities: [],
            parameterCapabilities: {},
            limits: {},
            requirements: {
              ...(model.adapter ? { adapter: model.adapter } : {}),
              ...(model.repository ? { repository: model.repository } : {}),
              ...(model.revision ? { revision: model.revision } : {}),
              ...(model.quantization ? { quantization: model.quantization } : {})
            }
          },
          {
            taskType: entry.request.taskType,
            input: entry.request.input,
            modelId: model.modelId!,
            requiredCapabilities: [],
            parameters: entry.request.parameters,
            metadata: {
              ...(instruction ? { applicationInstruction: instruction } : {}),
              ...(schema ? { outputSchema: schema } : {})
            }
          }
        );
        expect(rebuilt.key, `${folder} ${name}`).toBe(entry.key);
      }
    }
  });
});
