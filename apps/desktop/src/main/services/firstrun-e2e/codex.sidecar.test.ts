import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  aiProviderConfigInputSchema,
  ipcChannels
} from "../../../shared/ipc.js";
import { AiService } from "../ai-service.js";
import {
  codexWireBasePath,
  codexWireKind,
  devCodexCredential,
  devFakeCodexModelId
} from "../dev/fake-codex-provider.js";
import { FakeProviderServer, fixedLatency } from "../dev/fake-remote-core.js";
import { MemoryEventSink } from "../dev/soak-records.js";
import { Busy, Marks } from "./timeline.js";
import { parseCodexCredentialFile, harnessRefreshToken } from "./route.js";
import { SequencedIpc } from "./sequenced-ipc.js";
import { signInWriter, writerProfileName } from "./setup.js";

vi.mock("electron", async () => {
  const { sharedElectronStub: stub } = await import("../topics-e2e/electron-stub.js");
  return { ...stub().module, default: stub().module };
});

/**
 * The live path of the Codex writer, against the DEV Codex-wire fake on loopback instead of
 * ChatGPT: the credential the harness is given is put where the browser sign-in leaves it, the
 * provider and the profile are saved through the Settings handlers, the credential is stored
 * encrypted in the scratch profile (without the real refresh token), and the real Codex adapter
 * then reaches the server with that access token and account. This is what a recording does
 * before its first call, minus the network.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

describe.skipIf(!sidecarAvailable)(
  "the Codex sign-in of a recording on the PostgreSQL sidecar",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager;
    let pool: PgPool;
    let server: FakeProviderServer;
    const sink = new MemoryEventSink();

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-firstrun-codex-"));
      server = new FakeProviderServer({
        kind: codexWireKind({ seed: 20261024, latency: fixedLatency(5) }),
        sink
      });
      await server.start();
      manager = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: join(workDir, "database"),
        database: "memora_firstrun_codex",
        user: "memora_firstrun_codex",
        password: `codex-${Math.random().toString(36).slice(2)}`,
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
      await server?.stop();
      if (pool) await closePgPool(pool).catch(() => undefined);
      await manager?.stop().catch(() => undefined);
      await rm(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }, 120_000);

    it("saves the provider and the profile, stores the credential encrypted and reaches the server with it", async () => {
      const service = new AiService({
        userDataPath: workDir,
        getPool: () => pool,
        workspaceRoot,
        resourcesPath: workspaceRoot,
        isPackaged: false,
        logger: { info: () => undefined, error: () => undefined },
        getContentLanguage: async () => "pt-BR"
      });
      const ipc = new SequencedIpc();
      // The three Settings handlers of the writer's sign-in, as `ipc.ts` registers them.
      ipc.main.handle(ipcChannels.aiProvidersSave, (_event, payload) =>
        service.saveProvider(aiProviderConfigInputSchema.parse(payload))
      );
      ipc.main.handle(ipcChannels.aiProfilesCreate, (_event, payload) =>
        service.createProfile(aiProfileCreateSchema.parse(payload))
      );
      ipc.main.handle(ipcChannels.aiProfilesUpdate, (_event, payload) =>
        service.updateProfile(aiProfileUpdateSchema.parse(payload))
      );
      // The file a person writes for a recording: the real refresh token is in it, and must not travel.
      const file = JSON.stringify({
        access: devCodexCredential.access,
        refresh: "REAL-REFRESH-TOKEN-NEVER-STORED",
        expires: Date.now() + 120 * 60_000,
        accountId: devCodexCredential.accountId
      });
      const credential = parseCodexCredentialFile(file, "/c.json", Date.now());

      ipc.phase("setup");
      const marks = new Marks(new Date());
      const profile = await signInWriter({
        ipc,
        service,
        writer: {
          kind: "codex",
          modelId: devFakeCodexModelId,
          baseUrl: `${server.origin}${codexWireBasePath}`,
          credentialFile: "/c.json"
        },
        codexCredential: credential,
        apiKey: null,
        languages: { language: "pt-BR", contentLanguage: "pt-BR" },
        embedderCatalogId: "unused",
        waitForModel: async () => undefined,
        busy: new Busy(),
        marks
      });

      // The calls of the writer's sign-in, as the onboarding makes them after the browser step.
      expect(ipc.channels("setup")).toEqual([
        ipcChannels.aiProvidersSave,
        ipcChannels.aiProfilesCreate,
        ipcChannels.aiProfilesUpdate
      ]);
      expect(profile).toMatchObject({
        name: writerProfileName,
        isDefault: true,
        runtime: "remote",
        modelId: devFakeCodexModelId
      });
      // The sign-in is consumed by the save, as the browser flow's is.
      expect(service["pendingOpenAiCodexCredential"]).toBeNull();

      // Stored encrypted, and without the real refresh token.
      const secrets = await readFile(join(workDir, "credentials", "ai-secrets.json"), "utf8");
      expect(secrets).not.toContain(devCodexCredential.access);
      expect(secrets).not.toContain("REAL-REFRESH-TOKEN-NEVER-STORED");
      expect(harnessRefreshToken).not.toContain("REAL");

      // The real Codex adapter reaches the fake with the access token and the account.
      const providers = await service.listProviders();
      expect(providers).toHaveLength(1);
      expect(providers[0]).toMatchObject({
        provider: "openai-codex",
        baseUrl: `${server.origin}${codexWireBasePath}`,
        secretConfigured: true
      });
      await expect(service.testProvider(providers[0]!.id)).resolves.toBe(true);
      const answer = await service.runDefaultTask(
        "structured-output",
        "Reply with exactly: OK",
        { stage: "class_test", operation: "class_test", priority: "P0" },
        undefined,
        { maxOutputTokens: 64 }
      );
      expect(String(answer?.output)).toMatch(/\bOK\b/u);
      expect(server.served).toBe(1);
    }, 120_000);
  }
);
