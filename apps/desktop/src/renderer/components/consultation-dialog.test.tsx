import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { ConsultationResultSchema, type ConsultationResult } from "@app/domain";
import type { AiProfile } from "../../shared/ipc";
import { ConsultationAnswer, ConsultationDialog, ConsultationStatus } from "./ConsultationDialog";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const result = (overrides: Partial<ConsultationResult> = {}) =>
  ConsultationResultSchema.parse({
    id: id(1),
    question: "Does retrieval practice help?",
    scope: { sourceIds: [], includeDescendants: false, reviewedOnly: false },
    answer: {
      paragraphs: [
        { markdown: "Practice improved delayed recall [e1].", citations: ["e1"], contextIds: [] },
        { markdown: "Beginners gained less [e2] [e1].", citations: ["e2", "e1"], contextIds: [] }
      ],
      gaps: ["Long-term effects are not covered."]
    },
    evidence: [1, 2].map((n) => ({
      handle: `e${n}`,
      chunkId: id(10 + n),
      sourceItemId: id(20 + n),
      documentId: id(30 + n),
      sourceSpanId: null,
      contentHash: `hash-${n}`,
      excerpt: `The original passage ${n}.`,
      sourceTitle: `Study ${n}`,
      documentCreatedAt: "2026-01-01T00:00:00.000Z",
      locator: `p. ${n}`
    })),
    contexts: [],
    coverage: {
      retrieved: 9,
      selected: 2,
      sourceCount: 4,
      limited: false,
      vector: "available",
      signals: ["text"],
      stale: false
    },
    model: "fixture-model",
    inputTokens: 1200,
    outputTokens: 80,
    costEstimate: null,
    promptFingerprint: "0123456789abcdef0123",
    ...overrides
  });
const profiles = [
  {
    id: id(40),
    name: "Configured model",
    modelId: "test-model",
    status: "active",
    capabilities: ["structured-output"]
  }
] as AiProfile[];
/** Server rendering separates adjacent text nodes with comments; the person sees none. */
const visible = (html: string) => html.replaceAll("<!-- -->", "");
const dialog = (props: Partial<Parameters<typeof ConsultationDialog>[0]> = {}) =>
  visible(
    renderToString(
      <ConsultationDialog
        t={createTranslator("en")}
        initialQuestion=""
        onClose={() => {}}
        onOpenSource={() => {}}
        {...props}
      />
    )
  );

describe("the Ask dialog", () => {
  it("is loading until the models are known, without a form", () => {
    const html = dialog();
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading");
    expect(html).not.toContain("<textarea");
  });
  it("offers the question, the source scope and the model once loaded, and nothing from the wiki", () => {
    const t = createTranslator("en"),
      html = dialog({ initialProfiles: profiles, initialQuestion: "What helps recall?" });
    expect(html).toContain("<textarea");
    expect(html).toContain("What helps recall?");
    expect(html).toContain(t("consultation.libraryScope"));
    expect(html).toContain(t("consultation.reviewedOnly"));
    expect(html).toContain(t("consultation.hybrid"));
    expect(html).toContain(t("consultation.ask"));
    for (const gone of [
      t("organization.domains"),
      "Followed questions",
      "Follow this question",
      "Save as a page proposal"
    ])
      expect(html).not.toContain(gone);
  });
  it("disables Ask for a question that is too short and shows the empty model state", () => {
    const t = createTranslator("en"),
      html = dialog({ initialProfiles: [], initialQuestion: "ab" });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Ask<\/button>/);
    expect(html).toContain(t("organization.noModel"));
  });
  it("seeds the source scope and the reviewed-only filter from its host", () => {
    const html = dialog({
      initialProfiles: profiles,
      initialSourceIds: [id(21), id(22)],
      initialReviewed: true
    });
    expect(html).toContain("Evidence scope (2)");
    expect(html).toMatch(/<input type="checkbox" checked=""\/> Reviewed only/);
  });
  it("asks about a topic instead of the library: the topic is the scope and no source picker shows", () => {
    const t = createTranslator("en"),
      html = dialog({
        initialProfiles: profiles,
        topic: { id: id(50), title: "Forgetting curve" }
      });
    expect(html).toContain("Topic: Forgetting curve");
    expect(html).toContain("Forgetting curve” and its subtopics");
    expect(html).not.toContain(t("consultation.libraryScope"));
    expect(html).not.toContain(t("organization.sourceScope"));
    expect(html).not.toContain(t("consultation.descendants"));
    expect(html).toContain(t("consultation.reviewedOnly"));
    expect(html).toContain(t("consultation.ask"));
  });
  it("names the topic scope of an answer", () => {
    const t = createTranslator("en"),
      html = visible(
        renderToString(
          <ConsultationAnswer
            t={t}
            result={result({
              scope: {
                sourceIds: [],
                topicId: id(50),
                includeDescendants: false,
                reviewedOnly: false
              }
            })}
            onOpenSource={() => {}}
          />
        )
      );
    expect(html).toContain(t("consultation.topicScope"));
    expect(html).not.toContain(t("consultation.libraryScope"));
  });
  it("renders in every locale", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale),
        html = dialog({ t, initialProfiles: profiles });
      expect(html).toContain(t("consultation.title"));
      expect(html).toContain(t("consultation.readOnly"));
    }
  });
});

