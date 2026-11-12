import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TopicOverviewResultSchema, type TopicOverviewState } from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { TopicOverviewSection, type TopicOverviewSectionProps } from "./TopicOverviewSlot";
import { TopicOverviewController, type TopicOverviewApi } from "./topic-overview-controller";
import {
  citationAddress,
  citedSourceCount,
  overviewAnswered,
  overviewErrorKey,
  overviewFailed,
  overviewHint,
  overviewLocal,
  overviewMessage,
  overviewRequested,
  overviewView,
  relativeWhen,
  shouldRequestOverview,
  staleToPatch,
  unmarkedCitations,
  type ReadyOverview
} from "./topic-overview-model";
import { topicFixtureId as id } from "./topic-page-fixtures";

const en = createTranslator("en");
const noop = () => undefined;
const plain = (html: string) => html.replaceAll("<!-- -->", "");
const topicId = id(3);
const writtenAt = "2026-10-14T10:00:00.000Z";
const now = Date.parse("2026-10-16T10:00:00.000Z");

function ready(overrides: Partial<ReadyOverview> = {}): ReadyOverview {
  return TopicOverviewResultSchema.parse({
    status: "ready",
    stale: false,
    paragraphs: [
      {
        text: "Retention falls fast after study [1]. Spaced review flattens it [1, 2].",
        citations: [1, 2]
      },
      { text: "Sleep consolidates what was learned.", citations: [3] }
    ],
    citations: [
      {
        n: 1,
        chunkId: id(501),
        sourceSpanId: id(502),
        noteId: id(503),
        sourceId: id(200),
        sourceTitle: "Forgetting curve",
        excerpt: "Retention drops quickly in the first hours.",
        available: true
      },
      {
        n: 2,
        chunkId: id(511),
        noteId: id(513),
        sourceId: id(200),
        sourceTitle: "Forgetting curve",
        excerpt: "Reviews spaced over days slow the decline.",
        available: true
      },
      {
        n: 3,
        sourceId: id(210),
        sourceTitle: "Sleep handbook",
        excerpt: "Deep sleep replays the day's memories.",
        available: false
      }
    ],
    evidence: { used: 5, total: 23 },
    writtenAt,
    model: "fixture-writer",
    language: "en",
    support: { status: "verified", unsupported: [], sentences: { checked: 3, supported: 3 } },
    ...overrides
  }) as ReadyOverview;
}

const absent = (canWrite: boolean, reasonKey?: string): TopicOverviewState =>
  reasonKey ? { status: "absent", canWrite, reasonKey } : { status: "absent", canWrite };

function render(view: TopicOverviewSectionProps["view"], t = en): string {
  return plain(
    renderToString(
      <TopicOverviewSection
        t={t}
        view={view}
        now={now}
        actions={{ openTopic: noop, openNote: noop, openSource: noop, openAddress: noop }}
        onWrite={noop}
        onUpdate={noop}
        onCancel={noop}
      />
    )
  );
}

