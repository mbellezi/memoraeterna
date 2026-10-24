import { presetCatalogIds } from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import {
  firstRunClassTests,
  hybridSetupSequence,
  invokedSetupChannels
} from "../../../shared/first-run-sequence";
import { ipcChannels } from "../../../shared/ipc";
import { smallMacHardware, windowsHardware } from "./onboarding-fixtures";
import {
  codexWriterCapabilities,
  writerCapabilities,
  type OnboardingHardware
} from "../../../shared/onboarding";
import { canStartSetup, OnboardingController, type OnboardingDeps } from "./onboarding-controller";
import { failedTestCount } from "./onboarding-model";
import {
  downloadEvent,
  macHardware,
  recordedApi,
  settle,
  type RecordedOptions
} from "./onboarding-fixtures";

function make(options: RecordedOptions = {}, extra: Partial<OnboardingDeps> = {}) {
  const recorded = recordedApi(options);
  const controller = new OnboardingController({
    api: () => recorded.api,
    initial: () => ({ language: "pt-BR", contentLanguage: "pt-BR" }),
    names: () => ({ profile: "Writing model", codexProvider: "ChatGPT" }),
    ...extra
  });
  return { recorded, controller };
}

/** Starts and walks the first step: the first run is due, the languages are kept. */
async function toMode(options: RecordedOptions = {}, extra: Partial<OnboardingDeps> = {}) {
  const made = make(options, extra);
  await made.controller.start();
  await made.controller.submitLanguages();
  await settle();
  return made;
}

async function signInAndStart(controller: OnboardingController) {
  await controller.signInCodex();
  controller.startSetup();
  await settle();
}

describe("whether the first run is due", () => {
  it("shows the app, with one read and nothing else, when it is not due", async () => {
    const { controller, recorded } = make({ due: false });
    expect(controller.getSnapshot().phase).toBe("checking");
    await controller.start();
    expect(controller.getSnapshot().phase).toBe("off");
    expect(recorded.calls).toEqual([ipcChannels.onboardingState]);
  });

  it("shows the app when the question fails: a failure never hides it", async () => {
    const { controller } = make({ failOnce: [ipcChannels.onboardingState] });
    await controller.start();
    expect(controller.getSnapshot().phase).toBe("off");
  });

  it("starts at the languages the app has, with the interface and content languages together", async () => {
    const { controller } = make();
    await controller.start();
    const snapshot = controller.getSnapshot();
    expect(snapshot).toMatchObject({ phase: "languages", step: 1 });
    expect(snapshot.languages).toEqual({
      language: "pt-BR",
      contentLanguage: "pt-BR",
      save: "idle"
    });
    expect(snapshot.announcement?.message).toEqual({
      key: "onboarding.live.languages",
      values: { current: 1, total: 3 }
    });
  });

  it("asks once and listens to the installs until it lets go", async () => {
    const { controller, recorded } = make();
    await controller.start();
    await controller.start();
    expect(recorded.calls).toEqual([ipcChannels.onboardingState]);
    expect(recorded.listeners()).toBe(1);
    controller.dispose();
    expect(recorded.listeners()).toBe(0);
  });
});

describe("step 1: the languages", () => {
  it("makes the content language follow the interface until it is chosen on its own", async () => {
    const { controller } = make();
    await controller.start();
    controller.setLanguage("fr");
    expect(controller.getSnapshot().languages).toMatchObject({
      language: "fr",
      contentLanguage: "fr"
    });
    controller.setContentLanguage("it");
    controller.setLanguage("es");
    expect(controller.getSnapshot().languages).toMatchObject({
      language: "es",
      contentLanguage: "it"
    });
  });

  it("stores both languages, tells the app, and goes on to the mode", async () => {
    const onSettings = vi.fn();
    const { controller, recorded } = make({}, { onSettings });
    await controller.start();
    controller.setLanguage("it");
    await controller.submitLanguages();
    expect(recorded.payloads[ipcChannels.appSettingsUpdate]).toEqual([
      { language: "it", contentLanguage: "it" }
    ]);
    expect(onSettings).toHaveBeenCalledWith(expect.objectContaining({ language: "it" }));
    expect(controller.getSnapshot()).toMatchObject({ phase: "mode", step: 2 });
  });

  it("stays on the step with the failure visible, and tries again", async () => {
    const { controller, recorded } = make({ failOnce: [ipcChannels.appSettingsUpdate] });
    await controller.start();
    await controller.submitLanguages();
    expect(controller.getSnapshot()).toMatchObject({
      phase: "languages",
      languages: { save: "failed" }
    });
    await controller.submitLanguages();
    expect(controller.getSnapshot().phase).toBe("mode");
    expect(recorded.calls.filter((call) => call === ipcChannels.appSettingsUpdate)).toHaveLength(2);
  });
});

