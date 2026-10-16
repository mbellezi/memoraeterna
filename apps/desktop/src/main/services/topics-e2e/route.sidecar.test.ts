import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AiCassette, setAiAdapterDecorator } from "@app/ai";
import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations
} from "@app/db";
import type { PgPool } from "@app/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  aiProfileCreateSchema,
  aiProfileUpdateSchema,
  aiProviderConfigInputSchema
} from "../../../shared/ipc.js";
import { ipcChannels } from "../../../shared/ipc.js";
import { AiService } from "../ai-service.js";
import { LocalModelService } from "../local-model-service.js";
import { SettingsService } from "../settings-service.js";
import { RouteSpecSchema } from "./config.js";
import { RecordingIpc } from "./ipc-counters.js";
import { embeddingProfileName, seedFirstRun, writerProfileName } from "./route.js";

vi.mock("electron", async () => {
  const { sharedElectronStub: stub } = await import("./electron-stub.js");
  return { ...stub().module, default: stub().module };
});

/**
 * The record path of a remote writer, end to end except for the models: the first-run
 * configuration through the Settings handlers with a key read from outside the route, the key
 * stored encrypted in the scratch credential store, a generation call that reaches a fake
 * OpenAI-compatible server with that key, the cassette recording it, and a fresh service replaying
 * it with no second request. The local embedding model is never loaded here.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));
const key = "sk-test-0123456789abcdef";

describe.skipIf(!sidecarAvailable)("the first-run route of a remote writer", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let server: Server;
  const requests: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topics-e2e-route-"));
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => {
        requests.push({ url: request.url ?? "", headers: request.headers, body });
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`);
        event({ choices: [{ delta: { content: "Um resumo " } }] });
        event({
          choices: [{ delta: { content: "curto." } }],
          usage: { prompt_tokens: 12, completion_tokens: 3 }
        });
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, "database"),
      database: "memora_topics_e2e_route",
      user: "memora_topics_e2e_route",
      password: `route-${Math.random().toString(36).slice(2)}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    setAiAdapterDecorator(null);
    await new Promise((done) => server?.close(done));
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 60_000);

  function service() {
    return new AiService({
      userDataPath: workDir,
      getPool: () => pool,
      workspaceRoot,
      resourcesPath: workspaceRoot,
      isPackaged: false,
      logger: { info: () => undefined, error: () => undefined },
      getContentLanguage: async () => "pt-BR"
    });
  }

  it("configures the writer and the embedding model, keeps the key encrypted and records a call", async () => {
    const ai = service();
    const models = new LocalModelService({
      getPool: () => pool,
      userDataPath: workDir,
      isPackaged: false,
      workspaceRoot,
      env: {}
    });
    const settings = new SettingsService(workDir, {
      getDatabasePool: () => pool,
      requireDatabase: true,
      desktopLocale: "pt-BR"
    });
    expect((await settings.getApp()).contentLanguage).toBe("pt-BR");
    // The four Settings handlers of the first run, as `ipc.ts` registers them.
    const ipc = new RecordingIpc();
    ipc.main.handle(ipcChannels.localModelsList, () => models.list());
    ipc.main.handle(ipcChannels.aiProvidersSave, (_event, payload) =>
      ai.saveProvider(aiProviderConfigInputSchema.parse(payload))
    );
    ipc.main.handle(ipcChannels.aiProfilesCreate, (_event, payload) =>
      ai.createProfile(aiProfileCreateSchema.parse(payload))
    );
    ipc.main.handle(ipcChannels.aiProfilesUpdate, (_event, payload) =>
      ai.updateProfile(aiProfileUpdateSchema.parse(payload))
    );
    const embeddingFile = join(workDir, "embedding.gguf");
    await writeFile(embeddingFile, "");
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const route = RouteSpecSchema.parse({
      writer: { kind: "remote", provider: "openai-compatible", baseUrl, modelId: "writer-1" },
      embedding: { path: embeddingFile }
    });

    const seeded = await seedFirstRun({ ipc, pool, route, apiKey: key });
    expect(seeded.writer.name).toBe(writerProfileName);
    expect(seeded.embedding.name).toBe(embeddingProfileName);
    expect(seeded.routes).toMatchObject({
      embedding: embeddingProfileName,
      summarization: writerProfileName,
      "structured-output": writerProfileName,
      "class:write-fast": writerProfileName
    });
    expect(ipc.calls("setup", "settings")).toBe(6);

    // The key is in the credential store, but not in the clear.
    const secrets = await readFile(join(workDir, "credentials", "ai-secrets.json"), "utf8");
    expect(secrets).not.toContain(key);
    expect(secrets).not.toContain(Buffer.from(key).toString("base64"));

    // A generation call reaches the server with the key and is recorded by the cassette.
    const cassette = new AiCassette({ mode: "record", directory: join(workDir, "cassette") });
    cassette.limitLiveTokens(1000);
    setAiAdapterDecorator((adapter) => cassette.wrap(adapter));
    const context = { stage: "summarization", operation: "e2e_probe" };
    const first = await ai.runDefaultTask("summarization", "Resuma o texto.", context);
    expect(first?.output).toBe("Um resumo curto.");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: "/v1/chat/completions" });
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${key}`);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ model: "writer-1", stream: true });
    expect(cassette.stats()).toMatchObject({ mode: "record", recorded: 1, liveTokens: 15 });

    // A fresh service replays it from the cassette alone: no second request.
    const replay = new AiCassette({ mode: "replay", directory: join(workDir, "cassette") });
    setAiAdapterDecorator((adapter) => replay.wrap(adapter));
    const again = await service().runDefaultTask("summarization", "Resuma o texto.", context);
    expect(again?.output).toBe("Um resumo curto.");
    expect(requests).toHaveLength(1);
    expect(replay.stats()).toMatchObject({ mode: "replay", served: 1, misses: 0 });

    // The cassette holds the library's text, never the key.
    const files = (await readdir(join(workDir, "cassette"), { recursive: true })).map((file) =>
      join(workDir, "cassette", String(file))
    );
    for (const file of files.filter((path) => path.endsWith(".json")))
      expect(await readFile(file, "utf8")).not.toContain(key);
  }, 120_000);
});
