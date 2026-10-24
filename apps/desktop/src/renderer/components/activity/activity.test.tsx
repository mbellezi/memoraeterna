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
import { ActivityHost, announcementText } from "./ActivityHost";
import { ActivityPill } from "./ActivityPill";
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
    expect(html).toContain("Automatic organizing is paused.");
  });

  it("points at the drawer only while it is open", () => {
    const html = pill(activitySnapshot({ status: ready(idleStatus), open: true }), true);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="activity-drawer"');
  });

  it("covers loading, error and success, each with a glyph and a sentence", () => {
    expect(pill(activitySnapshot())).toContain("Checking what is happening...");
    expect(pill(activitySnapshot({ status: { status: "error" } }))).toContain(
      "Activity is not available right now."
    );
    expect(pill(activitySnapshot({ status: ready(idleStatus) }))).toContain(
      "Your library is up to date."
    );
    for (const status of [idleStatus, runningStatus, pausedStatus, signInStatus]) {
      expect(pill(activitySnapshot({ status: ready(status) }))).toContain("<svg");
    }
  });

  it("spins only while something is going on, and never with reduced motion", () => {
    expect(pill(activitySnapshot({ status: ready(runningStatus) }))).toContain(
      "motion-safe:animate-spin"
    );
    expect(pill(activitySnapshot({ status: ready(pausedStatus) }))).not.toContain("animate-spin");
  });

  it("shows the reviews that wait as a number the name also says", () => {
    const html = pill(activitySnapshot({ status: ready(idleStatus), inboxTotal: 3 }));
    expect(html).toContain("3 waiting for your review");
    expect(html).toMatch(/aria-hidden="true"[^>]*>3<\/span>/u);
    expect(pill(activitySnapshot({ status: ready(idleStatus), inboxTotal: 0 }))).not.toContain(
      "waiting for your review"
    );
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
    expect(html.match(/role="status"/gu)).toHaveLength(3);
    expect(html).toContain("Loading...");
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
    expect(html.match(/role="alert"/gu)).toHaveLength(3);
    expect(html.match(/>Retry</gu)).toHaveLength(3);
    expect(html).toContain("Activity could not be loaded.");
    expect(html).toContain("Recent changes could not be loaded.");
    expect(html).toContain("The spending meters could not be loaded.");
  });

  it("lists the five sections, and says plainly that nothing is waiting or needed", () => {
    const html = drawer(answered());
    for (const heading of ["Now", "Waiting", "Needs you", "Done", "Budget"])
      expect(html).toContain(`>${heading}</h3>`);
    expect(html).toContain("Your library is up to date.");
    expect(html).toContain("Nothing is waiting.");
    expect(html).toContain("Nothing needs your attention.");
    expect(html).toContain("Nothing was changed automatically yet.");
    expect(html).toContain("$1.20 of $5.00 used this month.");
    expect(html).toContain("Under the limit");
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
    expect(html).toContain("Nothing is waiting.");
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
    expect(drawer(answered({ inboxTotal: 0 }))).toContain("Nothing needs your attention.");
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
  it("renders the pill before anything is read, without touching the window", () => {
    const html = renderToString(<ActivityHost t={en} onNavigate={vi.fn()} />);
    expect(html).toContain("Checking what is happening...");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<aside");
  });
});
