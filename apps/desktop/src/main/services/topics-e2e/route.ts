// The first-run configuration of the zero-config end-to-end test (F2 T32, Q4): one writer profile
// and the default local embedding model, configured through the same Settings handlers the first
// run uses. Assigning a model to a profile seeds the task and class routes (D18); with no validated
// ranker there is no `class:decide`, so the gate falls back. The calls are the "setup" phase of the
// IPC counters: E6 only forbids Settings calls after it.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAiConfigRepository, createLocalModelRepository } from "@app/db";
import type { PgPool } from "@app/db";
import type { AiCapability } from "@app/domain";

import { ipcChannels } from "../../../shared/ipc.js";
import type { AiProfile, AiProviderConfig, LocalModelView } from "../../../shared/ipc.js";
import { RecordedRouteSchema, UsageError, routeFileName, routeFromFile } from "./config.js";
import type { E2eConfig, RecordedRoute, RouteSpec, WriterSpec } from "./config.js";
import type { RecordingIpc } from "./ipc-counters.js";

export const writerProfileName = "Writer";
export const embeddingProfileName = "Embedding";

/** The route of a recording: the flags, or the route file of a scratch profile. */
export async function resolveRoute(
  config: E2eConfig,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<RouteSpec> {
  const route = config.route;
  if (!route) throw new UsageError("A recording needs a route");
  let spec: RouteSpec;
  if (route.spec) spec = route.spec;
  else {
    let content: string;
    try {
      content = await read(route.file!);
    } catch {
      throw new UsageError(`The route file ${route.file} could not be read`);
    }
    spec = routeFromFile(content, route.file!, route.embeddingGguf);
  }
  if (spec.writer.kind === "remote" && config.maxTokens === null)
    throw new UsageError(
      "Recording spends a remote route: set --max-tokens (a cap on live tokens)"
    );
  if (!spec.embedding.path)
    throw new UsageError(
      "A recording needs the installed embedding model: --embedding-gguf <file>"
    );
  return spec;
}

/** The API key of a remote writer: a file, else the named environment variable; never a flag. */
export async function readApiKey(
  writer: WriterSpec,
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<string | null> {
  if (writer.kind !== "remote") return null;
  const key = writer.apiKeyFile
    ? (await read(writer.apiKeyFile)).trim()
    : env[writer.apiKeyEnv]?.trim();
  if (!key)
    throw new UsageError(
      `The writer's API key is not set: put it in $${writer.apiKeyEnv}${writer.apiKeyFile ? ` or in ${writer.apiKeyFile}` : ""} ` +
        "(a keyless local server takes any placeholder value)"
    );
  return key;
}

/** What a cassette was recorded with, read next to it. */
export async function readRecordedRoute(
  cassetteDir: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8")
): Promise<RecordedRoute> {
  const file = join(cassetteDir, routeFileName);
  let content: string;
  try {
    content = await read(file);
  } catch {
    throw new UsageError(
      `${file} is missing: the cassette was not recorded by this harness (record it first)`
    );
  }
  const parsed = RecordedRouteSchema.safeParse(JSON.parse(content));
  if (!parsed.success)
    throw new UsageError(`${file} is not a recorded route: ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

/** The route of a replay: the recorded one, with placeholder paths (nothing is ever loaded). */
export function replayRoute(recorded: RecordedRoute, modelsDirectory: string): RouteSpec {
  const writer: WriterSpec =
    recorded.writer.kind === "remote"
      ? {
          ...recorded.writer,
          apiKeyEnv: "MEMORA_E2E_API_KEY"
        }
      : { ...recorded.writer, path: join(modelsDirectory, recorded.writer.catalogId) };
  return {
    writer,
    embedding: {
      catalogId: recorded.embedding.catalogId,
      path: join(modelsDirectory, `${recorded.embedding.catalogId}.gguf`)
    }
  };
}

export interface SeedResult {
  writer: AiProfile;
  embedding: AiProfile;
  /** Task and class route keys to the profile name they point at. */
  routes: Record<string, string>;
}

/** Marks a catalog model as installed at a path, as a finished download would. */
async function install(
  pool: PgPool,
  models: readonly LocalModelView[],
  catalogId: string,
  path: string
): Promise<LocalModelView> {
  const view = models.find((model) => model.catalogId === catalogId);
  if (!view) throw new UsageError(`The local model catalog has no entry ${catalogId}`);
  await createLocalModelRepository(pool).updateModel(view.id, {
    status: "ready",
    managedPath: path
  });
  return view;
}

/**
 * Configures the writer and the embedding model through the Settings handlers (setup phase) and
 * checks the routes the first-run seeding produced. `apiKey` is only used for a remote writer.
 */
export async function seedFirstRun(input: {
  ipc: RecordingIpc;
  pool: PgPool;
  route: RouteSpec;
  apiKey: string | null;
}): Promise<SeedResult> {
  const { ipc, pool, route } = input;
  const embeddingPath = route.embedding.path;
  if (!embeddingPath) throw new UsageError("The embedding model has no path");
  // The catalog sync of the local models (the Settings list), then the "download" of the models.
  const models = await ipc.invoke<LocalModelView[]>(ipcChannels.localModelsList);

  const writerSpec = route.writer;
  let writer: AiProfile;
  if (writerSpec.kind === "remote") {
    const provider = await ipc.invoke<AiProviderConfig>(ipcChannels.aiProvidersSave, {
      provider: writerSpec.provider,
      displayName: `${writerSpec.provider} ${writerSpec.modelId}`,
      ...(writerSpec.baseUrl ? { baseUrl: writerSpec.baseUrl } : {}),
      apiKey: input.apiKey,
      modelId: writerSpec.modelId,
      capabilities: writerSpec.capabilities
    });
    const created = await ipc.invoke<AiProfile>(ipcChannels.aiProfilesCreate, {
      name: writerProfileName,
      isDefault: true,
      privacyMode: "allow_remote",
      outputLanguage: "ui"
    });
    writer = await ipc.invoke<AiProfile>(ipcChannels.aiProfilesUpdate, {
      id: created.id,
      providerConfigId: provider.id,
      modelId: writerSpec.modelId,
      runtime: "remote",
      capabilities: writerSpec.capabilities
    });
  } else {
    const view = await install(pool, models, writerSpec.catalogId, writerSpec.path);
    const created = await ipc.invoke<AiProfile>(ipcChannels.aiProfilesCreate, {
      name: writerProfileName,
      isDefault: true,
      privacyMode: "offline_only",
      outputLanguage: "ui"
    });
    writer = await ipc.invoke<AiProfile>(ipcChannels.aiProfilesUpdate, {
      id: created.id,
      localModelId: view.id,
      modelId: view.modelId,
      runtime: view.runtime,
      capabilities: view.capabilities as AiCapability[]
    });
  }

  const embeddingView = await install(pool, models, route.embedding.catalogId, embeddingPath);
  const embeddingCreated = await ipc.invoke<AiProfile>(ipcChannels.aiProfilesCreate, {
    name: embeddingProfileName,
    isDefault: false,
    privacyMode: "offline_only",
    outputLanguage: "ui"
  });
  const embedding = await ipc.invoke<AiProfile>(ipcChannels.aiProfilesUpdate, {
    id: embeddingCreated.id,
    localModelId: embeddingView.id,
    modelId: embeddingView.modelId,
    runtime: embeddingView.runtime,
    capabilities: embeddingView.capabilities as AiCapability[]
  });

  const names = new Map([
    [writer.id, writerProfileName],
    [embedding.id, embeddingProfileName]
  ]);
  const routes = Object.fromEntries(
    (await createAiConfigRepository(pool).listTaskRoutes()).map((entry) => [
      entry.task,
      names.get(entry.profileId) ?? entry.profileId
    ])
  );
  expectRoutes(routes);
  return { writer, embedding, routes };
}

/** The seeding must route what the zero-config flow needs and nothing that needs a ranker. */
export function expectRoutes(routes: Readonly<Record<string, string>>): void {
  const problems: string[] = [];
  const need = (task: string, profile: string) => {
    if (routes[task] !== profile)
      problems.push(`${task} routes to ${routes[task] ?? "nothing"}, not to ${profile}`);
  };
  need("embedding", embeddingProfileName);
  for (const task of [
    "summarization",
    "atomic-note-generation",
    "knowledge-graph-generation",
    "structured-output",
    "class:write-fast"
  ])
    need(task, writerProfileName);
  if (routes["class:decide"] !== undefined)
    problems.push("class:decide is routed, but the zero-config flow has no validated ranker");
  if (problems.length > 0)
    throw new Error(`The first-run seeding did not route the tasks: ${problems.join("; ")}`);
}
