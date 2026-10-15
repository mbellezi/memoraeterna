import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { AiNoteBadge } from "./AiNoteBadge";
import { AtomicNoteCard } from "./LibraryView";
import { SearchResultCard } from "./SearchView";

const t = createTranslator("en");
const escaped = (text: string) => text.replaceAll("'", "&#x27;");
const noteId = "00000000-0000-4000-8000-000000000001";
const sourceId = "00000000-0000-4000-8000-000000000002";
const chunkId = "00000000-0000-4000-8000-000000000003";

const note = (status: string) =>
  ({
    ownership: "source",
    supersessionStatus: "current",
    id: noteId,
    title: "Spacing flattens the curve",
    bodyMarkdown: "Reviewing at spaced intervals flattens the forgetting curve.",
    ideaStatement: "Spacing flattens forgetting.",
    language: "en",
    status,
    sourceItemId: sourceId,
    sourceSpanId: null,
    evidenceChunkId: chunkId,
    generationModel: "model",
    generationPromptVersion: "atomic-note-v4",
    humanProtected: false,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z"
  }) as Parameters<typeof AtomicNoteCard>[0]["note"];

describe("AI provenance badge on notes", () => {
  it("marks a note that is still active from birth, in every locale, with an accessible hint", () => {
    for (const locale of supportedLanguageCodes) {
      const translate = createTranslator(locale);
      const html = renderToString(<AiNoteBadge t={translate} status="active" />);
      expect(html).toContain(translate("knowledge.notes.aiBadge"));
      expect(html).toContain(escaped(translate("knowledge.notes.aiBadgeHint")));
      expect(html).toContain('data-testid="ai-note-badge"');
      expect(translate("knowledge.notes.status.active")).not.toBe("knowledge.notes.status.active");
    }
  });

  it("does not mark notes a person approved or discarded, nor anything that is not a note", () => {
    for (const status of [
      "approved",
      "rejected",
      "archived",
      "pending_review",
      "",
      null,
      undefined
    ])
      expect(renderToString(<AiNoteBadge t={t} status={status} />)).toBe("");
  });

  it("does not mark a note a person edited: an edit keeps it active but protects it", () => {
    expect(renderToString(<AiNoteBadge t={t} status="active" humanProtected />)).toBe("");
    expect(renderToString(<AiNoteBadge t={t} status="active" humanProtected={false} />)).toContain(
      'data-testid="ai-note-badge"'
    );
    // The protected indication that replaces it exists in every locale.
    for (const locale of supportedLanguageCodes) {
      const translate = createTranslator(locale);
      expect(translate("obsidianWiki.protected")).not.toBe("obsidianWiki.protected");
    }
  });

  it("shows in the Library note list next to the status, and only for active notes", () => {
    const active = renderToString(<AtomicNoteCard note={note("active")} t={t} />);
    expect(active).toContain("Active");
    expect(active).toContain('data-testid="ai-note-badge"');
    const approved = renderToString(<AtomicNoteCard note={note("approved")} t={t} />);
    expect(approved).toContain("Approved");
    expect(approved).not.toContain("ai-note-badge");
  });

  it("shows in search results for notes", () => {
    const result = {
      kind: "atomic_note",
      noteId,
      sourceItemId: sourceId,
      sourceTitle: "Forgetting curve",
      sourceType: "StandaloneArticle",
      breadcrumbs: [],
      title: "Spacing flattens the curve",
      ideaStatement: "Spacing flattens forgetting.",
      excerpt: "Reviewing at spaced intervals.",
      status: "active",
      textScore: 0.5,
      vectorScore: 0.5,
      graphScore: 0,
      finalScore: 0.5
    } as unknown as Parameters<typeof SearchResultCard>[0]["result"];
    const html = renderToString(<SearchResultCard result={result} t={t} />);
    expect(html).toContain('data-testid="ai-note-badge"');
  });
});
