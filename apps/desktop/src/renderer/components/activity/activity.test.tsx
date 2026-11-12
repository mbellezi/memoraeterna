import { renderToString } from "react-dom/server";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { describe, expect, it, vi } from "vitest";

import type { ActivitySnapshot } from "./activity-model";
import {
  activitySnapshot,
  budgetSnapshot,
  changeSet,
  downloadingStatus,
  fixtureNow,
  idleStatus,
  money80Status,
  pausedStatus,
  queueStatus,
  rateLimitedStatus,
  runningStatus,
  signInStatus
} from "./activity-fixtures";
import { ActivityDrawer } from "./ActivityDrawer";
import { TopicNoticeCenter } from "../topics/ops/topic-notice-center";
import { pinNotice } from "../topics/ops/topic-ops";
import { ActivityHost, announcementText } from "./ActivityHost";
import { ActivityPill, noticeAnnouncement, pillLevels, type PillNotice } from "./ActivityPill";
import { pillView } from "./activity-model";

const en = createTranslator("en");
const ready = <T,>(value: T) => ({ status: "ready", value }) as const;

const drawer = (
  snapshot: ActivitySnapshot,
  options: { t?: typeof en; onOpenInbox?: () => void } = {}
) =>
  renderToString(
    <ActivityDrawer
      t={options.t ?? en}
      snapshot={snapshot}
      now={fixtureNow}
      id="activity-drawer"
      onClose={vi.fn()}
      onRetry={vi.fn()}
      onAction={vi.fn()}
      onUndo={vi.fn()}
      {...(options.onOpenInbox ? { onOpenInbox: options.onOpenInbox } : {})}
    />
  );

/** A drawer whose three reads all answered. */
const answered = (parts: Partial<ActivitySnapshot> = {}) =>
  activitySnapshot({
    open: true,
    status: ready(idleStatus),
    budget: ready(budgetSnapshot()),
    done: ready([]),
    ...parts
  });