describe("step 2: the tier card", () => {
  it("reads this computer and the model list together, hardware first, before anything is fetched", async () => {
    const { controller, recorded } = await toMode();
    expect(recorded.calls).toEqual([
      ipcChannels.onboardingState,
      ipcChannels.appSettingsUpdate,
      ipcChannels.hardwareProfile,
      ipcChannels.localModelsList
    ]);
    const { mode } = controller.getSnapshot();
    expect(mode.hardware).toMatchObject({ status: "ready" });
    expect(mode.catalog).toMatchObject({ status: "ready" });
    expect(mode.selected).toBe("hybrid");
  });

  it("selects what the tier table recommends, and keeps the person's own pick across a retry", async () => {
    const { controller } = await toMode({ hardware: { ...macHardware, recommended: "local" } });
    expect(controller.getSnapshot().mode.selected).toBe("local");
    controller.selectPreset("cloud");
    controller.retryCard();
    await settle();
    expect(controller.getSnapshot().mode.selected).toBe("cloud");
  });

  it("keeps working when this computer cannot be read: the card says so and offers a retry", async () => {
    const { controller, recorded } = await toMode({ hardware: "error" });
    expect(controller.getSnapshot().mode.hardware).toEqual({ status: "error" });
    expect(controller.getSnapshot().mode.selected).toBe("hybrid");
    controller.selectPreset("cloud");
    expect(controller.getSnapshot().mode.selected).toBe("cloud");
    controller.retryCard();
    await settle();
    expect(recorded.calls.filter((call) => call === ipcChannels.hardwareProfile)).toHaveLength(2);
  });

  it("keeps working when the model list cannot be read: sizes are unknown, nothing else", async () => {
    const { controller } = await toMode({ models: "error" });
    expect(controller.getSnapshot().mode.catalog).toEqual({ status: "error" });
    expect(controller.getSnapshot().mode.hardware.status).toBe("ready");
  });

  it("drops an older read of the card that arrives after a newer one", async () => {
    const { controller, recorded } = make();
    const answers: Array<(hardware: OnboardingHardware) => void> = [];
    recorded.api.hardware.profile = () =>
      new Promise<OnboardingHardware>((resolve) => void answers.push(resolve));
    await controller.start();
    await controller.submitLanguages();
    controller.retryCard();
    expect(answers).toHaveLength(2);
    answers[1]!(windowsHardware);
    await settle();
    answers[0]!(macHardware);
    await settle();
    expect(controller.getSnapshot().mode.hardware).toEqual({
      status: "ready",
      value: windowsHardware
    });
  });

  it("refuses Local off Apple silicon and says why, without changing the pick", async () => {
    const { controller } = await toMode({ hardware: windowsHardware });
    controller.selectPreset("local");
    expect(controller.getSnapshot().mode).toMatchObject({
      selected: "hybrid",
      refusal: "no_local_writer_for_platform"
    });
    controller.selectPreset("cloud");
    expect(controller.getSnapshot().mode).toMatchObject({ selected: "cloud", refusal: null });
  });

  it("refuses Local where the tier table says its writer does not fit, and says so", async () => {
    const { controller } = await toMode({
      hardware: { ...smallMacHardware, recommended: "hybrid" }
    });
    controller.selectPreset("local");
    expect(controller.getSnapshot().mode).toMatchObject({ selected: "hybrid", refusal: "memory" });
  });

  it("accepts Local on Apple silicon, also through Rosetta", async () => {
    const { controller } = await toMode({ hardware: { ...macHardware, translated: true } });
    controller.selectPreset("local");
    expect(controller.getSnapshot().mode).toMatchObject({ selected: "local", refusal: null });
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
  });

  it("goes back to the languages from the mode", async () => {
    const { controller } = await toMode();
    controller.back();
    expect(controller.getSnapshot()).toMatchObject({ phase: "languages", step: 1 });
  });
});

