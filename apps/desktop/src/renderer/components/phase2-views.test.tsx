import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { AiSettingsView } from "./AiSettingsView";
import { ImportView } from "./ImportView";
import { JobsView } from "./JobsView";
import { SearchView } from "./SearchView";
import { LibraryView } from "./LibraryView";
import { ReviewQueueView } from "./ReviewQueueView";
import { LocalModelsView } from "./LocalModelsView";
import { BackupView } from "./BackupView";

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
    expect(renderToString(<JobsView t={t} />)).toContain("No jobs yet");
    expect(renderToString(<AiSettingsView t={t} />)).toContain("AI providers and profiles");
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