describe("the Activity pill", () => {
  const pill = (snapshot: ActivitySnapshot, open = false) =>
    renderToString(
      <ActivityPill
        t={en}
        view={pillView(en, snapshot)}
        open={open}
        drawerId="activity-drawer"
        onToggle={vi.fn()}
      />
    );

  it("is a button that names the sentence and says whether the drawer is open", () => {
    const html = pill(activitySnapshot({ status: ready(pausedStatus) }));
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    expect(html).toContain('aria-label="Activity: Automatic organizing is paused.');
    // What the pill draws is the short phrase; the sentence is the name and the tooltip.
    expect(html).toContain(">Organizing paused<");
    expect(html).toContain('title="Automatic organizing is paused.');
  });

  it("points at the drawer only while it is open", () => {
    const html = pill(activitySnapshot({ status: ready(idleStatus), open: true }), true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="activity-drawer"');
  });

  it("covers loading, error and success, each with a glyph and a sentence", () => {
    expect(pill(activitySnapshot())).toContain("Checking activity…");
    expect(pill(activitySnapshot({ status: { status: "error" } }))).toContain(
      "Activity unavailable"
    );
    expect(pill(activitySnapshot({ status: ready(idleStatus) }))).toContain("All up to date");
    // A state is a solid glyph or the running ring, never colour alone.
    for (const status of [idleStatus, pausedStatus, signInStatus]) {
      expect(pill(activitySnapshot({ status: ready(status) }))).toContain("<svg");
    }
    expect(pill(activitySnapshot({ status: ready(runningStatus) }))).toContain(
      "motion-safe:animate-spin"
    );
  });

  it("spins only while something is going on, and never with reduced motion", () => {
    expect(pill(activitySnapshot({ status: ready(runningStatus) }))).toContain(
      "motion-safe:animate-spin"
    );
    expect(pill(activitySnapshot({ status: ready(pausedStatus) }))).not.toContain("animate-spin");
  });

  it("says the reviews that wait in words, and Home drops the clause", () => {
    const waiting = activitySnapshot({ status: ready(idleStatus), inboxTotal: 3 });
    const html = pill(waiting);
    expect(html).toContain("3 need you");
    // The same words are in the button's name, so a screen reader hears them too.
    expect(html).toMatch(/aria-label="Activity: Your library is up to date\. 3 need you"/u);
    expect(pill(activitySnapshot({ status: ready(idleStatus), inboxTotal: 1 }))).toContain(
      "1 needs you"
    );
    expect(pill(activitySnapshot({ status: ready(idleStatus), inboxTotal: 0 }))).not.toContain(
      "need"
    );
    const home = renderToString(
      <ActivityPill
        t={en}
        view={pillView(en, waiting)}
        open={false}
        drawerId="activity-drawer"
        onToggle={vi.fn()}
        hideNeedsYou
      />
    );
    expect(home).not.toContain("need you");
  });

  it("steps down in the order of the design: waiting first, then the phrase to its verb, then out, the needs-you clause last", () => {
    const rows = pillLevels.map((level) => [level.phrase, level.waiting, level.needsYou]);
    expect(rows).toEqual([
      ["full", true, true],
      ["full", false, true],
      ["short", false, true],
      ["none", false, true],
      ["none", false, false]
    ]);
  });

  it("draws the waiting clause in the same run as the phrase, with one gap, and keeps its whole sentence in the name", () => {
    const html = renderToString(
      <ActivityPill
        t={en}
        view={{
          glyph: "working",
          text: "Organizing your library",
          short: "Organizing",
          full: "Organizing your library.",
          badge: 2,
          waiting: 2
        }}
        open={false}
        drawerId="d"
        onToggle={vi.fn()}
      />
    );
    expect(html).toContain("Organizing your library<span");
    expect(html).toContain(" · 2 waiting");
    expect(html).toContain('data-fit="pill"');
    expect(html).toContain('data-fit-level="0"');
    // The journeys read the glyph the pill draws from this attribute.
    expect(html).toContain('data-glyph="working"');
    expect(html).toContain("2 need you");
  });

  it("names the jobs that wait, and drops that clause first at compact width", () => {
    const snapshot = activitySnapshot({
      status: ready(runningStatus),
      jobs: { running: 1, waiting: 2, onHold: 1 },
      inboxTotal: 2
    });
    const wide = pill(snapshot);
    expect(wide).toContain("3 waiting");
    expect(wide).toContain("2 need you");
    const compact = renderToString(
      <ActivityPill
        t={en}
        view={pillView(en, snapshot)}
        open={false}
        drawerId="activity-drawer"
        onToggle={vi.fn()}
        compact
      />
    );
    expect(compact).not.toContain("3 waiting");
    expect(compact).toContain("2 need you");
  });

  const noticeOf = (changes: Partial<PillNotice> = {}): PillNotice => ({
    text: "Renamed to Micronutrients.",
    canUndo: true,
    pending: false,
    blocked: false,
    failed: false,
    onUndo: () => undefined,
    onDismiss: () => undefined,
    onHold: () => undefined,
    ...changes
  });
  const noticePill = (notice: PillNotice, compact = false) =>
    renderToString(
      <ActivityPill
        t={en}
        view={pillView(en, activitySnapshot({ status: ready(idleStatus), inboxTotal: 2 }))}
        open={false}
        drawerId="activity-drawer"
        onToggle={vi.fn()}
        compact={compact}
        notice={notice}
      />
    );

  it("turns into the undo extension after a change, with the needs-you clause kept", () => {
    const html = noticePill(noticeOf());
    expect(html).toContain("Renamed to Micronutrients.");
    expect(html).toContain("Undo");
    expect(html).toContain('aria-keyshortcuts="U"');
    expect(html).toContain("2 need you");
  });

  it("leaves the announcement to the host's live region, which is in the page before the text", () => {
    // A region that is inserted already holding its text is not spoken: the pill has none.
    expect(noticePill(noticeOf())).not.toContain('role="status"');
    expect(noticeAnnouncement(en, noticeOf())).toBe("Renamed to Micronutrients. Undo U");
    expect(noticeAnnouncement(en, noticeOf({ canUndo: false, blocked: true }))).toContain(
      "a later change depends on it"
    );
    expect(noticeAnnouncement(en, noticeOf({ failed: true }))).toContain("could not be undone");
    expect(noticeAnnouncement(en, null)).toBe("");
  });

  it("can never outgrow its slot: it clips, and every sentence in it can shrink", () => {
    for (const changes of [
      {},
      { canUndo: false, blocked: true },
      { canUndo: false, failed: true }
    ]) {
      const html = noticePill(noticeOf(changes), true);
      expect(html).toMatch(/data-activity-notice="" class="[^"]*overflow-hidden/u);
      // Each sentence is a span that truncates; only the glyph, the Undo link and the clause that
      // waits for the person keep their size.
      expect(html).toMatch(/<span class="min-w-0 shrink-\[4\] truncate" title="Renamed/u);
    }
    const blocked = noticePill(noticeOf({ canUndo: false, blocked: true }));
    expect(blocked).toMatch(/<span class="min-w-0 truncate[^"]*" title="[^"]*later change/u);
    const failed = noticePill(noticeOf({ canUndo: false, failed: true }));
    expect(failed).toMatch(/<span class="min-w-0 truncate[^"]*" title="[^"]*could not be undone/u);
  });

  it("drops the needs-you clause from the notice at compact width, where the slot is 260 px", () => {
    expect(noticePill(noticeOf(), false)).toContain("2 need you");
    const compact = noticePill(noticeOf(), true);
    expect(compact).not.toContain("need you");
    expect(compact).toContain("Undo");
  });

  it("shows a warning glyph, not a check, when the undo is blocked or failed", () => {
    expect(noticePill(noticeOf())).toContain("text-success");
    expect(noticePill(noticeOf({ blocked: true, canUndo: false }))).not.toContain("text-success");
    expect(noticePill(noticeOf({ failed: true }))).toContain("text-danger");
  });

  it("says the embedder is loading instead of blocking the screen", () => {
    const html = pill(activitySnapshot({ status: ready(idleStatus), embedderLoading: true }));
    expect(html).toContain("A model is loading into memory.");
    expect(html).not.toContain("modal");
  });
});

describe("the Activity drawer", () => {
  it("is a named, non-modal region that can take focus and is not a dialog", () => {
    const html = drawer(answered());
    expect(html).toContain("<aside");
    expect(html).toContain('id="activity-drawer"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/u);
    expect(html).toContain('aria-label="Close activity"');
    expect(html).not.toContain("aria-modal");
    expect(html).not.toContain('role="dialog"');
  });

  it("is loading while nothing answered", () => {
    const html = drawer(activitySnapshot({ open: true }));
    // A busy region for each of the five sections, bars in their shape, no sentence of text.
    expect(html.match(/role="status"/gu)).toHaveLength(5);
    expect(html.match(/aria-busy="true"/gu)).toHaveLength(5);
    expect(html).toContain("Loading");
    // Without a status the drawer cannot say what waits or needs the person.
    expect(html).not.toContain("Nothing is waiting.");
    expect(html).not.toContain("Nothing needs your attention.");
  });

  it("keeps every failed read visible with its own retry", () => {
    const html = drawer(
      activitySnapshot({
        open: true,
        status: { status: "error" },
        budget: { status: "error" },
        done: { status: "error" }
      })
    );
    // One plain sentence and one retry for the whole drawer: the sections below do not repeat it.
    expect(html.match(/role="alert"/gu)).toHaveLength(1);
    // The same grammar as every other failed view: a solid triangle and the shared retry word.
    expect(html.match(/>Try again</gu)).toHaveLength(1);
    expect(html).not.toContain(">Retry<");
    expect(html.match(/M10\.3 3\.7/gu)).toHaveLength(1);
    expect(html).toContain("Activity could not be loaded.");
    expect(html).not.toContain("Recent changes could not be loaded.");
    // The failure says in one muted line what is kept, once.
    expect(html).toContain("Nothing was changed. Your library is safe.");
    expect(html.match(/text-muted-foreground">Nothing was changed/gu)).toHaveLength(1);
    // A read that fails by itself while the status answered keeps its own line and retry.
    const alone = drawer(answered({ budget: { status: "error" }, done: { status: "error" } }));
    expect(alone.match(/>Try again</gu)).toHaveLength(2);
    expect(alone.match(/M10\.3 3\.7/gu)).toHaveLength(2);
    expect(alone).toContain("Recent changes could not be loaded.");
    expect(alone).toContain("The spending meters could not be loaded.");
    expect(alone).toContain("The changes are stored and can still be undone once they load.");
    expect(alone).toContain("Your limits and spending are unchanged.");
  });

  it("leaves out the Waiting and Needs you sections while they have nothing to say", () => {
    const html = drawer(answered());
    for (const heading of ["Now", "Done", "Budget"]) expect(html).toContain(`>${heading}</h3>`);
    for (const heading of ["Waiting", "Needs you"]) expect(html).not.toContain(`>${heading}</h3>`);
    expect(html).toContain("Your library is up to date.");
    expect(html).not.toContain("Nothing is waiting.");
    expect(html).not.toContain("Nothing needs your attention.");
    expect(html).toContain("Nothing was changed automatically yet.");
    expect(html).toContain("$1.20 of $5.00 used this month.");
    expect(html).toContain("Under the limit");
  });

  it("never says nothing waits while the pill counts jobs that wait, and gives the reason", () => {
    const jobs = (waiting: number, onHold = 0) =>
      drawer(answered({ jobs: { running: 0, waiting, onHold } }));
    const two = jobs(2);
    expect(two).not.toContain("Nothing is waiting.");
    expect(two).toContain("2 tasks wait their turn. Reason: tasks run one after another.");
    expect(jobs(1)).toContain("1 task waits its turn.");
    // The pill counts jobs that wait and jobs on hold together; the section lists the same number.
    expect(jobs(1, 1)).toContain("2 tasks wait their turn.");
    expect(jobs(0)).not.toContain("Nothing is waiting.");
    expect(jobs(0)).not.toContain(">Waiting</h3>");
  });

  it("shows how much of the library each task keeps current, with the number in text", () => {
    const html = drawer(answered({ status: ready(runningStatus) }));
    expect(html).toContain("Notes placed in topics");
    expect(html).toContain("92%");
    expect(html).toContain("Connections checked");
    expect(html).toContain("80%");
    expect(html).toContain("Topic overviews up to date");
    expect(html).toContain("100%");
    expect(html).toContain("About 10 minutes left.");
  });

  it("counts the running, waiting and held jobs once the push told", () => {
    expect(drawer(answered())).not.toContain("On hold");
    const html = drawer(answered({ jobs: { running: 2, waiting: 7, onHold: 1 } }));
    expect(html).toMatch(/Running<\/dt><dd[^>]*>2</u);
    expect(html).toMatch(/Waiting<\/dt><dd[^>]*>7</u);
    expect(html).toMatch(/On hold<\/dt><dd[^>]*>1</u);
  });

  it("keeps the ordinary waiting of healthy work in Now", () => {
    const html = drawer(answered({ status: ready(queueStatus) }));
    expect(html).toContain("Tasks run one after another.");
    expect(html).not.toContain("Nothing is waiting.");
  });

  it("puts a hold in Waiting with the reason, the time it clears and the action", () => {
    const paused = drawer(answered({ status: ready(pausedStatus) }));
    expect(paused).toContain("Nothing is running right now.");
    expect(paused).not.toContain("Nothing is waiting.");
    expect(paused).toContain("Automatic organizing is paused.");
    expect(paused).toContain(">Resume<");

    const limited = drawer(answered({ status: ready(rateLimitedStatus) }));
    expect(limited).toContain("Your AI provider is limiting requests.");
    expect(limited).toMatch(/Resumes around/u);

    const downloading = drawer(answered({ status: ready(downloadingStatus) }));
    expect(downloading).toContain("A model is downloading.");
    expect(downloading).toContain("About 5 minutes left.");
    expect(downloading).toContain(">Open local models<");
  });

  it("names the model loading while the embedder loads", () => {
    const html = drawer(answered({ embedderLoading: true }));
    expect(html).toContain("A model is loading into memory.");
    expect(html).not.toContain("Nothing is waiting.");
  });

  it("puts what only the person can clear in Needs you, with its actions", () => {
    const html = drawer(answered({ status: ready(signInStatus) }));
    expect(html).toContain("needs you to sign in");
    expect(html).toContain(">Sign in<");
    expect(html).not.toContain("Nothing needs your attention.");

    const money = drawer(answered({ status: ready(money80Status) }));
    expect(money).toContain("$4.10 of $5.00 used this month.");
    expect(money).toContain(">Continue<");
    expect(money).toContain(">Raise the limit<");
  });

  it("adds the budget's own hold when a higher one hides it", () => {
    const html = drawer(
      answered({
        status: ready(signInStatus),
        budget: ready(budgetSnapshot({ state: "paused", spentUsd: 4.1 }))
      })
    );
    expect(html).toContain(">Sign in<");
    expect(html).toContain(">Continue<");
    expect(html).toContain("Paused near the limit");
  });

  it("counts the reviews that wait, and offers the Inbox only when the host can open it", () => {
    const without = drawer(answered({ inboxTotal: 3 }));
    expect(without).toContain("Waiting for your review: 3");
    expect(without).not.toContain("Open Inbox");
    const open = drawer(answered({ inboxTotal: 3 }), { onOpenInbox: vi.fn() });
    expect(open).toContain(">Open Inbox<");
    expect(drawer(answered({ inboxTotal: 0 }))).not.toContain(">Needs you</h3>");
  });

  it("shows an action that is running, and one that failed", () => {
    const pending = drawer(
      answered({
        status: ready(pausedStatus),
        statusAction: { action: "resume", status: "pending" }
      })
    );
    expect(pending).toMatch(/<button[^>]*disabled[^>]*>Resume</u);
    const failed = drawer(
      answered({
        status: ready(pausedStatus),
        statusAction: { action: "resume", status: "failed" }
      })
    );
    expect(failed).toContain("That did not work. Try again.");
    expect(failed).toContain('role="alert"');
  });

  it("lists what was done, newest first, each with an Undo it can use", () => {
    const html = drawer(
      answered({
        done: ready([
          changeSet(1),
          changeSet(2, {
            kind: "overview",
            titleKey: "changes.titles.overview.patch",
            titleParams: {}
          }),
          changeSet(3, { undo: "blocked" }),
          changeSet(4, { undo: "unavailable" })
        ])
      })
    );
    expect(html).toContain("Placed 12 items in topics");
    expect(html).toContain("Topic overview extended");
    expect(html.match(/>Undo</gu)).toHaveLength(2);
    expect(html).toContain("It cannot be undone now: a later change depends on it.");
    expect(html).not.toContain("00000000-0000");
  });

  it("puts a change's time on its own muted line under its title, never inside the title", () => {
    const html = drawer(answered({ done: ready([changeSet(1)]) }));
    expect(html).toContain('<p class="text-sm text-foreground">Placed 12 items in topics</p>');
    expect(html).toMatch(
      /Placed 12 items in topics<\/p><p class="text-xs text-muted-foreground">[^<]+<\/p>/u
    );
    expect(html).not.toMatch(/Placed 12 items in topics[^<]* · /u);
  });

  it("keeps Undo on the title's line, flush with the column's right edge", () => {
    const html = drawer(answered({ done: ready([changeSet(1)]) }));
    // Baseline-aligned with the title (not start-aligned), the button's padding pulled back.
    expect(html).toMatch(/class="flex items-baseline justify-between gap-3"/u);
    expect(html).toMatch(/<button[^>]*class="[^"]*-my-1 -mr-1 /u);
  });

  it("shows the result of an undo beside the change", () => {
    const one = changeSet(1);
    const html = drawer(
      answered({
        done: ready([one, changeSet(2), changeSet(3)]),
        undo: {
          [`topic:${one.id}`]: { status: "pending" },
          [`topic:${changeSet(2).id}`]: {
            status: "blocked",
            messageKey: "changes.blockers.later_change"
          },
          [`topic:${changeSet(3).id}`]: {
            status: "failed",
            messageKey: "activity.done.undoFailed"
          }
        }
      })
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Undoing\.\.\.</u);
    expect(html).toContain("A later change touched the same items. Undo that one first.");
    expect(html).toContain("The change could not be undone. Try again.");
    expect(html.match(/role="alert"/gu)).toHaveLength(2);
  });

  it("shows the month's spending, the state of the limit and the subscription's allowance", () => {
    const html = drawer(
      answered({
        budget: ready(
          budgetSnapshot({ state: "exhausted", spentUsd: 5 }, { usedCalls: 190, reservedCalls: 10 })
        )
      })
    );
    expect(html).toContain("$5.00 of $5.00 used this month.");
    expect(html).toContain("Limit reached");
    expect(html).toContain("Your AI subscription is not metered in money.");
    expect(html).toContain("Today’s background allowance: 25% used.");
    // The limit reached is also a thing that needs the person.
    expect(html).toContain("spending limit for background AI work is reached");
    expect(html).toContain(">Raise the limit<");
  });

  it("shows no subscription line before a background call was made", () => {
    expect(drawer(answered())).not.toContain("subscription");
  });

  it("reads in every locale, with no missing message and no bare parameter", () => {
    const snapshot = answered({
      status: ready(money80Status),
      inboxTotal: 2,
      jobs: { running: 1, waiting: 2, onHold: 3 },
      done: ready([changeSet(1), changeSet(2, { undo: "blocked" })]),
      budget: ready(budgetSnapshot({ state: "paused" }, { usedCalls: 80 })),
      undo: {
        [`topic:${changeSet(1).id}`]: { status: "failed", messageKey: "activity.done.undoFailed" }
      }
    });
    for (const locale of supportedLanguageCodes) {
      const html = drawer(snapshot, {
        t: createTranslator(locale),
        onOpenInbox: vi.fn()
      });
      expect(html, locale).not.toMatch(/\[\[missing|\{\w+\}/u);
    }
    const failed = activitySnapshot({
      open: true,
      status: ready(idleStatus),
      budget: { status: "error" },
      done: { status: "error" }
    });
    for (const locale of supportedLanguageCodes) {
      const html = drawer(failed, { t: createTranslator(locale) });
      expect(html, locale).not.toMatch(/\[\[missing|\{\w+\}/u);
      expect(html.match(/text-muted-foreground">[^<]*<\/p><\/div>/gu), locale).toHaveLength(2);
    }
    const french = drawer(snapshot, { t: createTranslator("fr") });
    expect(french).toContain("Activité");
    expect(french).toContain("Terminé");
  });
});

describe("the live region", () => {
  it("says the result of an action, and says an identical one twice", () => {
    const base = activitySnapshot({ status: ready(idleStatus) });
    expect(announcementText(en, base)).toBe("");
    const first = announcementText(en, {
      ...base,
      announcement: { id: 1, kind: "message", key: "activity.done.undone" }
    });
    const second = announcementText(en, {
      ...base,
      announcement: { id: 2, kind: "message", key: "activity.done.undone" }
    });
    expect(first).toBe("Change undone.");
    expect(second.trim()).toBe("Change undone.");
    expect(second).not.toBe(first);
  });

  it("says the sentence when the Gardener starts to need the person", () => {
    const text = announcementText(en, {
      ...activitySnapshot({ status: ready(signInStatus) }),
      announcement: { id: 1, kind: "attention" }
    });
    expect(text).toContain("needs you to sign in");
  });
});

describe("the host", () => {
  const noticeCenter = () =>
    new TopicNoticeCenter(() => ({
      undo: async () => ({ status: "undone", changeSetId: "cs", generation: 1 })
    }));

  it("has the notice's live region in the page before any notice, and fills the same one", () => {
    const region =
      /<div role="status" aria-live="polite" aria-atomic="true" data-notice-live="" class="sr-only">([^<]*)<\/div>/u;
    const empty = renderToString(
      <ActivityHost t={en} onNavigate={vi.fn()} notices={noticeCenter()} />
    );
    expect(empty).toMatch(region);
    expect(empty.match(region)?.[1]).toBe("");
    const center = noticeCenter();
    center.show(pinNotice(true, "Memory"), "cs", "idle");
    const shown = renderToString(<ActivityHost t={en} onNavigate={vi.fn()} notices={center} />);
    expect(shown.match(region)?.[1]).toContain("Pinned Memory.");
    expect(shown.match(region)?.[1]).toContain("Undo U");
    // The pill itself carries no second live region for the same words.
    expect(shown.match(/data-activity-notice="" class="[^"]*"/u)).not.toBeNull();
    expect(shown.match(/role="status"/gu)).toHaveLength(2);
  });

  it("renders the pill before anything is read, without touching the window", () => {
    const html = renderToString(<ActivityHost t={en} onNavigate={vi.fn()} />);
    expect(html).toContain("Checking activity…");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<aside");
  });
});