describe("step 2: Hybrid signs in to the writer first", () => {
  it("does not start before the writer is ready, and no model or setup call is made", async () => {
    const { controller, recorded } = await toMode();
    expect(canStartSetup(controller.getSnapshot())).toBe(false);
    controller.startSetup();
    await settle();
    expect(controller.getSnapshot().phase).toBe("mode");
    expect(recorded.calls).not.toContain(ipcChannels.localModelsDownload);
    expect(recorded.calls).not.toContain(ipcChannels.aiApplyPreset);
  });

  it("signs in with ChatGPT, takes the first model, and lets the person choose another", async () => {
    const { controller } = await toMode();
    const signing = controller.signInCodex();
    expect(controller.getSnapshot().mode.writer.codex.status).toBe("connecting");
    await signing;
    expect(controller.getSnapshot().mode.writer.codex).toMatchObject({
      status: "connected",
      modelId: "gpt-5.6-luna",
      models: ["gpt-5.6-luna", "gpt-5.6"]
    });
    controller.setCodexModel("gpt-5.6");
    expect(controller.getSnapshot().mode.writer.codex.modelId).toBe("gpt-5.6");
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
  });

  it("shows a sign-in that failed, with its own message, and lets it be tried again", async () => {
    const { controller, recorded } = await toMode({ failOnce: [ipcChannels.aiOpenAiCodexConnect] });
    await controller.signInCodex();
    expect(controller.getSnapshot().mode.writer.codex).toMatchObject({
      status: "failed",
      error: { key: "errors.common.unknown" }
    });
    expect(canStartSetup(controller.getSnapshot())).toBe(false);
    await controller.signInCodex();
    expect(controller.getSnapshot().mode.writer.codex.status).toBe("connected");
    expect(recorded.calls.filter((call) => call === ipcChannels.aiOpenAiCodexConnect)).toHaveLength(
      2
    );
  });

  it("makes exactly the calls of the first-run fixture for a ChatGPT writer", async () => {
    const { controller, recorded } = await toMode();
    await signInAndStart(controller);
    expect(controller.getSnapshot().setup.status).toBe("done");
    expect(recorded.calls).toEqual(hybridSetupSequence("codex").map((call) => call.channel));
    // What the harness invokes is the same list without the browser sign-in it cannot play.
    expect(recorded.calls.filter((call) => call !== ipcChannels.aiOpenAiCodexConnect)).toEqual(
      invokedSetupChannels("codex")
    );
  });

  it("makes exactly the calls of the first-run fixture for an API key writer", async () => {
    const { controller, recorded } = await toMode();
    controller.setWriterMethod("key");
    controller.setKeyProvider("openai-compatible");
    controller.setKeyField("baseUrl", "https://models.example.com/v1");
    controller.setKeyField("modelId", "writer-1");
    controller.setApiKey("  sk-secret-key-value  ");
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
    controller.startSetup();
    await settle();
    expect(recorded.calls).toEqual(hybridSetupSequence("remote").map((call) => call.channel));
    expect(recorded.payloads[ipcChannels.aiProvidersSave]).toEqual([
      expect.objectContaining({
        provider: "openai-compatible",
        baseUrl: "https://models.example.com/v1",
        apiKey: "sk-secret-key-value",
        modelId: "writer-1",
        capabilities: [...writerCapabilities]
      })
    ]);
  });

  it("never keeps the API key in what the screen reads, and forgets it once it is saved", async () => {
    const { controller } = await toMode();
    controller.setWriterMethod("key");
    controller.setKeyField("modelId", "writer-1");
    controller.setApiKey("sk-secret-key-value");
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("sk-secret-key-value");
    expect(controller.getSnapshot().mode.writer.key.hasKey).toBe(true);
    controller.startSetup();
    await settle();
    expect(JSON.stringify(controller.getSnapshot())).not.toContain("sk-secret-key-value");
  });

  it("forgets the key with the field: leaving the key form, or the writer, empties both", async () => {
    const { controller } = await toMode();
    controller.setWriterMethod("key");
    controller.setKeyField("modelId", "writer-1");
    controller.setApiKey("sk-secret-key-value");
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
    controller.setWriterMethod("codex");
    controller.setWriterMethod("key");
    expect(controller.getSnapshot().mode.writer.key.hasKey).toBe(false);
    expect(canStartSetup(controller.getSnapshot())).toBe(false);
    controller.setApiKey("sk-secret-key-value");
    controller.selectPreset("local");
    controller.selectPreset("hybrid");
    expect(controller.getSnapshot().mode.writer.key.hasKey).toBe(false);
  });

  it("needs a server address for an OpenAI-compatible key, and a model for any key", async () => {
    const { controller } = await toMode();
    controller.setWriterMethod("key");
    controller.setApiKey("sk-secret-key-value");
    expect(canStartSetup(controller.getSnapshot())).toBe(false);
    controller.setKeyField("modelId", "gemini-x");
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
    controller.setKeyProvider("openai-compatible");
    expect(canStartSetup(controller.getSnapshot())).toBe(false);
    controller.setKeyField("baseUrl", "not a url");
    expect(canStartSetup(controller.getSnapshot())).toBe(false);
    controller.setKeyField("baseUrl", "http://127.0.0.1:1234/v1");
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
  });

  it("saves the ChatGPT writer as Settings does: provider, then profile, then the profile's model", async () => {
    const { controller, recorded } = await toMode();
    await signInAndStart(controller);
    expect(recorded.payloads[ipcChannels.aiProvidersSave]).toEqual([
      expect.objectContaining({
        provider: "openai-codex",
        displayName: "ChatGPT",
        modelId: "gpt-5.6-luna",
        capabilities: [...codexWriterCapabilities]
      })
    ]);
    expect(codexWriterCapabilities).not.toContain("requires-api-key");
    expect(recorded.payloads[ipcChannels.aiProfilesCreate]).toEqual([
      expect.objectContaining({
        name: "Writing model",
        isDefault: true,
        privacyMode: "allow_remote"
      })
    ]);
    expect(recorded.payloads[ipcChannels.aiProfilesUpdate]).toEqual([
      expect.objectContaining({ modelId: "gpt-5.6-luna", runtime: "remote" })
    ]);
  });
});

