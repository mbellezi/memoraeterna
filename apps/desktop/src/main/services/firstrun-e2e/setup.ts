// The first-run configuration of the Hybrid end-to-end test (F4 T90, decision 31): what the
// onboarding does on its second step, through the same IPC handlers, in the order of `sequence.ts`.
// The calls are the "setup" phase of the IPC counters: E6 only forbids Settings calls after it.
//
// The sign-in is the one step the harness cannot play: a browser. For Codex it puts the credential
// where the sign-in leaves it (the AI service holds it until the provider is saved) and invokes
// everything after it as the screen does. A failed class test never stops the setup (the product's
// rule: a failure never blocks); the verdict reads the tests.
import type { AiService } from "../ai-service.js";
import type { OpenAiCodexCredential } from "../openai-codex-oauth.js";
import { ipcChannels } from "../../../shared/ipc.js";
import type {
  AiApplyPresetResult,
  AiClassRoutes,
  AiProfile,
  AiProviderConfig
} from "../../../shared/ipc.js";
import { codexCapabilities, UsageError } from "./config.js";
import type { WriterRoute } from "./config.js";
import { generationCapabilities } from "../topics-e2e/config.js";
import { firstRunClassTests } from "./sequence.js";
import type { SequencedIpc } from "./sequenced-ipc.js";
import type { Busy, Marks } from "./timeline.js";

export const writerProfileName = "Writer";

export class SetupError extends Error {
  public constructor(
    public readonly step: string,
    message: string
  ) {
    super(message);
    this.name = "SetupError";
  }
}

export interface SetupInput {
  ipc: SequencedIpc;
  /** Holds the Codex sign-in until the provider is saved. */
  service: AiService;
  writer: WriterRoute;
  /** Codex: the credential the sign-in would have left. Remote: null. */
  codexCredential: OpenAiCodexCredential | null;
  /** Remote: the API key. Codex: null. */
  apiKey: string | null;
  /** The languages the first step sets (the profile's own, as the screen offers them). */
  languages: { language: string; contentLanguage: string };
  embedderCatalogId: string;
  /** Waits for a model to be ready; throws when its install failed or ran out of time. */
  waitForModel: (catalogId: string) => Promise<void>;
  busy: Busy;
  marks: Marks;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export interface ClassTestOutcome {
  route: string;
  state: "untested" | "passed" | "failed" | "none";
  ms: number | null;
  error: string | null;
}

export interface SetupFacts {
  writer: AiProfile;
  /** What the preset call answered: applied, and nothing blocked. */
  preset: Pick<AiApplyPresetResult, "applied" | "blocked">;
  tests: ClassTestOutcome[];
}

/** Runs the second step of the onboarding in Hybrid; throws a `SetupError` when it cannot go on. */
export async function runHybridSetup(input: SetupInput): Promise<SetupFacts> {
  const { ipc, marks } = input;
  const log = input.log ?? (() => undefined);
  const working = <T>(work: () => Promise<T>): Promise<T> => input.busy.during(work);

  // 1. The languages.
  await working(() => ipc.invoke(ipcChannels.appSettingsUpdate, input.languages));
  marks.mark("setup.languages");

  // 2. The writer first: the sign-in, then its provider and profile.
  const writer = await working(() => signInWriter(input));
  marks.mark("setup.writer");
  log("writer", { profile: writer.name });

  // 3. The models: the embedder is asked for here and the person waits for it; the preset needs it.
  await working(() => ipc.invoke(ipcChannels.localModelsList));
  await working(() =>
    ipc.invoke(ipcChannels.localModelsDownload, {
      catalogId: input.embedderCatalogId,
      acceptLicense: false
    })
  );
  marks.mark("setup.embedder_requested");
  try {
    await input.waitForModel(input.embedderCatalogId);
  } catch (error) {
    throw new SetupError("models", error instanceof Error ? error.message : String(error));
  }
  marks.mark("setup.embedder_ready");

  // 4. The preset. The ranker follows once the embedding route exists; the preset never waits for it.
  const preset = await working(() =>
    ipc.invoke<AiApplyPresetResult>(ipcChannels.aiApplyPreset, { preset: "hybrid", test: false })
  );
  if (!preset.applied || preset.blocked.length > 0)
    throw new SetupError(
      "preset",
      `The Hybrid preset was not applied: ${
        preset.blocked.map((entry) => `${entry.route ?? "setup"} ${entry.reason}`).join("; ") ||
        "no reason given"
      }`
    );
  marks.mark("setup.preset");

  // 5. One test per class that has a route, one by one.
  const tests: ClassTestOutcome[] = [];
  for (const route of firstRunClassTests) {
    const view = await working(() =>
      ipc.invoke<AiClassRoutes>(ipcChannels.aiTestClassRoute, { route })
    );
    const test =
      route === "judge" ? view.judge.test : view.classes.find((entry) => entry.id === route)?.test;
    tests.push({
      route,
      state: test?.state ?? "untested",
      ms: test?.ms ?? null,
      error: test?.error ?? null
    });
  }
  marks.mark("setup.tests");
  return { writer, preset: { applied: preset.applied, blocked: preset.blocked }, tests };
}

/** The sign-in of the writer and its profile, as the Settings handlers leave them. */
export async function signInWriter(input: SetupInput): Promise<AiProfile> {
  const { ipc, writer } = input;
  let provider: AiProviderConfig;
  if (writer.kind === "codex") {
    if (!input.codexCredential)
      throw new SetupError("writer", "The Codex sign-in has no credential");
    // What `connectOpenAiCodex` leaves after the browser sign-in; `saveProvider` stores it.
    input.service["pendingOpenAiCodexCredential"] = input.codexCredential;
    provider = await ipc.invoke<AiProviderConfig>(ipcChannels.aiProvidersSave, {
      provider: "openai-codex",
      displayName: "ChatGPT / Codex",
      ...(writer.baseUrl ? { baseUrl: writer.baseUrl } : {}),
      modelId: writer.modelId,
      capabilities: codexCapabilities
    });
  } else {
    if (!input.apiKey) throw new UsageError("The remote writer needs its API key");
    provider = await ipc.invoke<AiProviderConfig>(ipcChannels.aiProvidersSave, {
      provider: writer.provider,
      displayName: `${writer.provider} ${writer.modelId}`,
      ...(writer.baseUrl ? { baseUrl: writer.baseUrl } : {}),
      apiKey: input.apiKey,
      modelId: writer.modelId,
      capabilities: generationCapabilities
    });
  }
  const created = await ipc.invoke<AiProfile>(ipcChannels.aiProfilesCreate, {
    name: writerProfileName,
    isDefault: true,
    privacyMode: "allow_remote",
    outputLanguage: "ui"
  });
  return ipc.invoke<AiProfile>(ipcChannels.aiProfilesUpdate, {
    id: created.id,
    providerConfigId: provider.id,
    modelId: writer.modelId,
    runtime: "remote",
    capabilities: writer.kind === "codex" ? codexCapabilities : generationCapabilities
  });
}
