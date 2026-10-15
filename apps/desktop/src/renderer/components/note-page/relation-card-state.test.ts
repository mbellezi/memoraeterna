import { describe, expect, it } from "vitest";

import { notePageTiming } from "./note-page-model";
import {
  cardReducer,
  initialCardState,
  type CardEvent,
  type CardState
} from "./relation-card-state";

const run = (events: CardEvent[], state: CardState = initialCardState) =>
  events.reduce(cardReducer, state);

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

  it("forgets everything on reset", () => {
    expect(run([{ type: "focusIn", id: "a" }, { type: "escape" }, { type: "reset" }])).toEqual(
      initialCardState
    );
  });
});