describe("the state of a question", () => {
  it("shows nothing when the question is idle", () => {
    expect(
      renderToString(
        <ConsultationStatus
          t={createTranslator("en")}
          error={null}
          busy={false}
          onCancel={() => {}}
        />
      )
    ).toBe("");
  });
  it("shows the localized reason a question failed as an alert", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const key of [
        "consultation.errors.noRelevantEvidence",
        "consultation.errors.deadline",
        "consultation.errors.rateLimited",
        "consultation.errors.model",
        "consultation.errors.context",
        "consultation.errors.canceled",
        "consultation.errors.failed"
      ] as const) {
        const html = renderToString(
          <ConsultationStatus t={t} error={key} busy={false} onCancel={() => {}} />
        );
        expect(html).toContain('role="alert"');
        expect(html).toContain(t(key));
      }
    }
  });
  it("shows progress with a way to cancel while the answer is prepared", () => {
    const t = createTranslator("en"),
      html = renderToString(<ConsultationStatus t={t} error={null} busy onCancel={() => {}} />);
    expect(html).toContain('role="status"');
    expect(html).toContain(t("consultation.answering"));
    expect(html).toContain(t("organization.cancel"));
  });
});

describe("a cited answer", () => {
  const t = createTranslator("en"),
    render = (value: ConsultationResult, initialHandle: string | null = null) =>
      visible(
        renderToString(
          <ConsultationAnswer
            t={t}
            result={value}
            onOpenSource={() => {}}
            initialHandle={initialHandle}
          />
        )
      );
  it("numbers the citations per paragraph and names the source behind each", () => {
    const html = render(result());
    expect(html).toContain("1. Study 1");
    expect(html).toContain("1. Study 2");
    expect(html).toContain("2. Study 1");
    expect(html).toContain("Practice improved delayed recall [1]");
    expect(html).toContain("Beginners gained less [1] [2]");
    expect(html).toContain("Long-term effects are not covered.");
  });
  it("discloses coverage, the scope, the model and the usage", () => {
    const html = render(result());
    expect(html).toContain(
      t("consultation.coverage", { values: { selected: 2, total: 9, sources: 4 } })
    );
    expect(html).toContain(t("consultation.sourceCount", { values: { count: 4 } }));
    expect(html).toContain(t("consultation.libraryScope"));
    expect(html).toContain("fixture-model · 0123456789ab");
    expect(html).toContain(t("consultation.vectorAvailable"));
    expect(html).toContain(`${t("organization.estimatedCost")}: ${t("organization.unavailable")}`);
    const scoped = render(
      result({ scope: { sourceIds: [id(21)], includeDescendants: false, reviewedOnly: false } })
    );
    expect(scoped).toContain(t("organization.sourceScope"));
  });
  it("warns about partial coverage and about material that changed", () => {
    expect(render(result())).not.toContain(t("consultation.partial"));
    const base = result();
    const html = render(result({ coverage: { ...base.coverage, limited: true, stale: true } }));
    expect(html).toContain(t("consultation.partial"));
    expect(html).toContain(t("consultation.stale"));
    expect(html).toContain('role="alert"');
  });
  it("has no save or follow action, since an answer writes nothing", () => {
    const html = render(result());
    expect(html).not.toContain("Save");
    expect(html).not.toContain("Saved as a followed answer page");
  });
  it("opens the passage behind a citation with a link to its source", () => {
    const html = render(result(), "e2");
    expect(html).toContain("The original passage 2.");
    expect(html).toContain("p. 2");
    expect(html).toContain(t("objects.citation.openPassage"));
    expect(render(result())).not.toContain(t("objects.citation.openPassage"));
  });
});
