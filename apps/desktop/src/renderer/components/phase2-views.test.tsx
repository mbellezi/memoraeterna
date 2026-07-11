import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { AiSettingsView } from "./AiSettingsView";
import { ImportView } from "./ImportView";
import { JobsView } from "./JobsView";
import { groupJobs } from "./jobs-view-model";
import {
  appSettingsSchema,
  defaultAppSettings,
  defaultStorageSettings,
  jobRecordSchema,
  storageSettingsSchema
} from "../../shared/ipc";
import { SearchView } from "./SearchView";
import { LibraryView } from "./LibraryView";
import { ReviewQueueView } from "./ReviewQueueView";
import { LocalModelsView } from "./LocalModelsView";
import { BackupView } from "./BackupView";
import { SettingsView } from "./SettingsView";

const t = createTranslator("en");

describe("phase 2 renderer views", () => {
  it("renders the manual and file ingestion controls", () => {
    const html = renderToString(<ImportView t={t} />);
    expect(html).toContain("Manual content");
    expect(html).toContain("Personal note");
    expect(html).toContain("Queue import");
  });

  it("renders search, jobs and AI settings empty states", () => {
    expect(renderToString(<SearchView t={t} />)).toContain("Search sources and evidence");
    expect(renderToString(<JobsView t={t} />)).toContain("Your processing workspace is ready");
    expect(renderToString(<AiSettingsView t={t} />)).toContain("AI providers and profiles");
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
      ingestionRun,
      source
    };
    const grouped = groupJobs([
      jobRecordSchema.parse({ ...common, id: "00000000-0000-4000-8000-000000000001", type: "ingestion", progress: 0.68 }),
      jobRecordSchema.parse({ ...common, id: "00000000-0000-4000-8000-000000000002", type: "summarization", progress: 0.42 })
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.jobs).toHaveLength(2);
    expect(grouped[0]?.source?.title).toBe("A professional dashboard.pdf");
    expect(grouped[0]?.progress).toBe(0.68);
  });

  it("renders the phase 3 library and atomic note review empty states", () => {
    expect(renderToString(<LibraryView t={t} />)).toContain("Filter by source type");
    expect(renderToString(<ReviewQueueView t={t} />)).toContain("Loading");
  });

  it("renders phase 5 local model and backup controls", () => {
    expect(renderToString(<LocalModelsView t={t} />)).toContain("Local models");
    expect(renderToString(<LocalModelsView t={t} />)).toContain("Import GGUF");
    expect(renderToString(<BackupView t={t} />)).toContain("Create backup");
  });
});
