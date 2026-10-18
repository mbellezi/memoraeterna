import { describe, expect, it } from "vitest";

import { notePageTiming } from "./note-page-model";
import {
  cardReducer,
  escapeClosesCard,
  initialCardState,
  type CardEvent,
  type CardState
} from "./relation-card-state";

const run = (events: CardEvent[], state: CardState = initialCardState) =>
  events.reduce(cardReducer, state);

describe("focus that lands on a row nobody chose", () => {
  it("focuses the row with its card closed, so no explanation is asked for", () => {
    const parked = run([
      { type: "park", id: "b" },
      { type: "focusIn", id: "b" }
    ]);
    expect(parked.open).toBeNull();
    expect(parked.focusWithin).toBe("b");
    expect(parked.dwell).toBeNull();
    expect(parked.explain).toBeNull();
    // The person's own Tab onto the row opens it once focus has left and come back.
    const away = run([{ type: "focusOut", id: "b" }], parked);
    expect(away.suppressed).toBeNull();
    expect(run([{ type: "focusIn", id: "b" }], away).open).toBe("b");
  });

  it("changes nothing for the card that is open, and lets a hover on the row open it", () => {
    const open = run([{ type: "focusIn", id: "a" }]);
    expect(run([{ type: "park", id: "a" }], open)).toBe(open);
    const parked = run([{ type: "park", id: "b" }]);
    expect(run([{ type: "pointerEnter", id: "b" }, { type: "timer" }], parked).open).toBeNull();
  });
});

