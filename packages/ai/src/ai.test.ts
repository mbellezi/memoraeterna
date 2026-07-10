import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  AiModelRegistry,
  GoogleGeminiAdapter,
  MlxAdapter,
  NodeLlamaCppAdapter,
  OpenAiCompatibleAdapter,
  detectLocalRuntimeCompatibility,
  downloadLocalModel,
  localModelCatalog,
  localModelCatalogEntrySchema,
  localModelExpectedSize,
  redactSensitiveText
} from "./index.js";

describe("AI adapters", () => {
  it("negotiates capabilities", () => {
    const registry = new AiModelRegistry();
    registry.register(new OpenAiCompatibleAdapter({
      baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "model",
      capabilities: ["text-generation", "requires-network"]
    }));
    expect(registry.list(["text-generation"])).toHaveLength(1);
    expect(() => registry.resolve({ requiredCapabilities: ["embedding"] })).toThrow("errors.ai.noCompatibleModel");
  });

  it("runs an OpenAI-compatible embedding request without exposing the key in the result", async () => {
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "embed",
      capabilities: ["embedding"],
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
      }
    });
    const result = await adapter.run({
      taskType: "embedding", input: "hello", modelId: "embed",
      requiredCapabilities: ["embedding"], parameters: {}, metadata: {}
    });
    expect(result.output).toEqual([0.1, 0.2]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("maps canonical generation parameters to remote provider contracts", async () => {
    let openAiBody: Record<string, unknown> = {};
    const openAi = new OpenAiCompatibleAdapter({
      baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "reasoning-model",
      capabilities: ["text-generation"],
      fetch: async (_input, init) => {
        openAiBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
      }
    });
    await openAi.run({
      taskType: "text-generation", input: "hello", requiredCapabilities: ["text-generation"],
      parameters: { maxTokens: 512, temperature: 0.3, topP: 0.9, reasoningLevel: "high" }, metadata: {}
    });
    expect(openAiBody).toMatchObject({
      max_tokens: 512, temperature: 0.3, top_p: 0.9, reasoning_effort: "high"
    });
    expect(openAiBody).not.toHaveProperty("maxTokens");

    let googleBody: { generationConfig?: Record<string, unknown> } = {};
    const google = new GoogleGeminiAdapter({
      apiKey: "secret", modelId: "gemini-3.5-flash", capabilities: ["text-generation"],
      fetch: async (_input, init) => {
        googleBody = JSON.parse(String(init?.body)) as typeof googleBody;
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
      }
    });
    await google.run({
      taskType: "text-generation", input: "hello", requiredCapabilities: ["text-generation"],
      parameters: { maxTokens: 256, reasoningLevel: "low" }, metadata: {}
    });
    expect(googleBody.generationConfig).toMatchObject({
      maxOutputTokens: 256,
      thinkingConfig: { thinkingLevel: "low" }
    });
  });

  it("streams remote generation progress without exposing partial output in events", async () => {
    let requestBody: Record<string, unknown> = {};
    const encoder = new TextEncoder();
    const adapter = new OpenAiCompatibleAdapter({
      baseUrl: "https://example.test/v1", apiKey: "secret", modelId: "streaming-model",
      capabilities: ["text-generation", "streaming"],
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello "}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"world"}}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
    });
    const progress: number[] = [];
    const result = await adapter.runStreaming!({
      taskType: "text-generation", input: "hello", requiredCapabilities: ["text-generation"],
      parameters: { maxTokens: 64 }, metadata: {}
    }, undefined, (event) => progress.push(event.progress));
    expect(requestBody).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(result.output).toBe("hello world");
    expect(result.outputTokens).toBe(2);
    expect(progress.at(-1)).toBe(1);
  });

  it("keeps the local catalog pinned, checksummed and without unvalidated multimodal capabilities", () => {
    expect(localModelCatalog).toHaveLength(5);
    const embeddingModels = localModelCatalog.filter((entry) => entry.capabilities.includes("embedding"));
    expect(embeddingModels.map((entry) => entry.id)).toEqual([
      "gguf-qwen3-embedding-0.6b-q8-0",
      "gguf-bge-m3-q8-0"
    ]);
    expect(embeddingModels.every((entry) => entry.defaultParameters.dimensions === 1_024)).toBe(true);
    for (const entry of localModelCatalog) {
      expect(entry.revision).toMatch(/^[a-f0-9]{40}$/);
      expect(localModelExpectedSize(entry)).toBeGreaterThan(200_000_000);
      expect(entry.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
      expect(entry.capabilities).not.toContain("image-understanding");
    }
  });

  it("detects MLX platform and memory compatibility without hiding unsupported models", () => {
    expect(detectLocalRuntimeCompatibility({
      runtime: "mlx", platform: "darwin", arch: "arm64",
      totalMemoryBytes: 16, minimumMemoryBytes: 8
    })).toEqual({ compatible: true, reason: "compatible" });
    expect(detectLocalRuntimeCompatibility({
      runtime: "mlx", platform: "linux", arch: "x64",
      totalMemoryBytes: 16, minimumMemoryBytes: 8
    }).reason).toBe("unsupported_platform");
    expect(detectLocalRuntimeCompatibility({
      runtime: "gguf", platform: "linux", arch: "x64",
      totalMemoryBytes: 4, minimumMemoryBytes: 8
    }).reason).toBe("insufficient_memory");
  });

  it("resumes ranged model downloads and atomically verifies SHA-256", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-model-download-"));
    const bytes = new TextEncoder().encode("verified model bytes");
    const entry = localModelCatalogEntrySchema.parse({
      id: "test-model", displayName: "Test", family: "Test", variant: "Test",
      runtime: "mlx", repository: "example/model", revision: "a".repeat(40),
      format: "safetensors", quantization: "4-bit", capabilities: ["offline"],
      minimumMemoryBytes: 1, recommendedMemoryBytes: 1, license: "Test",
      licenseUrl: "https://example.test/license", requiresLicenseAcceptance: false,
      files: [{ path: "model.bin", sizeBytes: bytes.byteLength, sha256: sha256(bytes) }]
    });
    const modelDirectory = join(root, entry.id);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(modelDirectory, { recursive: true }));
    await writeFile(join(modelDirectory, "model.bin.partial"), bytes.slice(0, 8));
    let requestedRange: string | null = null;
    const result = await downloadLocalModel({
      entry,
      destinationRoot: root,
      minFreeBytes: 0,
      fetch: async (_input, init) => {
        requestedRange = new Headers(init?.headers).get("range");
        return new Response(bytes.slice(8), { status: 206 });
      }
    });
    expect(requestedRange).toBe("bytes=8-");
    expect(new Uint8Array(await readFile(join(result.modelPath, "model.bin")))).toEqual(bytes);
    await rm(root, { recursive: true, force: true });
  });

  it("restarts a partial download when the server ignores Range", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-model-no-range-"));
    const bytes = new TextEncoder().encode("complete model bytes");
    const entry = testCatalogEntry(bytes);
    const modelDirectory = join(root, entry.id);
    await import("node:fs/promises").then(({ mkdir }) => mkdir(modelDirectory, { recursive: true }));
    await writeFile(join(modelDirectory, "model.bin.partial"), bytes.slice(0, 5));
    const ranges: Array<string | null> = [];
    await downloadLocalModel({
      entry,
      destinationRoot: root,
      minFreeBytes: 0,
      fetch: async (_input, init) => {
        ranges.push(new Headers(init?.headers).get("range"));
        return new Response(bytes, { status: 200 });
      }
    });
    expect(ranges).toEqual(["bytes=5-", null]);
    expect(new Uint8Array(await readFile(join(modelDirectory, "model.bin")))).toEqual(bytes);
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a short partial for retry and removes a checksum-invalid partial", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-model-invalid-"));
    const bytes = new TextEncoder().encode("expected model bytes");
    const entry = testCatalogEntry(bytes);
    await expect(downloadLocalModel({
      entry,
      destinationRoot: root,
      minFreeBytes: 0,
      fetch: async () => new Response(bytes.slice(0, -2), { status: 200 })
    })).rejects.toThrow("errors.localModels.sizeMismatch");
    await expect(access(join(root, entry.id, "model.bin.partial"))).resolves.toBeUndefined();
    await expect(downloadLocalModel({
      entry,
      destinationRoot: root,
      minFreeBytes: 0,
      fetch: async () => new Response(new Uint8Array([0, 1]), { status: 206 })
    })).rejects.toThrow("errors.localModels.checksumMismatch");
    await expect(access(join(root, entry.id, "model.bin.partial"))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

  it("fails preflight without fetching when disk reserve is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-model-disk-"));
    const bytes = new TextEncoder().encode("model bytes");
    let fetched = false;
    await expect(downloadLocalModel({
      entry: testCatalogEntry(bytes),
      destinationRoot: root,
      minFreeBytes: Number.MAX_SAFE_INTEGER,
      fetch: async () => {
        fetched = true;
        return new Response(bytes);
      }
    })).rejects.toThrow("errors.localModels.insufficientDisk");
    expect(fetched).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it("propagates cancellation without logging authorization data", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-model-cancel-"));
    const bytes = new TextEncoder().encode("model bytes");
    const controller = new AbortController();
    const download = downloadLocalModel({
      entry: testCatalogEntry(bytes),
      destinationRoot: root,
      minFreeBytes: 0,
      token: "hf_secret_download_token",
      signal: controller.signal,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Canceled", "AbortError")), { once: true });
        queueMicrotask(() => controller.abort());
      })
    });
    await expect(download).rejects.toMatchObject({ name: "AbortError" });
    expect(redactSensitiveText("https://example.test/file?token=hf_secret_download_token&x=1"))
      .toBe("https://example.test/file?token=[redacted]&x=1");
    await rm(root, { recursive: true, force: true });
  });

  it("rejects unsafe catalog paths and redacts repository credentials", () => {
    expect(() => localModelCatalogEntrySchema.parse({
      id: "unsafe-model", displayName: "Unsafe", family: "Test", variant: "Test",
      runtime: "mlx", repository: "example/model", revision: "a".repeat(40),
      format: "safetensors", quantization: "4-bit", capabilities: ["offline"],
      minimumMemoryBytes: 1, recommendedMemoryBytes: 1, license: "Test",
      licenseUrl: "https://example.test/license", requiresLicenseAcceptance: false,
      files: [{ path: "../outside", sizeBytes: 1, sha256: "a".repeat(64) }]
    })).toThrow();
    const redacted = redactSensitiveText("Authorization: Bearer hf_super_secret?token=api_secret_value");
    expect(redacted).not.toContain("hf_super_secret");
    expect(redacted).not.toContain("api_secret_value");
  });

  it("runs GGUF and MLX adapters through injectable native executors", async () => {
    const base = {
      modelId: "local-test", modelPath: "/managed/model",
      capabilities: ["text-generation", "reranking", "offline"] as const
    };
    const gguf = new NodeLlamaCppAdapter(
      { ...base, capabilities: [...base.capabilities] },
      async () => ({ output: "gguf", inputTokens: 2, outputTokens: 1, durationMs: 2 })
    );
    const mlx = new MlxAdapter(
      { ...base, capabilities: [...base.capabilities], helperPath: "/managed/helper" },
      async () => ({ output: "mlx", durationMs: 3 })
    );
    const request = {
      taskType: "text-generation" as const,
      input: "hello",
      requiredCapabilities: ["text-generation" as const],
      parameters: {}, metadata: {}
    };
    expect((await gguf.run(request)).output).toBe("gguf");
    expect((await gguf.run(request)).inputTokens).toBe(2);
    expect((await mlx.run(request)).output).toBe("mlx");
    expect(gguf.describe().capabilities).toContain("offline");
    expect(mlx.describe().providerId).toBe("local-mlx");
    const rerankRequest = {
      ...request,
      taskType: "reranking" as const,
      requiredCapabilities: ["reranking" as const]
    };
    expect(gguf.canHandle(rerankRequest)).toBe(true);
    expect(mlx.canHandle(rerankRequest)).toBe(true);

    const embed = new NodeLlamaCppAdapter(
      { modelId: "local-embed", modelPath: "/managed/embed.gguf", capabilities: ["embedding", "offline"] },
      async () => ({ output: "unused", durationMs: 1 }),
      async () => ({ output: [0.6, 0.8], inputTokens: 2, durationMs: 2 })
    );
    expect((await embed.run({
      taskType: "embedding",
      input: "query: hello",
      requiredCapabilities: ["embedding"],
      parameters: { dimensions: 1_024 },
      metadata: {}
    })).output).toEqual([0.6, 0.8]);
  });

  it("keeps the MLX helper alive between requests and stops it on dispose", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mlx-resident-"));
    const helperPath = join(root, "fake-helper.mjs");
    await writeFile(helperPath, `#!/usr/bin/env node
import readline from "node:readline";
let requests = 0;
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.command === "shutdown") process.exit(0);
  if (request.prompt === "hang") continue;
  requests += 1;
  process.stdout.write(JSON.stringify({
    protocolVersion: 1, requestId: request.requestId, kind: "result", ok: true,
    output: String(requests), durationMs: 1
  }) + "\\n");
}
`);
    await chmod(helperPath, 0o755);
    const adapter = new MlxAdapter({
      modelId: "local-test",
      modelPath: "/managed/model",
      helperPath,
      capabilities: ["text-generation", "offline"]
    });
    const request = {
      taskType: "text-generation" as const,
      input: "hello",
      requiredCapabilities: ["text-generation" as const],
      parameters: {}, metadata: {}
    };
    expect((await adapter.run(request)).output).toBe("1");
    expect((await adapter.run(request)).output).toBe("2");
    const controller = new AbortController();
    const canceled = adapter.run({ ...request, input: "hang" }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    expect((await adapter.run(request)).output).toBe("1");
    await adapter.dispose();
    expect((await adapter.run(request)).output).toBe("1");
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("supports an older MLX helper that exits successfully after each request", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-mlx-legacy-"));
    const helperPath = join(root, "legacy-helper.mjs");
    await writeFile(helperPath, `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.once("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    protocolVersion: 1, requestId: request.requestId, kind: "result", ok: true,
    output: "legacy", durationMs: 1
  }) + "\\n", () => process.exit(0));
});
`);
    await chmod(helperPath, 0o755);
    const adapter = new MlxAdapter({
      modelId: "local-test",
      modelPath: "/managed/model",
      helperPath,
      capabilities: ["text-generation", "offline"]
    });
    const request = {
      taskType: "text-generation" as const,
      input: "hello",
      requiredCapabilities: ["text-generation" as const],
      parameters: {}, metadata: {}
    };
    expect((await adapter.run(request)).output).toBe("legacy");
    expect((await adapter.run(request)).output).toBe("legacy");
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  });
});

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function testCatalogEntry(bytes: Uint8Array) {
  return localModelCatalogEntrySchema.parse({
    id: "test-model", displayName: "Test", family: "Test", variant: "Test",
    runtime: "mlx", repository: "example/model", revision: "a".repeat(40),
    format: "safetensors", quantization: "4-bit", capabilities: ["offline"],
    minimumMemoryBytes: 1, recommendedMemoryBytes: 1, license: "Test",
    licenseUrl: "https://example.test/license", requiresLicenseAcceptance: false,
    files: [{ path: "model.bin", sizeBytes: bytes.byteLength, sha256: sha256(bytes) }]
  });
}
