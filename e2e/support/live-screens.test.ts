import { describe, expect, it } from "vitest";

import { liveScreenListSchema, liveScreenSessions } from "./live-screens.js";

describe("liveScreenSessions", () => {
  it("gives every surface its own session, opened once and captured at 960 then 1440 px", () => {
    // A toggle (the context panel) must not be pressed again at 1440, and a dialog a surface
    // leaves open (the palette) must not cover the next one.
    const screens = liveScreenListSchema.parse([
      { id: "context-panel", keys: ["Meta+Shift+Backslash"] },
      { id: "palette", keys: ["Meta+K"] },
      { id: "destination-library", profile: "empty", keys: ["Meta+3"] }
    ]);
    const sessions = liveScreenSessions(screens);
    expect(sessions.map((session) => session.screen.id)).toEqual([
      "context-panel",
      "palette",
      "destination-library"
    ]);
    expect(new Set(sessions.map((session) => session.profileName)).size).toBe(3);
    expect(sessions.map((session) => session.captures)).toEqual([
      [
        { width: 960, index: 1 },
        { width: 1440, index: 2 }
      ],
      [
        { width: 960, index: 3 },
        { width: 1440, index: 4 }
      ],
      [
        { width: 960, index: 5 },
        { width: 1440, index: 6 }
      ]
    ]);
    expect(sessions.map((session) => session.source)).toEqual(["base", "base", "base-empty"]);
  });

  it("opens the first-run surface on a new, never-onboarded userData", () => {
    const [session] = liveScreenSessions(
      liveScreenListSchema.parse([{ id: "onboarding", profile: "first-run" }])
    );
    expect(session!.source).toBeNull();
  });

  it("refuses an unknown profile and a malformed address", () => {
    expect(() => liveScreenListSchema.parse([{ id: "x", profile: "fresh" }])).toThrow();
    expect(() => liveScreenListSchema.parse([{ id: "x", address: "memora://note/1" }])).toThrow();
  });
});