describe("relation evidence card", () => {
  it("opens at once on keyboard focus and closes any other card", () => {
    const opened = run([{ type: "focusIn", id: "a" }]);
    expect(opened.open).toBe("a");
    expect(opened.pending).toBeNull();
    expect(run([{ type: "focusIn", id: "b" }], opened).open).toBe("b");
  });

  it("opens on hover after the delay, and not when the pointer left first", () => {
    const hovering = run([{ type: "pointerEnter", id: "a" }]);
    expect(hovering.open).toBeNull();
    expect(hovering.pending).toEqual({
      action: "open",
      id: "a",
      delayMs: notePageTiming.cardOpenDelayMs
    });
    expect(run([{ type: "timer" }], hovering).open).toBe("a");
    const left = run([{ type: "pointerLeave", id: "a" }], hovering);
    expect(left.pending).toBeNull();
    expect(run([{ type: "timer" }], left).open).toBeNull();
  });

  it("closes after the delay when the pointer leaves, unless it comes back", () => {
    const open = run([{ type: "pointerEnter", id: "a" }, { type: "timer" }]);
    const leaving = run([{ type: "pointerLeave", id: "a" }], open);
    expect(leaving.pending).toEqual({
      action: "close",
      id: "a",
      delayMs: notePageTiming.cardCloseDelayMs
    });
    expect(run([{ type: "timer" }], leaving).open).toBeNull();
    const back = run([{ type: "pointerEnter", id: "a" }], leaving);
    expect(back.pending).toBeNull();
    expect(run([{ type: "timer" }], back).open).toBe("a");
  });

  it("stays open while focus is in the row, even when the pointer leaves", () => {
    const state = run([
      { type: "focusIn", id: "a" },
      { type: "pointerEnter", id: "a" },
      { type: "pointerLeave", id: "a" },
      { type: "timer" }
    ]);
    expect(state.open).toBe("a");
    expect(run([{ type: "focusOut", id: "a" }], state).open).toBeNull();
  });

  it("closes at once when focus leaves and the pointer is elsewhere", () => {
    const state = run([
      { type: "focusIn", id: "a" },
      { type: "focusOut", id: "a" }
    ]);
    expect(state.open).toBeNull();
    const hovered = run([
      { type: "pointerEnter", id: "a" },
      { type: "focusIn", id: "a" },
      { type: "focusOut", id: "a" }
    ]);
    expect(hovered.open).toBe("a");
  });

  it("closes with Escape and stays closed until both pointer and focus have left the row", () => {
    const escaped = run([
      { type: "pointerEnter", id: "a" },
      { type: "focusIn", id: "a" },
      { type: "escape" }
    ]);
    expect(escaped.open).toBeNull();
    expect(escaped.suppressed).toBe("a");
    expect(run([{ type: "focusIn", id: "a" }], escaped).open).toBeNull();
    expect(run([{ type: "pointerEnter", id: "a" }], escaped).pending).toBeNull();
    const pointerGone = run([{ type: "pointerLeave", id: "a" }], escaped);
    expect(pointerGone.suppressed).toBe("a");
    const bothGone = run([{ type: "focusOut", id: "a" }], pointerGone);
    expect(bothGone.suppressed).toBeNull();
    expect(run([{ type: "focusIn", id: "a" }], bothGone).open).toBe("a");
    expect(run([{ type: "escape" }]).suppressed).toBeNull();
  });

  it("keeps one card open at a time and switches at once between hovered rows", () => {
    const a = run([{ type: "pointerEnter", id: "a" }, { type: "timer" }]);
    const b = run(
      [
        { type: "pointerLeave", id: "a" },
        { type: "pointerEnter", id: "b" }
      ],
      a
    );
    expect(b.open).toBe("b");
    expect(b.pending).toBeNull();
    // A card held by focus waits for the hover delay before another one replaces it.
    const focused = run([
      { type: "focusIn", id: "a" },
      { type: "pointerEnter", id: "b" }
    ]);
    expect(focused.open).toBe("a");
    expect(run([{ type: "timer" }], focused).open).toBe("b");
  });

  it("asks for no explanation while focus tabs past rows, only after a dwell on one", () => {
    const tabbed = run([
      { type: "focusIn", id: "a" },
      { type: "focusOut", id: "a" },
      { type: "focusIn", id: "b" },
      { type: "focusOut", id: "b" },
      { type: "focusIn", id: "c" }
    ]);
    expect(tabbed.open).toBe("c");
    expect(tabbed.explain).toBeNull();
    expect(tabbed.dwell).toEqual({ id: "c", delayMs: notePageTiming.explainDwellMs });
    expect(notePageTiming.explainDwellMs).toBeGreaterThanOrEqual(600);
    expect(run([{ type: "dwell" }], tabbed).explain).toBe("c");
  });

  it("asks for no explanation on a pointer sweep that switches cards at once", () => {
    const first = run([{ type: "pointerEnter", id: "a" }, { type: "timer" }]);
    expect(first.dwell?.id).toBe("a");
    const swept = run(
      [
        { type: "pointerLeave", id: "a" },
        { type: "pointerEnter", id: "b" },
        { type: "pointerLeave", id: "b" },
        { type: "pointerEnter", id: "c" }
      ],
      first
    );
    expect(swept.open).toBe("c");
    expect(swept.explain).toBeNull();
    expect(swept.dwell?.id).toBe("c");
  });

  it("never asks for a card that closed before its dwell, and stops asking when it closes", () => {
    const closed = run([
      { type: "focusIn", id: "a" },
      { type: "focusOut", id: "a" }
    ]);
    expect(closed.dwell).toBeNull();
    expect(run([{ type: "dwell" }], closed).explain).toBeNull();
    const asked = run([{ type: "focusIn", id: "a" }, { type: "dwell" }]);
    expect(asked.explain).toBe("a");
    expect(run([{ type: "escape" }], asked).explain).toBeNull();
    expect(run([{ type: "focusOut", id: "a" }], asked).explain).toBeNull();
    // A card that stays open keeps its request while the pointer comes and goes.
    expect(run([{ type: "pointerEnter", id: "a" }], asked).explain).toBe("a");
  });

  it("asks at once on a deliberate request for the open card only", () => {
    const open = run([{ type: "focusIn", id: "a" }]);
    const now = run([{ type: "explainNow", id: "a" }], open);
    expect(now.explain).toBe("a");
    expect(now.dwell).toBeNull();
    expect(run([{ type: "explainNow", id: "b" }], open)).toBe(open);
  });

  it("closes a card opened by hover with Escape pressed anywhere but in a text field", () => {
    const hovered = run([{ type: "pointerEnter", id: "a" }, { type: "timer" }]);
    const key = (target: unknown, init: { key?: string; defaultPrevented?: boolean } = {}) =>
      escapeClosesCard({ key: "Escape", defaultPrevented: false, target, ...init });
    // Focus is on the page heading, outside the row.
    expect(key({ tagName: "H1", isContentEditable: false })).toBe(true);
    expect(key(null)).toBe(true);
    expect(run([{ type: "escape" }], hovered).open).toBeNull();
    expect(key({ tagName: "INPUT" })).toBe(false);
    expect(key({ tagName: "TEXTAREA" })).toBe(false);
    expect(key({ tagName: "DIV", isContentEditable: true })).toBe(false);
    expect(key({ tagName: "H1" }, { defaultPrevented: true })).toBe(false);
    expect(key({ tagName: "H1" }, { key: "Enter" })).toBe(false);
  });

  it("forgets everything on reset", () => {
    expect(run([{ type: "focusIn", id: "a" }, { type: "escape" }, { type: "reset" }])).toEqual(
      initialCardState
    );
  });
});