describe("step 2: the setup", () => {
  it("installs the embedder, waits for it, applies Hybrid without testing, then tests each class in order", async () => {
    const { controller, recorded } = await toMode({ installs: "event" });
    await signInAndStart(controller);
    expect(recorded.payloads[ipcChannels.localModelsDownload]).toEqual([
      { catalogId: presetCatalogIds.embedding, acceptLicense: false }
    ]);
    expect(recorded.payloads[ipcChannels.aiApplyPreset]).toEqual([
      { preset: "hybrid", test: false }
    ]);
    expect(recorded.payloads[ipcChannels.aiTestClassRoute]).toEqual([...firstRunClassTests]);
    const setup = controller.getSnapshot().setup;
    expect(setup.steps).toEqual({
      writer: "done",
      models: "done",
      preset: "done",
      tests: "done"
    });
    expect(setup.tests.map((test) => test.state)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed"
    ]);
  });

  it("waits for the embedder before it applies anything", async () => {
    const { controller, recorded } = await toMode({ installs: "manual" });
    await controller.signInCodex();
    controller.startSetup();
    await settle();
    expect(recorded.calls).toContain(ipcChannels.localModelsDownload);
    expect(recorded.calls).not.toContain(ipcChannels.aiApplyPreset);
    expect(controller.getSnapshot().setup.steps.models).toBe("running");
    recorded.emit(
      downloadEvent(presetCatalogIds.embedding, "downloading", {
        downloadedBytes: 300,
        totalBytes: 600,
        etaSeconds: 90
      })
    );
    expect(controller.getSnapshot().setup.downloads).toEqual([
      expect.objectContaining({ role: "embedder", state: "downloading", etaSeconds: 90 })
    ]);
    recorded.emit(downloadEvent(presetCatalogIds.embedding, "ready"));
    await settle();
    expect(recorded.calls).toContain(ipcChannels.aiApplyPreset);
    expect(controller.getSnapshot().setup.status).toBe("done");
  });

  it("follows the ranker beside the setup and never waits for it", async () => {
    const { controller, recorded } = await toMode({ installs: "instant" });
    await signInAndStart(controller);
    expect(controller.getSnapshot().setup.status).toBe("done");
    recorded.emit(downloadEvent(presetCatalogIds.rankerMlx, "downloading", { totalBytes: 600 }));
    expect(controller.getSnapshot().setup.downloads.map((entry) => entry.role)).toEqual([
      "embedder",
      "ranker"
    ]);
    recorded.emit(
      downloadEvent(presetCatalogIds.rankerMlx, "failed", {
        error: "errors.localModels.downloadHttp"
      })
    );
    expect(controller.getSnapshot().setup.downloads.at(-1)).toMatchObject({
      role: "ranker",
      state: "failed",
      error: "errors.localModels.downloadHttp"
    });
    // The setup stays done: relations wait for the ranker, nothing else does.
    expect(controller.getSnapshot().setup.status).toBe("done");
  });

  it("ignores installs that are not part of the first run", async () => {
    const { controller, recorded } = await toMode();
    await signInAndStart(controller);
    const before = controller.getSnapshot().setup.downloads.length;
    recorded.emit(downloadEvent("gguf-some-other-model", "downloading"));
    expect(controller.getSnapshot().setup.downloads).toHaveLength(before);
  });

  it("does not stop at a class test that fails or throws: it is a finding, and every test runs", async () => {
    const { controller, recorded } = await toMode({
      failingTests: ["write-quality"],
      throwingTests: ["judge"]
    });
    await signInAndStart(controller);
    const setup = controller.getSnapshot().setup;
    expect(recorded.payloads[ipcChannels.aiTestClassRoute]).toEqual([...firstRunClassTests]);
    expect(setup.status).toBe("done");
    expect(setup.steps.tests).toBe("done");
    expect(setup.tests.map((test) => [test.route, test.state])).toEqual([
      ["embed", "passed"],
      ["write-fast", "passed"],
      ["write-quality", "failed"],
      ["answer", "passed"],
      ["judge", "failed"]
    ]);
    expect(failedTestCount(setup.tests)).toBe(2);
    expect(setup.tests[2]!.error).toBe("errors.ai.invalidOutput");
    expect(controller.getSnapshot().announcement?.message).toEqual({
      key: "onboarding.live.setupDone",
      values: { count: 2 }
    });
    controller.continueToSource();
    expect(controller.getSnapshot()).toMatchObject({ phase: "source", step: 3 });
  });

  it("stops at a model that cannot be installed, keeps the failure, and goes on from there on retry", async () => {
    const { controller, recorded } = await toMode({ installs: "manual" });
    await controller.signInCodex();
    controller.startSetup();
    await settle();
    recorded.emit(
      downloadEvent(presetCatalogIds.embedding, "failed", {
        error: "errors.localModels.downloadHttp"
      })
    );
    await settle();
    let setup = controller.getSnapshot().setup;
    expect(setup).toMatchObject({
      status: "failed",
      failure: { step: "models", message: { key: "errors.localModels.downloadHttp" } }
    });
    expect(setup.steps).toMatchObject({ writer: "done", models: "failed", preset: "pending" });
    expect(recorded.calls).not.toContain(ipcChannels.aiApplyPreset);

    controller.retrySetup();
    await settle();
    recorded.emit(downloadEvent(presetCatalogIds.embedding, "ready"));
    await settle();
    setup = controller.getSnapshot().setup;
    expect(setup.status).toBe("done");
    // The writer was saved once: a retry never signs in or saves a second provider.
    expect(recorded.calls.filter((call) => call === ipcChannels.aiProvidersSave)).toHaveLength(1);
    expect(recorded.calls.filter((call) => call === ipcChannels.aiProfilesCreate)).toHaveLength(1);
  });

  it("goes on without a part that failed", async () => {
    const { controller, recorded } = await toMode({ failOnce: [ipcChannels.aiProvidersSave] });
    await signInAndStart(controller);
    expect(controller.getSnapshot().setup).toMatchObject({
      status: "failed",
      failure: { step: "writer" }
    });
    expect(recorded.calls).not.toContain(ipcChannels.localModelsDownload);
    controller.continueToSource();
    expect(controller.getSnapshot().phase).toBe("source");
    // The embedder does not need the writer: it is still asked for, and installs in the background.
    await settle();
    expect(recorded.payloads[ipcChannels.localModelsDownload]).toEqual([
      { catalogId: presetCatalogIds.embedding, acceptLicense: false }
    ]);
    expect(recorded.calls).not.toContain(ipcChannels.aiApplyPreset);
  });

  it("asks for nothing more when the models already ran before the part that failed", async () => {
    const { controller, recorded } = await toMode({
      presetAnswers: [
        {
          applied: false,
          blocked: [{ route: null, reason: "no_remote_profile", catalogId: null, modelName: null }]
        }
      ]
    });
    await signInAndStart(controller);
    expect(controller.getSnapshot().setup.failure?.step).toBe("preset");
    controller.continueToSource();
    await settle();
    expect(recorded.calls.filter((call) => call === ipcChannels.localModelsDownload)).toHaveLength(
      1
    );
  });

  it("does not repeat a provider or a profile that was saved when the step is tried again", async () => {
    const { controller, recorded } = await toMode({ failOnce: [ipcChannels.aiProfilesUpdate] });
    await signInAndStart(controller);
    expect(controller.getSnapshot().setup.failure?.step).toBe("writer");
    controller.retrySetup();
    await settle();
    expect(controller.getSnapshot().setup.status).toBe("done");
    expect(recorded.calls.filter((call) => call === ipcChannels.aiProvidersSave)).toHaveLength(1);
    expect(recorded.calls.filter((call) => call === ipcChannels.aiProfilesCreate)).toHaveLength(1);
    expect(recorded.calls.filter((call) => call === ipcChannels.aiProfilesUpdate)).toHaveLength(2);
  });

  it("shows why a setup could not be applied, and lets the person go on", async () => {
    const { controller } = await toMode({
      presetAnswers: [
        {
          applied: false,
          blocked: [{ route: null, reason: "no_remote_profile", catalogId: null, modelName: null }]
        }
      ]
    });
    await signInAndStart(controller);
    const setup = controller.getSnapshot().setup;
    expect(setup).toMatchObject({
      status: "failed",
      failure: { step: "preset", message: { key: "onboarding.setup.failed.preset" } },
      blocked: [{ reason: "no_remote_profile" }]
    });
    controller.continueToSource();
    expect(controller.getSnapshot().phase).toBe("source");
  });

  it("installs a model the setup names and applies it once more", async () => {
    const { controller, recorded } = await toMode({
      presetAnswers: [
        {
          applied: false,
          blocked: [
            {
              route: "write-fast",
              reason: "model_missing",
              catalogId: presetCatalogIds.writerLarge,
              modelName: "Writer"
            }
          ]
        },
        { applied: true, blocked: [] }
      ]
    });
    await signInAndStart(controller);
    expect(recorded.payloads[ipcChannels.localModelsDownload]).toEqual([
      { catalogId: presetCatalogIds.embedding, acceptLicense: false },
      { catalogId: presetCatalogIds.writerLarge, acceptLicense: false }
    ]);
    expect(recorded.calls.filter((call) => call === ipcChannels.aiApplyPreset)).toHaveLength(2);
    expect(controller.getSnapshot().setup.status).toBe("done");
  });
});

