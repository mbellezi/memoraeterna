import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TopicsStatus } from "@app/domain";
import { topicsBlockedReasons } from "@app/domain";
import { createTranslator, messages, supportedLanguageCodes, type LanguageCode } from "@app/i18n";
import { TopicStatusLine } from "./TopicStatusLine";
import { reembedOffer, statusLines, type ReembedState } from "./topic-status";

const counts = { items: 120, placed: 45, pending: 75, needsGate: 0 };
const status = (overrides: Partial<TopicsStatus> = {}): TopicsStatus => ({
  phase: "active",
  counts,
  ...overrides
});

const line = (
  value: TopicsStatus | null,
  options: { language?: LanguageCode; reembed?: ReembedState } = {}
) =>
  renderToString(
    <TopicStatusLine
      t={createTranslator(options.language ?? "en")}
      lines={statusLines(value)}
      reembed={options.reembed ?? "idle"}
      onAskReembed={() => undefined}
      onConfirmReembed={() => undefined}
      onCancelReembed={() => undefined}
    />
  );

describe("which lines the status asks for", () => {
  it("says nothing while the tree is simply working", () => {
    expect(statusLines(null)).toEqual([]);
    expect(statusLines(status())).toEqual([]);
  });

  it("lists the first build, why the engine waits and the daily cap, in that order", () => {
    expect(
      statusLines(
        status({
          phase: "building",
          blocked: "waiting_for_embeddings",
          dailyCapReached: true
        })
      )
    ).toEqual([
      { kind: "building", placed: 45, items: 120 },
      { kind: "blocked", reason: "waiting_for_embeddings", reembedNotes: null },
      { kind: "dailyCap" }
    ]);
    expect(statusLines(status({ dailyCapReached: false }))).toEqual([]);
  });

  it("offers the re-embedding only when the model changed and notes would be covered", () => {
    const offer = (value: TopicsStatus) => reembedOffer(statusLines(value));
    expect(offer(status({ blocked: "space_changed", reembedNotes: 800 }))).toBe(800);
    expect(offer(status({ blocked: "space_changed" }))).toBeNull();
    expect(offer(status({ blocked: "space_changed", reembedNotes: 0 }))).toBeNull();
    expect(offer(status({ blocked: "no_embedding_route", reembedNotes: 800 }))).toBeNull();
    expect(offer(status())).toBeNull();
  });
});

describe("the status line", () => {
  it("is a polite live region, empty when there is nothing to say", () => {
    const html = line(status());
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<p ");
    expect(html).not.toContain("<button");
  });

  it("says the first build is running, with how far it is", () => {
    const html = line(status({ phase: "building" }));
    expect(html).toContain("Organizing your library into topics (45 of 120 placed).");
    expect(html).toContain("animate-spin");
    expect(
      line(status({ phase: "building", counts: { ...counts, items: 0, placed: 0 } }))
    ).toContain("Organizing your library into topics...");
  });

  it("says each reason the engine waits, and the cap, in every language", () => {
    for (const language of supportedLanguageCodes) {
      const text = messages[language].topics.status;
      for (const reason of topicsBlockedReasons) {
        const html = line(status({ blocked: reason }), { language });
        expect(html, `${language} ${reason}`).toContain(
          text.blocked[reason].replace(/'/g, "&#x27;")
        );
        expect(html, `${language} ${reason}`).not.toContain("[[missing");
      }
      const cap = line(status({ dailyCapReached: true }), { language });
      expect(cap, language).toContain(text.dailyCap.replace(/'/g, "&#x27;"));
      const building = line(status({ phase: "building" }), { language });
      expect(building, language).not.toContain("[[missing");
      expect(building, language).not.toContain("{placed}");
    }
  });

  it("shows several lines at once", () => {
    const html = line(status({ phase: "building", blocked: "no_decider", dailyCapReached: true }));
    expect(html.match(/<p /g)).toHaveLength(3);
  });

  describe("re-embedding the library", () => {
    const changed = status({ blocked: "space_changed", reembedNotes: 1234 });

    it("offers the action beside the line, and nothing else without a count", () => {
      expect(line(changed)).toContain("Re-embed library");
      expect(line(changed)).toContain("<button");
      expect(line(status({ blocked: "space_changed" }))).not.toContain("<button");
    });

    it("asks before it starts, with the number of notes, and can be cancelled", () => {
      const html = line(changed, { reembed: "confirming" });
      expect(html).toContain('role="group"');
      expect(html).toContain("Re-embed 1,234 notes");
      expect(html.match(/<button/g)).toHaveLength(2);
      expect(html).not.toContain('disabled=""');
      expect(html).toContain("Cancel");
    });

    it("disables its buttons while it starts", () => {
      const html = line(changed, { reembed: "working" });
      expect(html.match(/disabled=""/g)).toHaveLength(2);
      expect(html).toContain("Starting...");
    });

    it("says it started, and says when it failed with a way to ask again", () => {
      const queued = line(changed, { reembed: "queued" });
      expect(queued).toContain("Re-embedding started.");
      expect(queued).not.toContain("<button");
      const failed = line(changed, { reembed: "failed" });
      expect(failed).toContain('role="alert"');
      expect(failed).toContain("could not be re-embedded");
      expect(failed).toContain("Re-embed library");
    });

    it("names its parts in every language", () => {
      for (const language of supportedLanguageCodes) {
        for (const reembed of ["idle", "confirming", "working", "queued", "failed"] as const) {
          const html = line(changed, { language, reembed });
          expect(html, `${language} ${reembed}`).not.toContain("[[missing");
          expect(html, `${language} ${reembed}`).not.toContain("{count}");
        }
      }
    });
  });
});