describe("what the overview section shows", () => {
  it("shows the page's overview with no request of its own", () => {
    const view = overviewView(ready(), null);
    expect(view).toEqual({ kind: "ready", overview: ready(), noticeKey: null });
    expect(shouldRequestOverview(view, null, true)).toBe(false);
  });

  it("writes a missing overview on open, only while shown, and never after a cancel", () => {
    const view = overviewView(absent(true), null);
    expect(view).toEqual({ kind: "absent", canWrite: true, reasonKey: null });
    expect(shouldRequestOverview(view, null, true)).toBe(true);
    expect(shouldRequestOverview(view, null, false)).toBe(false);
    const canceled = overviewAnswered(
      overviewRequested(overviewLocal(topicId), false),
      absent(true, "topics.overview.reasons.canceled")
    );
    expect(canceled.canceled).toBe(true);
    const after = overviewView(absent(true), canceled);
    expect(after).toEqual({
      kind: "absent",
      canWrite: true,
      reasonKey: "topics.overview.reasons.canceled"
    });
    expect(shouldRequestOverview(after, canceled, true)).toBe(false);
    // The person writes again: the cancel no longer holds.
    expect(overviewRequested(canceled, true).canceled).toBe(false);
  });

  it("patches a stale overview once on open (F4 D17), never twice for the same writing", () => {
    const stale = ready({ stale: true });
    const view = overviewView(stale, null);
    expect(staleToPatch(view, null)).toBe(true);
    expect(shouldRequestOverview(view, null, true)).toBe(true);
    expect(shouldRequestOverview(view, null, false)).toBe(false);
    // The patch shows as writing over the overview it extends.
    const patching = overviewRequested(overviewLocal(topicId), false, false, stale.writtenAt);
    expect(patching.patchedFor).toBe(stale.writtenAt);
    expect(overviewView(stale, patching)).toEqual({
      kind: "writing",
      previous: stale,
      updating: false
    });
    // It came back still stale (nothing to add, or a text the owner restored): asked no more.
    const answered = overviewAnswered(patching, stale);
    expect(shouldRequestOverview(overviewView(stale, answered), answered, true)).toBe(false);
    // A new writing that is stale again is patched again; a canceled slot never asks on its own.
    const later = ready({ stale: true, writtenAt: "2026-10-16T09:00:00.000Z" });
    expect(shouldRequestOverview(overviewView(later, answered), answered, true)).toBe(true);
    const canceled = { ...answered, canceled: true };
    expect(shouldRequestOverview(overviewView(later, canceled), canceled, true)).toBe(false);
    // A current overview asks nothing.
    expect(staleToPatch(overviewView(ready(), null), null)).toBe(false);
  });

  it("does not ask when nothing can be written, and joins a writing in progress", () => {
    expect(
      shouldRequestOverview(
        overviewView(absent(false, "topics.overview.reasons.noWriter"), null),
        null,
        true
      )
    ).toBe(false);
    expect(shouldRequestOverview(overviewView({ status: "writing" }, null), null, true)).toBe(true);
    const requesting = overviewRequested(overviewLocal(topicId), false);
    expect(shouldRequestOverview(overviewView(absent(true), requesting), requesting, true)).toBe(
      false
    );
  });

  it("waits once for the support verdict of a writing, never twice", () => {
    const checking = ready({ support: { status: "checking", unsupported: [] } });
    const written = overviewAnswered(overviewRequested(overviewLocal(topicId), false), checking);
    expect(written.awaitedCheck).toBeNull();
    expect(shouldRequestOverview(overviewView(absent(true), written), written, true)).toBe(true);
    // While the verdict is awaited the overview stays readable; an Update is a writing again.
    const awaiting = overviewRequested(written, false, true);
    expect(overviewView(absent(true), awaiting)).toEqual({
      kind: "ready",
      overview: checking,
      noticeKey: null
    });
    expect(shouldRequestOverview(overviewView(absent(true), awaiting), awaiting, true)).toBe(false);
    expect(overviewView(absent(true), overviewRequested(written, true, true))).toMatchObject({
      kind: "writing",
      updating: true
    });
    const still = overviewAnswered(overviewRequested(written, false), checking);
    expect(still.awaitedCheck).toBe(writtenAt);
    expect(shouldRequestOverview(overviewView(absent(true), still), still, true)).toBe(false);
    const verdict = overviewAnswered(overviewRequested(written, false), ready());
    expect(overviewView(checking, verdict)).toMatchObject({
      kind: "ready",
      overview: { support: { status: "verified" } }
    });
  });

  it("keeps the earlier overview over an update that fails, is canceled or cannot run", () => {
    const old = ready();
    const updating = overviewRequested(overviewLocal(topicId), true);
    expect(overviewView(old, updating)).toEqual({ kind: "writing", previous: old, updating: true });
    expect(
      overviewView(old, overviewAnswered(updating, { status: "failed", messageKey: "x" }))
    ).toMatchObject({ kind: "ready", overview: old, noticeKey: "topics.overview.updateFailed" });
    expect(
      overviewView(
        old,
        overviewAnswered(updating, absent(true, "topics.overview.reasons.canceled"))
      )
    ).toEqual({ kind: "ready", overview: old, noticeKey: null });
    expect(
      overviewView(
        old,
        overviewAnswered(updating, absent(false, "topics.overview.reasons.noWriter"))
      )
    ).toMatchObject({ kind: "ready", noticeKey: "topics.overview.reasons.noWriter" });
    expect(
      overviewView(old, overviewFailed(updating, "topics.overview.errors.failed"))
    ).toMatchObject({ kind: "ready", noticeKey: "topics.overview.updateFailed" });
    expect(
      overviewView(absent(true), overviewFailed(updating, "topics.overview.errors.failed"))
    ).toEqual({ kind: "failed", messageKey: "topics.overview.errors.failed" });
  });

  it("shows the newer writing, and the page's reading of the same one (it knows the members)", () => {
    const pageReading = ready({ stale: true });
    const written = overviewAnswered(
      overviewRequested(overviewLocal(topicId), false),
      ready({ stale: false })
    );
    expect(overviewView(pageReading, written)).toMatchObject({ overview: { stale: true } });
    const rewritten = overviewAnswered(
      overviewRequested(written, true),
      ready({ writtenAt: "2026-10-16T09:00:00.000Z" })
    );
    expect(overviewView(pageReading, rewritten)).toMatchObject({
      overview: { writtenAt: "2026-10-16T09:00:00.000Z", stale: false }
    });
  });
});

