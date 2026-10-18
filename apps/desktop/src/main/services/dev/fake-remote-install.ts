import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  createAiConfigRepository,
  operationRouteKey,
  type AiProfileRecord,
  type AiProviderConfigRecord,
  type Queryable
} from "@app/db";
import type { AiCapability } from "@app/domain";
import { treatAsRemoteMetadataKey } from "@app/ai";

import {
  codexWireBasePath,
  codexWireKind,
  devCodexCredential,
  devFakeCodexModelId
} from "./fake-codex-provider.js";
import {
  FakeProviderServer,
  fixedLatency,
  quantileLatency,
  type LatencyModel
} from "./fake-remote-core.js";
import {
  devFakeAnswerModelId,
  devFakeApiKey,
  openAiCompatibleKind,
  openAiCompatibleProvider
} from "./fake-remote-provider.js";
import { FaultSchedule, withFaults } from "./fault-decorator.js";
import {
  SoakKnobRefusal,
  latencyFitSchema,
  type SoakLatencySpec,
  type SoakProfile
} from "./soak-plan.js";
import type { SoakEventSink } from "./soak-records.js";
import { codexWireProvider } from "./fake-codex-provider.js";

/**
 * Starts the two fake remote providers and gives the library's AI configuration the routes that
 * lead to them (F3 R6, T62): provider configurations whose address is the fake's loopback port and
 * whose metadata carries `treatAsRemote: true`, a profile for each, `class:answer` (Ask) on the
 * OpenAI-compatible fake and `op:relation_explanation` on the Codex-wire fake. The credentials are
 * the fixed dummy key and the DEV OAuth stub, saved through the credential service like any other.
 *
 * It runs once per app start, before the job supervisor: the fakes listen on new ports each time,
 * so the configurations are written again (found by name, never duplicated). It writes the library's
 * AI configuration, so `readSoakKnob` allows it on a clone inside `.cache/profiles/` only.
 */

export const fakeOpenAiDisplayName = "DEV fake OpenAI-compatible (soak)";
export const fakeCodexDisplayName = "DEV fake Codex wire (soak)";
/** The operation whose writer is the Codex-wire fake: relation explanations opened on a note page. */
export const explanationRoute = operationRouteKey("relation_explanation");

export interface FakeRemoteDeps {
  pool: Queryable;
  credentials: { save(secret: string, existingRef?: string | null): Promise<string> };
  /** Points `class:answer` at a profile (the AI service's Custom flow). */
  setAnswerRoute(profileId: string): Promise<unknown>;
  sink: SoakEventSink;
  workspaceRoot: string;
  logger?: Pick<Console, "info">;
}

export interface RunningFakeProvider {
  provider: string;
  providerConfigId: string;
  profileId: string;
  baseUrl: string;
  server: FakeProviderServer;
}

export interface FakeRemoteHandle {
  providers: RunningFakeProvider[];
  /** Counts the plan's minutes from now (the driver starts its own timeline at this moment). */
  restartClock(): void;
  stop(): Promise<void>;
}