describe("step 2: Local", () => {
  it("installs the embedder and the writer for the memory, signs in to nothing, and tests every class", async () => {
    const { controller, recorded } = await toMode({
      hardware: { ...macHardware, recommended: "local" }
    });
    expect(controller.getSnapshot().mode.selected).toBe("local");
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
    controller.startSetup();
    await settle();
    expect(recorded.calls).toEqual([
      ipcChannels.onboardingState,
      ipcChannels.appSettingsUpdate,
      ipcChannels.hardwareProfile,
      ipcChannels.localModelsList,
      ipcChannels.localModelsDownload,
      ipcChannels.localModelsDownload,
      ipcChannels.aiApplyPreset,
      ...firstRunClassTests.map(() => ipcChannels.aiTestClassRoute)
    ]);
    expect(recorded.payloads[ipcChannels.localModelsDownload]).toEqual([
      { catalogId: presetCatalogIds.embedding, acceptLicense: false },
      { catalogId: presetCatalogIds.writerLarge, acceptLicense: false }
    ]);
    expect(recorded.payloads[ipcChannels.aiApplyPreset]).toEqual([
      { preset: "local", test: false }
    ]);
    expect(controller.getSnapshot().setup.steps.writer).toBe("skipped");
  });

  it("installs the writer the tier table names for this computer", async () => {
    const { controller, recorded } = await toMode({
      hardware: {
        ...macHardware,
        memoryBytes: 16 * 1024 ** 3,
        recommended: "local",
        local: { ...macHardware.local, writerCatalogId: presetCatalogIds.writerSmall }
      }
    });
    controller.startSetup();
    await settle();
    expect(recorded.payloads[ipcChannels.localModelsDownload]).toEqual([
      { catalogId: presetCatalogIds.embedding, acceptLicense: false },
      { catalogId: presetCatalogIds.writerSmall, acceptLicense: false }
    ]);
  });

  it("guesses no writer when this computer could not be read: it installs the one the setup names", async () => {
    const { controller, recorded } = await toMode({
      hardware: "error",
      presetAnswers: [
        {
          applied: false,
          blocked: [
            {
              route: "write-fast",
              reason: "model_missing",
              catalogId: presetCatalogIds.writerLarge,
              modelName: "Writer"
            }
          ]
        },
        { applied: true, blocked: [] }
      ]
    });
    controller.selectPreset("local");
    expect(canStartSetup(controller.getSnapshot())).toBe(true);
    controller.startSetup();
    await settle();
    // Only the embedder before the setup is applied, then the one writer the main process names.
    expect(recorded.payloads[ipcChannels.localModelsDownload]).toEqual([
      { catalogId: presetCatalogIds.embedding, acceptLicense: false },
      { catalogId: presetCatalogIds.writerLarge, acceptLicense: false }
    ]);
    expect(controller.getSnapshot().setup.status).toBe("done");
  });
});