describe("the overview's words", () => {
  it("counts sources by identity, says when it was written and how many notes it used", () => {
    expect(citedSourceCount(ready().citations)).toBe(2);
    expect(relativeWhen(en, writtenAt, new Date(now))).toBe("2 days ago");
    expect(relativeWhen(createTranslator("pt-BR"), writtenAt, new Date(now))).toBe("anteontem");
    expect(relativeWhen(en, "2026-10-16T09:59:30.000Z", new Date(now))).toBe("now");
    expect(overviewHint(en, { used: 5, total: 23 })).toBe("written by AI from 5 of 23 notes");
    expect(overviewHint(en, { used: 1, total: 1 })).toBe("written by AI from 1 note");
  });

  it("reads unknown message keys as a generic failure and finds ours inside errors", () => {
    expect(overviewMessage(en, "topics.overview.reasons.noWriter")).toContain("No writing model");
    expect(overviewMessage(en, "errors.secret.thing")).toBe(
      "The overview could not be written. Try again."
    );
    expect(
      overviewErrorKey(new Error("Error invoking remote method: topics.overview.errors.timeout"))
    ).toBe("topics.overview.errors.timeout");
    expect(overviewErrorKey(new Error("boom"))).toBe("topics.overview.errors.failed");
  });

  it("lists citations a paragraph makes without a marker", () => {
    const [first, second] = ready().paragraphs;
    expect(unmarkedCitations(first!, ready().citations)).toEqual([]);
    expect(unmarkedCitations(second!, ready().citations)).toEqual([3]);
  });

  it("has every message in every locale", () => {
    for (const language of supportedLanguageCodes) {
      const html = render(
        { kind: "ready", overview: ready({ stale: true }), noticeKey: null },
        createTranslator(language)
      );
      expect(html, language).not.toContain("[[missing");
      for (const key of [
        "topics.overview.reasons.root",
        "topics.overview.reasons.empty",
        "topics.overview.reasons.noWriter",
        "topics.overview.reasons.unavailable",
        "topics.overview.reasons.canceled",
        "topics.overview.errors.invalid",
        "topics.overview.errors.tooLarge",
        "topics.overview.errors.failed",
        "topics.overview.errors.timeout",
        "topics.overview.updateFailed"
      ])
        expect(
          overviewMessage(createTranslator(language), key),
          `${language} ${key}`
        ).not.toContain("[[missing");
    }
  });
});

describe("where a citation opens (D15)", () => {
  it("carries the anchors of the stored passage: the chunk as passage, the span as span", () => {
    const [first, second, third] = ready().citations;
    expect(citationAddress(first!)).toBe(
      `memora://source/${id(200)}#passage=${id(501)}&span=${id(502)}`
    );
    // A passage with no span names only its chunk.
    expect(citationAddress(second!)).toBe(`memora://source/${id(200)}#passage=${id(511)}`);
    // A chunk that was replaced leaves the source alone, still openable.
    expect(citationAddress(third!)).toBe(`memora://source/${id(210)}`);
  });

  it("falls back to the note when the source is gone, and to nothing when neither is known", () => {
    const [first] = ready().citations;
    const noSource = { ...first!, sourceId: undefined };
    expect(citationAddress(noSource)).toBe(`memora://note/${id(503)}`);
    expect(citationAddress({ ...noSource, noteId: undefined })).toBeNull();
  });
});

