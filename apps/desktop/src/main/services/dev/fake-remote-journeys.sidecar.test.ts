import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import { startFakeRemote, type FakeRemoteHandle } from "./fake-remote-install.js";
import { journeysAdmitWriterKnobName } from "./fake-remote-journeys.js";
import { readSoakPlan } from "./soak-plan.js";
import { MemoryEventSink } from "./soak-records.js";

// The journeys mode of the fake remote on a real database (F5 T155): a profile shaped like BASE-J,
// whose write classes lead to a signed-in Codex writer, is refused as before, and is installed
// only when the harness's variable names that writer and the app is not packaged.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the journeys mode on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-journeys-fake-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_journeys_fake",
      user: "memora_journeys_fake",
      password: `journeys-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("refuses the writer's routes unless the variable names the writer, and never when packaged", async () => {
    const { profile } = readSoakPlan(
      join(workspace, "e2e/support/fake-remote-plan.json"),
      "journeys"
    );
    const repository = createAiConfigRepository(pool!);
    // BASE-J's writer: a Codex configuration with a stored credential, routed for the write classes.
    const writer = await repository.upsertProvider({
      provider: "openai-codex",
      displayName: "ChatGPT / Codex",
      credentialRef: "ai:stub",
      metadata: { modelId: "gpt-writer", capabilities: ["text-generation", "structured-output"] }
    });
    const writerProfile = await repository.createProfile({
      name: "Writer",
      isDefault: true,
      privacyMode: "allow_remote",
      outputLanguage: "ui"
    });
    await repository.updateProfile({
      id: writerProfile.id,
      providerConfigId: writer.id,
      modelId: "gpt-writer",
      runtime: "remote",
      capabilities: ["text-generation", "structured-output"]
    });
    for (const route of ["class:write-fast", "class:write-quality", "class:judge"]) {
      await repository.setProfileTask({ profileId: writerProfile.id, task: route });
      await repository.setTaskRoute(route, writerProfile.id);
    }
    const options = {
      pool: pool!,
      credentials: {
        save: async (_secret: string, existing?: string | null) => existing ?? `ai:${randomUUID()}`
      },
      setAnswerRoute: async (profileId: string) => {
        await repository.setProfileTask({ profileId, task: "class:answer" });
        await repository.setTaskRoute("class:answer", profileId);
      },
      sink: new MemoryEventSink(),
      workspaceRoot: workspace,
      isPackaged: false
    };
    const named = { [journeysAdmitWriterKnobName]: writer.id };

    // Unset: the check refuses, as before.
    await expect(startFakeRemote(profile, { ...options, env: {} })).rejects.toThrow(
      /still reaches a real remote provider/u
    );
    // Packaged: refused, whatever the variable says.
    await expect(
      startFakeRemote(profile, { ...options, env: named, isPackaged: true })
    ).rejects.toMatchObject({ code: "packaged" });
    // A configuration id that is not in this profile admits nothing.
    await expect(
      startFakeRemote(profile, {
        ...options,
        env: { [journeysAdmitWriterKnobName]: randomUUID() }
      })
    ).rejects.toMatchObject({ code: "realWriter" });

    // Named and unpackaged: installed, and the answer route leads to the fake.
    let handle: FakeRemoteHandle | null = null;
    try {
      handle = await startFakeRemote(profile, { ...options, env: named });
      expect(handle.providers.map((provider) => provider.provider).toSorted()).toEqual([
        "codex-wire",
        "openai-compatible"
      ]);
      const answer = await repository.getDefaultTask("structured-output", undefined, [
        "class:answer"
      ]);
      expect(answer?.providerConfigId).toBe(
        handle.providers.find((provider) => provider.provider === "openai-compatible")
          ?.providerConfigId
      );
    } finally {
      await handle?.stop();
    }
  });
});
