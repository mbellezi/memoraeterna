import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resolveProcessingPlan } from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { confirmedStatus } from "./ImportView";
import { libraryHistoryEntryForOpening, libraryProcessingPlan } from "./LibraryView";
import { interactiveProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";

const stages = (plan: ReturnType<typeof interactiveProcessingPlan>) =>
  resolveProcessingPlan(plan).effectiveStages;
const source = (overrides: Partial<Parameters<typeof libraryProcessingPlan>[1][number]> = {}) => ({
  id: "00000000-0000-4000-8000-000000000001",
  hasDocument: true,
  embeddingNeedsRefresh: false,
  ...overrides
});

describe("interactive processing defaults", () => {
  it("defaults to the second brain plan when a writer route is ready", () => {
    const plan = interactiveProcessingPlan(true);
    expect(plan.preset).toBe("full_knowledge");
    expect(stages(plan)).toEqual(
      expect.arrayContaining(["embedding", "summarization", "atomicNotes", "knowledgeGraph"])
    );
  });

  it("defaults to searchable processing, with no generative AI stage, otherwise", () => {
    for (const readiness of [false, null]) {
      const plan = interactiveProcessingPlan(readiness);
      expect(plan.preset).toBe("search_ready");
      expect(stages(plan)).toEqual(expect.arrayContaining(["chunking", "embedding"]));
      expect(stages(plan)).not.toContain("summarization");
      expect(stages(plan)).not.toContain("atomicNotes");
    }
  });

  it("keeps import only one click away", () => {
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language);
      const html = renderToString(
        <ProcessingPlanPicker
          value={interactiveProcessingPlan(true)}
          onChange={() => undefined}
          t={t}
        />
      );
      // The second brain plan is the one selected; the other presets stay selectable.
      expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
      for (const preset of ["import_only", "search_ready", "summary", "full_knowledge"] as const)
        expect(html).toContain(t(`processing.presets.${preset}.title`));
    }
  });

  it("explains the searchable default only when no writer route is ready", () => {
    const render = (ready: boolean | null) =>
      renderToString(
        <ProcessingPlanPicker
          value={interactiveProcessingPlan(ready)}
          onChange={() => undefined}
          writerRouteReady={ready}
          t={createTranslator("en")}
        />
      );
    expect(render(false)).toContain("No AI model is ready for writing");
    expect(render(true)).not.toContain("No AI model is ready for writing");
    expect(render(null)).not.toContain("No AI model is ready for writing");
    expect(render(true)).toContain("Second brain");
  });

  it("offers the hint and the second brain name in every locale", () => {
    for (const language of supportedLanguageCodes) {
      const html = renderToString(
        <ProcessingPlanPicker
          value={interactiveProcessingPlan(false)}
          onChange={() => undefined}
          writerRouteReady={false}
          t={createTranslator(language)}
        />
      );
      expect(html).not.toContain("[[missing");
    }
  });
});

describe("Library processing dialog defaults", () => {
  const id = source().id;

  it("follows route readiness", () => {
    expect(libraryProcessingPlan([id], [source()], true).preset).toBe("full_knowledge");
    expect(libraryProcessingPlan([id], [source()], false).preset).toBe("search_ready");
    expect(libraryProcessingPlan([id], [source()], null).preset).toBe("search_ready");
  });

  it("only refreshes embeddings when they are stale, whatever the route", () => {
    const plan = libraryProcessingPlan([id], [source({ embeddingNeedsRefresh: true })], true);
    expect(plan.preset).toBe("search_ready");
    expect(plan.forceRegeneration).toBe(true);
    expect(plan.previousArtifactPolicy).toBe("regenerate_selected");
    expect(libraryProcessingPlan([id], [source()], true).forceRegeneration).toBe(false);
  });

  it("targets the selection with the right scope", () => {
    const other = "00000000-0000-4000-8000-000000000002";
    expect(libraryProcessingPlan([id, other], [source()], true)).toMatchObject({
      scope: "selected_items",
      targetSourceItemIds: [id, other]
    });
    expect(libraryProcessingPlan([id], [source({ hasDocument: false })], true).scope).toBe(
      "children_only"
    );
    expect(libraryProcessingPlan([id], [source()], true).scope).toBe("source_only");
  });
});

describe("opening the Library on a source", () => {
  it("returns to the origin view on Back", () => {
    expect(libraryHistoryEntryForOpening("wiki", null)).toEqual({ view: "wiki" });
    expect(libraryHistoryEntryForOpening("knowledgeGraph", null)).toEqual({
      view: "knowledgeGraph"
    });
    expect(libraryHistoryEntryForOpening(undefined, null)).toEqual({ view: "search" });
  });

  it("keeps an import inside the Library, repairing only a foreign history entry", () => {
    expect(
      libraryHistoryEntryForOpening("import", { view: "library", path: ["a"], fromSearch: false })
    ).toBeNull();
    expect(libraryHistoryEntryForOpening("import", { view: "wiki" })).toEqual({
      view: "library",
      path: [],
      fromSearch: false
    });
    expect(libraryHistoryEntryForOpening("import", null)).toEqual({
      view: "library",
      path: [],
      fromSearch: false
    });
  });
});

describe("import outcome", () => {
  it("reports queued children only when a job started", () => {
    expect(confirmedStatus([{ jobId: null }, { jobId: undefined }])).toBe(
      "import.status.savedChildren"
    );
    expect(confirmedStatus([{ jobId: null }, { jobId: "job" }])).toBe(
      "import.status.queuedChildren"
    );
    expect(confirmedStatus([])).toBe("import.status.savedChildren");
  });
});
