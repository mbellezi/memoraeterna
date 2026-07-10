import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { AiSettingsView } from "./AiSettingsView";
import { ImportView } from "./ImportView";
import { JobsView } from "./JobsView";
import { SearchView } from "./SearchView";

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
});
