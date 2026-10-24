import { describe, expect, it } from "vitest";

import { defaultAppSettings, defaultStorageSettings } from "../../../shared/ipc";
import {
  bookLookupModeOf,
  bookLookupModes,
  bookLookupPatch,
  obsidianSyncModeOf,
  obsidianSyncModePatch,
  obsidianSyncModes
} from "./merged-controls";

describe("the Obsidian sync control", () => {
  it("reads the two stored values as off, on or paused", () => {
    const of = (obsidianSyncEnabled: boolean, obsidianSyncPaused: boolean) =>
      obsidianSyncModeOf({ obsidianSyncEnabled, obsidianSyncPaused });
    expect(of(false, false)).toBe("off");
    expect(of(true, false)).toBe("on");
    expect(of(true, true)).toBe("paused");
    // Nothing tells a paused-while-off apart from off: every reader tests enabled && !paused.
    expect(of(false, true)).toBe("off");
    expect(obsidianSyncModeOf(defaultStorageSettings)).toBe("off");
  });

  it("writes the same two values back, so storage does not change", () => {
    for (const mode of obsidianSyncModes)
      expect(obsidianSyncModeOf(obsidianSyncModePatch(mode))).toBe(mode);
    expect(obsidianSyncModePatch("on")).toEqual({
      obsidianSyncEnabled: true,
      obsidianSyncPaused: false
    });
    expect(obsidianSyncModePatch("paused")).toEqual({
      obsidianSyncEnabled: true,
      obsidianSyncPaused: true
    });
    expect(obsidianSyncModePatch("off")).toEqual({
      obsidianSyncEnabled: false,
      obsidianSyncPaused: false
    });
  });
});

describe("the online book lookup control", () => {
  it("reads the switch and the provider as one choice", () => {
    expect(bookLookupModeOf(defaultAppSettings)).toBe("auto");
    expect(
      bookLookupModeOf({ metadataEnrichmentEnabled: false, bookMetadataProvider: "google-books" })
    ).toBe("off");
    expect(
      bookLookupModeOf({ metadataEnrichmentEnabled: true, bookMetadataProvider: "open-library" })
    ).toBe("open-library");
  });

  it("keeps the provider while the lookup is off and turns it on with the chosen one", () => {
    expect(bookLookupPatch("off")).toEqual({ metadataEnrichmentEnabled: false });
    expect(bookLookupPatch("google-books")).toEqual({
      metadataEnrichmentEnabled: true,
      bookMetadataProvider: "google-books"
    });
    for (const mode of bookLookupModes)
      expect(
        bookLookupModeOf({
          metadataEnrichmentEnabled: true,
          bookMetadataProvider: "auto",
          ...bookLookupPatch(mode)
        } as Parameters<typeof bookLookupModeOf>[0])
      ).toBe(mode);
  });
});