describe("the overview section", () => {
  it("renders paragraphs with citation markers, the meta line and the support verdict", () => {
    const html = render({ kind: "ready", overview: ready(), noticeKey: null });
    expect(html).toContain(">Overview</h2>");
    expect(html).toContain("written by AI from 5 of 23 notes");
    // A numeral sits tight to its word: no space is left before it.
    expect(html).toContain("Retention falls fast after study</span><sup");
    expect(html).toContain('aria-label="Citation 1: Forgetting curve"');
    expect(html).toContain('aria-label="Citation 3: Sleep handbook"');
    expect(html).toContain('lang="en"');
    expect(html).toContain("fixture-writer");
    expect(html).toContain("Written on open, 2 days ago");
    expect(html).toContain("2 sources cited");
    expect(html).toContain("Support verified");
    expect(html).toContain(">Update<");
    expect(html).not.toContain("changed since this overview");
    // No raw IDs in normal UI.
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
  });

  it("offers Update when the members changed and marks unsupported paragraphs", () => {
    const html = render({
      kind: "ready",
      overview: ready({
        stale: true,
        support: { status: "partial", unsupported: [1], sentences: { checked: 3, supported: 2 } }
      }),
      noticeKey: null
    });
    expect(html).toContain("This topic&#x27;s notes changed since this overview was written.");
    expect(html).toContain("Support partly verified: 2 of 3 sentences");
    expect(html).toContain("Not confirmed by the support check");
    expect(html.match(/>Update</gu)).toHaveLength(1);
  });

  it("covers writing, checking, absent, failed and the root", () => {
    const writing = render({ kind: "writing", previous: null, updating: false });
    expect(writing).toContain('aria-busy="true"');
    expect(writing).toContain("Writing an overview from this topic");
    expect(writing).toContain(">Cancel<");
    const updating = render({ kind: "writing", previous: ready(), updating: true });
    expect(updating).toContain("Retention falls fast after study");
    const checking = render({
      kind: "ready",
      overview: ready({ support: { status: "checking", unsupported: [] } }),
      noticeKey: null
    });
    expect(checking).toContain("Checking support…");
    expect(
      render({ kind: "absent", canWrite: false, reasonKey: "topics.overview.reasons.empty" })
    ).toContain("This topic has no notes to write an overview from yet.");
    const canceled = render({
      kind: "absent",
      canWrite: true,
      reasonKey: "topics.overview.reasons.canceled"
    });
    expect(canceled).toContain("Writing was canceled.");
    expect(canceled).toContain(">Write overview<");
    const failed = render({ kind: "failed", messageKey: "topics.overview.errors.invalid" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(">Retry<");
    expect(
      render({ kind: "absent", canWrite: false, reasonKey: "topics.overview.reasons.root" })
    ).toBe("");
  });
});

describe("the overview controller", () => {
  function api(answers: Array<TopicOverviewState | Error>) {
    const calls: Array<{ id: string; force?: boolean }> = [];
    const pending: Array<(value: TopicOverviewState) => void> = [];
    const fake: TopicOverviewApi & { calls: typeof calls } = {
      calls,
      overview: vi.fn(async (input) => {
        calls.push(input);
        const next = answers.shift();
        if (next instanceof Error) throw next;
        if (next) return next;
        return new Promise<TopicOverviewState>((resolve) => pending.push(resolve));
      }),
      cancelOverview: vi.fn(async () => true)
    };
    return { fake, pending };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("makes no request for a ready overview, nor while hidden", async () => {
    const { fake } = api([]);
    const controller = new TopicOverviewController({ api: () => fake, now: () => now });
    controller.show(topicId, ready(), true);
    controller.show(topicId, absent(true), false);
    await settle();
    expect(fake.calls).toEqual([]);
  });

  it("patches a stale overview once on open, and asks no more when it stays stale", async () => {
    const stale = ready({ stale: true });
    const { fake } = api([stale]);
    const controller = new TopicOverviewController({ api: () => fake, now: () => now });
    controller.show(topicId, stale, true);
    await settle();
    // One plain request (no force): the main process patches at P0 or joins REFRESH.
    expect(fake.calls).toEqual([{ id: topicId }]);
    controller.show(topicId, stale, true);
    await settle();
    expect(fake.calls).toHaveLength(1);
  });

  it("writes on open, then waits once for the support verdict", async () => {
    const checking = ready({ support: { status: "checking", unsupported: [] } });
    const { fake } = api([checking, ready()]);
    const controller = new TopicOverviewController({ api: () => fake, now: () => now });
    const seen: string[] = [];
    controller.subscribe(() =>
      seen.push(controller.getSnapshot().local?.request?.status ?? "none")
    );
    controller.show(topicId, absent(true), true);
    await settle();
    expect(fake.calls).toEqual([{ id: topicId }, { id: topicId }]);
    expect(overviewView(absent(true), controller.getSnapshot().local)).toMatchObject({
      kind: "ready",
      overview: { support: { status: "verified" } }
    });
    // The page reads the stored overview: still no further request.
    controller.show(topicId, ready(), true);
    await settle();
    expect(fake.calls).toHaveLength(2);
    expect(seen).toContain("requesting");
  });

  it("shows the overview while its support verdict is awaited, and Update does not wait for it", async () => {
    const checking = ready({ support: { status: "checking", unsupported: [] } });
    const { fake, pending } = api([checking]);
    const controller = new TopicOverviewController({ api: () => fake, now: () => now });
    controller.show(topicId, absent(true), true);
    await settle();
    expect(fake.calls).toEqual([{ id: topicId }, { id: topicId }]);
    // The verdict is awaited: the overview reads as ready and checking, with no Cancel.
    const view = overviewView(absent(true), controller.getSnapshot().local);
    expect(view).toEqual({ kind: "ready", overview: checking, noticeKey: null });
    expect(shouldRequestOverview(view, controller.getSnapshot().local, true)).toBe(false);
    const html = render(view);
    expect(html).toContain("Checking support…");
    expect(html).toContain('aria-busy="false"');
    expect(html).not.toContain(">Cancel<");
    // Update during the wait writes at once; the wait's late answer is dropped.
    controller.write(true);
    expect(fake.calls).toEqual([{ id: topicId }, { id: topicId }, { id: topicId, force: true }]);
    expect(overviewView(absent(true), controller.getSnapshot().local)).toEqual({
      kind: "writing",
      previous: checking,
      updating: true
    });
    pending[0]!({ status: "writing" });
    await settle();
    expect(overviewView(absent(true), controller.getSnapshot().local)).toMatchObject({
      kind: "writing",
      updating: true
    });
    expect(fake.calls).toHaveLength(3);
    const rewritten = ready({ writtenAt: "2026-10-16T09:00:00.000Z" });
    pending[1]!(rewritten);
    await settle();
    expect(overviewView(absent(true), controller.getSnapshot().local)).toEqual({
      kind: "ready",
      overview: rewritten,
      noticeKey: null
    });
  });

  it("updates on request, cancels, and drops an answer for a topic no longer shown", async () => {
    const { fake, pending } = api([]);
    const controller = new TopicOverviewController({ api: () => fake, now: () => now });
    controller.show(topicId, ready(), true);
    controller.write(true);
    controller.write(true);
    expect(fake.calls).toEqual([{ id: topicId, force: true }]);
    controller.cancel();
    expect(fake.cancelOverview).toHaveBeenCalledWith({ id: topicId });
    controller.show(id(4), ready(), true);
    pending[0]!(ready({ writtenAt: "2026-10-16T09:00:00.000Z" }));
    await settle();
    expect(controller.getSnapshot().local).toBeNull();
  });

  it("keeps a request failure visible until Retry", async () => {
    const { fake } = api([
      new Error("topics.errors.unavailable"),
      absent(false, "topics.overview.reasons.empty")
    ]);
    const controller = new TopicOverviewController({ api: () => fake, now: () => now });
    controller.show(topicId, absent(true), true);
    await settle();
    expect(overviewView(absent(true), controller.getSnapshot().local)).toEqual({
      kind: "failed",
      messageKey: "topics.overview.errors.failed"
    });
    controller.show(topicId, absent(true), true);
    await settle();
    expect(fake.calls).toHaveLength(1);
    controller.write(false);
    await settle();
    expect(fake.calls).toHaveLength(2);
  });

  it("asks nothing after dispose until shown again, as React remounts it while developing", async () => {
    const { fake } = api([ready()]);
    const controller = new TopicOverviewController({ api: () => fake, now: () => now });
    controller.dispose();
    controller.show(topicId, absent(true), true);
    expect(fake.calls).toHaveLength(1);
    controller.dispose();
    await settle();
    // The answer of the request in flight still lands.
    expect(overviewView(absent(true), controller.getSnapshot().local)).toMatchObject({
      kind: "ready"
    });
    controller.show(topicId, ready(), true);
    await settle();
    expect(fake.calls).toHaveLength(1);
  });
});