describe("step 3 and leaving", () => {
  it("records the first run when the first source is saved, and hands the source to the app", async () => {
    const { controller, recorded } = await toMode();
    await signInAndStart(controller);
    controller.continueToSource();
    await controller.sourceSaved("source-1", "import.status.queuedChildren");
    expect(recorded.payloads[ipcChannels.onboardingFinish]).toEqual([{ outcome: "completed" }]);
    expect(controller.getSnapshot()).toMatchObject({
      phase: "done",
      openedSourceId: "source-1",
      openedStatus: "import.status.queuedChildren"
    });
  });

  it("opens the source even if recording the first run fails", async () => {
    const { controller } = await toMode({ failOnce: [ipcChannels.onboardingFinish] });
    await signInAndStart(controller);
    controller.continueToSource();
    await controller.sourceSaved("source-1");
    expect(controller.getSnapshot()).toMatchObject({ phase: "done", openedSourceId: "source-1" });
  });

  it("skips from the first step: the first run is recorded as skipped and the app shows", async () => {
    const { controller, recorded } = make();
    await controller.start();
    await controller.skip();
    expect(recorded.payloads[ipcChannels.onboardingFinish]).toEqual([{ outcome: "skipped" }]);
    expect(controller.getSnapshot().phase).toBe("off");
  });

  it("skips in the middle of the setup: nothing more is called, and a late install changes nothing", async () => {
    const { controller, recorded } = await toMode({ installs: "manual" });
    await controller.signInCodex();
    controller.startSetup();
    await settle();
    await controller.skip();
    expect(controller.getSnapshot().phase).toBe("off");
    const calls = recorded.calls.length;
    recorded.emit(downloadEvent(presetCatalogIds.embedding, "ready"));
    await settle();
    expect(recorded.calls.slice(calls)).toEqual([]);
    expect(recorded.calls).not.toContain(ipcChannels.aiApplyPreset);
    expect(controller.getSnapshot().phase).toBe("off");
  });

  it("still leaves when recording the skip fails", async () => {
    const { controller } = make({ failOnce: [ipcChannels.onboardingFinish] });
    await controller.start();
    await controller.skip();
    expect(controller.getSnapshot()).toMatchObject({ phase: "off", skipping: false });
  });

  it("ignores everything after it let go", async () => {
    const { controller } = make();
    await controller.start();
    controller.dispose();
    await controller.submitLanguages();
    expect(controller.getSnapshot().phase).toBe("languages");
  });
});