/** The durations a fake draws from: the recorded fit of a task, else a fixed time. */
export function loadLatencyModel(spec: SoakLatencySpec, workspaceRoot: string): LatencyModel {
  if (spec.fit === null) return fixedLatency(spec.fixedMs);
  const path = resolve(workspaceRoot, spec.fit);
  let fit;
  try {
    fit = latencyFitSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    throw new SoakKnobRefusal(
      "invalidPlan",
      `The latency fit ${spec.fit} is missing or invalid (run scripts/soak/latency-fit.ts): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const task = spec.task === null ? undefined : fit.tasks[spec.task];
  if (!task)
    throw new SoakKnobRefusal(
      "invalidPlan",
      `The latency fit has no task ${String(spec.task)} (it has ${Object.keys(fit.tasks).join(", ")}).`
    );
  return quantileLatency(task.quantilesMs, { minMs: spec.minMs, maxMs: spec.maxMs });
}

/**
 * The routes (and the default profile) that lead to a remote provider configuration other than the
 * given ones. A soak must reach no real provider: a profile cloned from the owner's DEV profile can
 * still hold a Hybrid preset whose class routes point at the real Codex or an API key, and the soak
 * would spend that quota. Names only; never a credential.
 */
export async function findRealRemoteRoutes(
  db: Queryable,
  allowedConfigIds: readonly string[]
): Promise<string[]> {
  const result = await db.query<{ route: string; provider: string; name: string }>(
    `select r.task as route, c.provider, c.display_name as name
       from ai_task_profile_routes r
       join ai_profile_sets p on p.id = r.profile_id and p.status = 'active'
       join ai_provider_configs c on c.id = p.provider_config_id
      where c.id <> all($1::uuid[])
     union all
     select 'default profile', c.provider, c.display_name
       from ai_profile_sets p
       join ai_provider_configs c on c.id = p.provider_config_id
      where p.is_default and p.status = 'active' and c.id <> all($1::uuid[])
      order by 1`,
    [allowedConfigIds]
  );
  return result.rows.map((row) => `${row.route} -> ${row.name} (${row.provider})`);
}

interface ProviderInstall {
  displayName: string;
  provider: "openai-compatible" | "openai-codex";
  baseUrl: string;
  modelId: string;
  capabilities: AiCapability[];
  secret: string;
}

async function installProvider(
  repository: ReturnType<typeof createAiConfigRepository>,
  deps: FakeRemoteDeps,
  install: ProviderInstall
): Promise<{ config: AiProviderConfigRecord; profile: AiProfileRecord }> {
  const existing = (await repository.listProviders()).find(
    (candidate) => candidate.displayName === install.displayName
  );
  const credentialRef = await deps.credentials.save(install.secret, existing?.credentialRef);
  const config = await repository.upsertProvider({
    ...(existing ? { id: existing.id } : {}),
    provider: install.provider,
    displayName: install.displayName,
    credentialRef,
    baseUrl: install.baseUrl,
    metadata: {
      modelId: install.modelId,
      capabilities: install.capabilities,
      // Honoured only by an unpackaged build under MEMORA_FAKE_REMOTE (lane classification and the
      // adapter's deadline mode); anywhere else it is ignored, so the fake counts as local there.
      [treatAsRemoteMetadataKey]: true
    }
  });
  let profile = (await repository.listProfiles()).find(
    (candidate) => candidate.name === install.displayName
  );
  profile ??= await repository.createProfile({
    name: install.displayName,
    isDefault: false,
    privacyMode: "allow_remote",
    outputLanguage: "ui"
  });
  profile = await repository.updateProfile({
    id: profile.id,
    privacyMode: "allow_remote",
    providerConfigId: config.id,
    modelId: install.modelId,
    runtime: "remote",
    capabilities: install.capabilities
  });
  return { config, profile };
}

/** Starts the fakes and installs their routes; stops the fakes again when the installation fails. */
export async function startFakeRemote(
  profile: SoakProfile,
  deps: FakeRemoteDeps
): Promise<FakeRemoteHandle> {
  const remote = profile.remote;
  const servers: FakeProviderServer[] = [];
  const stop = async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  };
  try {
    const compatibleSchedule = new FaultSchedule(
      remote.openAiCompatible.faults,
      profile.seed,
      openAiCompatibleProvider
    );
    const compatible = new FakeProviderServer({
      kind: withFaults(
        openAiCompatibleKind({
          seed: profile.seed,
          latency: loadLatencyModel(remote.openAiCompatible.latency, deps.workspaceRoot),
          firstByteFraction: remote.openAiCompatible.latency.firstByteFraction
        }),
        compatibleSchedule
      ),
      sink: deps.sink,
      windows: compatibleSchedule.windows()
    });
    const codexSchedule = new FaultSchedule(
      remote.codexWire.faults,
      profile.seed,
      codexWireProvider
    );
    const codex = new FakeProviderServer({
      kind: withFaults(
        codexWireKind({
          seed: profile.seed,
          latency: loadLatencyModel(remote.codexWire.latency, deps.workspaceRoot),
          firstByteFraction: remote.codexWire.latency.firstByteFraction,
          notRelatedRate: remote.codexWire.notRelatedRate
        }),
        codexSchedule
      ),
      sink: deps.sink,
      windows: codexSchedule.windows()
    });
    servers.push(compatible, codex);
    await Promise.all([compatible.start(), codex.start()]);

    const repository = createAiConfigRepository(deps.pool);
    const answer = await installProvider(repository, deps, {
      displayName: fakeOpenAiDisplayName,
      provider: "openai-compatible",
      baseUrl: `${compatible.origin}/v1`,
      modelId: devFakeAnswerModelId,
      capabilities: ["text-generation", "structured-output"],
      secret: devFakeApiKey
    });
    const explain = await installProvider(repository, deps, {
      displayName: fakeCodexDisplayName,
      provider: "openai-codex",
      baseUrl: `${codex.origin}${codexWireBasePath}`,
      modelId: devFakeCodexModelId,
      capabilities: ["text-generation"],
      secret: JSON.stringify(devCodexCredential)
    });
    await deps.setAnswerRoute(answer.profile.id);
    await repository.setProfileTask({
      profileId: explain.profile.id,
      task: explanationRoute,
      parameters: {}
    });
    await repository.setTaskRoute(explanationRoute, explain.profile.id);

    // The routes must lead to the fakes, or the soak would spend the owner's quota (or fail).
    const asked = await repository.getDefaultTask("structured-output", undefined, [
      "op:wiki-consultation",
      "class:answer",
      "structured-output"
    ]);
    const explained = await repository.getDefaultTask("text-generation", undefined, [
      explanationRoute,
      "class:write-fast",
      "text-generation"
    ]);
    if (
      asked?.providerConfigId !== answer.config.id ||
      explained?.providerConfigId !== explain.config.id
    )
      throw new Error("The fake remote routes do not lead to the fake providers.");
    const real = await findRealRemoteRoutes(deps.pool, [answer.config.id, explain.config.id]);
    if (real.length > 0)
      throw new Error(
        `This profile still routes to a real remote provider (${real.join("; ")}). ` +
          "Apply the Local preset in Settings > AI first: a soak never calls a real provider."
      );
    deps.logger?.info(
      `FAKE_REMOTE ready: ${compatible.origin} (answer) and ${codex.origin} (explanations)`
    );
    return {
      providers: [
        {
          provider: openAiCompatibleProvider,
          providerConfigId: answer.config.id,
          profileId: answer.profile.id,
          baseUrl: `${compatible.origin}/v1`,
          server: compatible
        },
        {
          provider: codexWireProvider,
          providerConfigId: explain.config.id,
          profileId: explain.profile.id,
          baseUrl: `${codex.origin}${codexWireBasePath}`,
          server: codex
        }
      ],
      restartClock: () => {
        compatible.restartClock();
        codex.restartClock();
      },
      stop
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
