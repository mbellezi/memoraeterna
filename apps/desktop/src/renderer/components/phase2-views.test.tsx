import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { AiSettingsView, resolveProviderTestStatus } from "./AiSettingsView";
import { AiParameterFields } from "./AiParameterFields";
import { FileImportProgressCard, ImportView } from "./ImportView";
import { JobsView } from "./JobsView";
import { groupJobs } from "./jobs-view-model";
import {
  appSettingsSchema,
  defaultAppSettings,
  defaultStorageSettings,
  jobRecordSchema,
  librarySourceSchema,
  localModelViewSchema,
  storageSettingsSchema
} from "../../shared/ipc";
import { SearchView } from "./SearchView";
import { LibraryView, orderHierarchically } from "./LibraryView";
import { ReviewQueueView } from "./ReviewQueueView";
import {
  LocalModelDefaults,
  LocalModelsView,
  recommendedParametersForCurrentMode
} from "./LocalModelsView";
import { BackupView } from "./BackupView";
import { SettingsView } from "./SettingsView";

const t = createTranslator("en");

describe("phase 2 renderer views", () => {
  it("renders the source-type step of the ingestion wizard", () => {
    const html = renderToString(<ImportView t={t} />);
    expect(html).toContain("Search source types");
    expect(html).toContain("Personal note");
    expect(html).toContain("Metadata");
    expect(html).toContain("Continue");
  });

  it("renders real file page progress with elapsed time", () => {
    const html = renderToString(<FileImportProgressCard
      progress={{
        requestId: "00000000-0000-4000-8000-000000000001",
        stage: "processing_pages",
        progress: 0.37,
        completedPages: 37,
        totalPages: 100
      }}
      elapsedSeconds={83}
      t={t}
    />);
    expect(html).toContain("37 of 100 pages processed");
    expect(html).toContain("37%");
    expect(html).toContain("01:23");
    expect(html).toContain('role="progressbar"');
  });

  it("renders search, jobs and AI settings empty states", () => {
    expect(renderToString(<SearchView t={t} />)).toContain("Search sources and evidence");
    expect(renderToString(<JobsView t={t} />)).toContain("Your processing workspace is ready");
    const aiSettings = renderToString(<AiSettingsView t={t} />);
    expect(aiSettings).toContain("AI providers and profiles");
    expect(aiSettings).toContain("Load models");
    expect(aiSettings).toContain("ChatGPT subscription (OAuth)");
  });

  it("reports remote model connection test results", async () => {
    await expect(resolveProviderTestStatus(async () => true)).resolves.toBe("settings.ai.connectionOk");
    await expect(resolveProviderTestStatus(async () => { throw new Error("errors.ai.oauthRefreshFailed"); })).resolves.toBe("errors.ai.oauthRefreshFailed");
    await expect(resolveProviderTestStatus(async () => { throw new Error("request failed"); })).resolves.toBe("errors.ai.connectionFailed");
  });

  it("renders only the reasoning controls declared by the model", () => {
    const qwen = renderToString(<AiParameterFields
      value={{}}
      onChange={() => undefined}
      capabilities={{ reasoning: { levels: ["off", "on"] } }}
      t={t}
    />);
    expect(qwen).toContain("Off");
    expect(qwen).toContain("On");
    expect(qwen).not.toContain("Minimal");
    expect(qwen).not.toContain("Maximum reasoning tokens");

    const budget = renderToString(<AiParameterFields
      value={{ reasoningLevel: "on", reasoningMaxTokens: 4_096 }}
      onChange={() => undefined}
      capabilities={{
        reasoning: {
          levels: ["off", "on"],
          maxTokens: { min: 1, max: 24_576, step: 1 }
        }
      }}
      t={t}
    />);
    expect(budget).toContain("Maximum reasoning tokens");
    expect(budget).toContain('max="24576"');
  });

  it("does not clamp a numeric field while the user is still typing", () => {
    const html = renderToString(<AiParameterFields
      value={{ contextWindow: 8 }}
      onChange={() => undefined}
      capabilities={{ contextWindow: { min: 128, max: 32_768, step: 1 } }}
      t={t}
    />);

    expect(html).toContain('value="8"');
    expect(html).not.toContain('value="128"');
  });

  it("renders sampling controls only when the model declares them", () => {
    const supported = renderToString(<AiParameterFields
      value={{ temperature: 1, topP: 0.95, topK: 20, presencePenalty: 1.5 }}
      onChange={() => undefined}
      capabilities={{
        temperature: { min: 0, max: 2, step: 0.1 },
        topP: { min: 0, max: 1, step: 0.05 },
        topK: { min: 1, step: 1 },
        presencePenalty: { min: 0, max: 2, step: 0.1 }
      }}
      t={t}
    />);
    const unsupported = renderToString(<AiParameterFields
      value={{}}
      onChange={() => undefined}
      capabilities={{ temperature: { min: 0, max: 2, step: 0.1 } }}
      t={t}
    />);

    expect(supported).toContain("Temperature");
    expect(supported).toContain("Top P");
    expect(supported).toContain("Top K");
    expect(supported).toContain("Presence penalty");
    expect(unsupported).not.toContain("Top K");
    expect(unsupported).not.toContain("Presence penalty");
  });

  it("reloads the recommended local preset for the reasoning mode selected in the model card", () => {
    const recommendedParameters = {
      reasoning: { reasoningLevel: "on" as const, temperature: 1, topP: 0.95, topK: 20 },
      nonReasoning: { reasoningLevel: "off" as const, temperature: 0.7, topP: 0.8, topK: 20 }
    };
    expect(recommendedParametersForCurrentMode(
      { recommendedParameters },
      { reasoningLevel: "on", temperature: 0.2 }
    )).toEqual(recommendedParameters.reasoning);
    expect(recommendedParametersForCurrentMode(
      { recommendedParameters },
      { reasoningLevel: "off", temperature: 0.2 }
    )).toEqual(recommendedParameters.nonReasoning);

    const model = localModelViewSchema.parse({
      id: "00000000-0000-4000-8000-000000000001",
      catalogId: "mlx-qwen-test",
      modelId: "repo/model",
      displayName: "Qwen test",
      family: "Qwen",
      variant: "Test",
      repository: "repo/model",
      revision: "a".repeat(40),
      runtime: "mlx",
      format: "safetensors",
      quantization: "4-bit",
      capabilities: ["text-generation", "offline"],
      parameterCapabilities: {
        temperature: { min: 0, max: 2, step: 0.1 },
        topP: { min: 0, max: 1, step: 0.05 },
        topK: { min: 1, step: 1 },
        reasoning: { levels: ["off", "on"] }
      },
      defaultParameters: recommendedParameters.nonReasoning,
      recommendedParameters,
      minimumMemoryBytes: 1,
      recommendedMemoryBytes: 2,
      expectedSizeBytes: 10,
      installedSizeBytes: 0,
      licenseName: "Test",
      licenseUrl: "https://example.test/license",
      requiresLicenseAcceptance: false,
      licenseAccepted: false,
      status: "not_downloaded",
      compatible: true,
      compatibilityReason: "compatible",
      profilesUsing: [],
      lastError: null,
      download: null
    });
    const html = renderToString(<LocalModelDefaults model={model} t={t} onSave={async () => undefined} />);
    expect(html).toContain("Reload recommended defaults");
  });

  it("renders settings as scoped dashboard instead of a single configuration list", () => {
    const html = renderToString(
      <SettingsView
        appSettings={appSettingsSchema.parse({
          ...defaultAppSettings,
          language: "en",
          updatedAt: new Date(0).toISOString()
        })}
        settings={storageSettingsSchema.parse({
          ...defaultStorageSettings,
          updatedAt: new Date(0).toISOString()
        })}
        status="shell.states.ready"
        isSaving={false}
        t={t}
        onAppSettingsChange={() => undefined}
        onRelationThresholdChange={async () => undefined}
        onChange={() => undefined}
        onSelectObsidianVault={async () => undefined}
        onSave={() => undefined}
      />
    );

    expect(html).toContain("Configure your knowledge workspace");
    expect(html).toContain("Configuration scopes");
    expect(html).toContain("Appearance &amp; matching");
    expect(html).toContain("Data &amp; safety");
  });

  it("groups a parent ingestion and its AI stage into one file workflow", () => {
    const ingestionRun = {
      id: "00000000-0000-4000-8000-000000000010",
      status: "running" as const,
      currentStage: "summarization",
      stagesCheckpoint: { conversion: { status: "completed" }, summarization: { status: "running" } }
    };
    const source = {
      id: "00000000-0000-4000-8000-000000000020",
      title: "A professional dashboard.pdf",
      type: "GenericDocument" as const,
      origin: "file"
    };
    const common = {
      status: "running" as const,
      attempts: 1,
      maxAttempts: 3,
      canCancel: true,
      canRetry: false,
      error: null,
      errorHistory: [],
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:01:00.000Z",
      aiExecution: null,
      ingestionRun,
      source
    };
    const grouped = groupJobs([
      jobRecordSchema.parse({ ...common, id: "00000000-0000-4000-8000-000000000001", type: "ingestion", progress: 0.68 }),
      jobRecordSchema.parse({
        ...common,
        id: "00000000-0000-4000-8000-000000000002",
        type: "summarization",
        progress: 0.42,
        aiExecution: {
          provider: "openai-codex",
          modelId: "gpt-5.4",
          reasoningLevel: "xhigh"
        }
      })
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.jobs).toHaveLength(2);
    expect(grouped[0]?.source?.title).toBe("A professional dashboard.pdf");
    expect(grouped[0]?.progress).toBe(0.68);
    expect(grouped[0]?.jobs[1]?.aiExecution).toEqual({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      reasoningLevel: "xhigh"
    });
  });

  it("renders the phase 3 library and atomic note review empty states", () => {
    expect(renderToString(<LibraryView t={t} />)).toContain("Filter by source type");
    expect(renderToString(<ReviewQueueView t={t} />)).toContain("Loading");
  });

  it("orders parsed sub-elements by their structural position", () => {
    const updatedAt = new Date(0).toISOString();
    const source = (input: {
      id: string;
      title: string;
      parentSourceItemId: string | null;
      structurePosition: number | null;
    }) => librarySourceSchema.parse({
      ...input,
      childCount: 0,
      hasDocument: true,
      type: input.parentSourceItemId ? "DocumentSection" : "AcademicPaper",
      subtitle: null,
      sourceUri: null,
      language: "en",
      summary: null,
      metadata: {},
      processingStatus: "pending",
      currentStage: "queued",
      updatedAt
    });
    const rootId = "00000000-0000-4000-8000-000000000001";
    const firstId = "00000000-0000-4000-8000-000000000002";
    const ordered = orderHierarchically([
      source({ id: rootId, title: "Paper", parentSourceItemId: null, structurePosition: null }),
      source({ id: "00000000-0000-4000-8000-000000000004", title: "Third", parentSourceItemId: rootId, structurePosition: 4 }),
      source({ id: firstId, title: "First", parentSourceItemId: rootId, structurePosition: 0 }),
      source({ id: "00000000-0000-4000-8000-000000000005", title: "First detail", parentSourceItemId: firstId, structurePosition: 1 }),
      source({ id: "00000000-0000-4000-8000-000000000003", title: "Second", parentSourceItemId: rootId, structurePosition: 2 })
    ]);

    expect(ordered.map(({ source: item }) => item.title)).toEqual([
      "Paper", "First", "First detail", "Second", "Third"
    ]);
    expect(orderHierarchically([
      source({ id: "00000000-0000-4000-8000-000000000004", title: "Third", parentSourceItemId: rootId, structurePosition: 4 }),
      source({ id: firstId, title: "First", parentSourceItemId: rootId, structurePosition: 0 }),
      source({ id: "00000000-0000-4000-8000-000000000003", title: "Second", parentSourceItemId: rootId, structurePosition: 2 })
    ]).map(({ source: item }) => item.title)).toEqual(["First", "Second", "Third"]);
  });

  it("renders phase 5 local model and backup controls", () => {
    expect(renderToString(<LocalModelsView t={t} />)).toContain("Local models");
    expect(renderToString(<LocalModelsView t={t} />)).toContain("Import GGUF");
    expect(renderToString(<BackupView t={t} />)).toContain("Create backup");
  });
});
