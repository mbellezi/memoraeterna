import { formatObjectAddress, objectKinds, parseObjectAddress } from "@app/domain";
import { describe, expect, it } from "vitest";
import { appMenuCommandSchema, appViewIds } from "./app-menu";
import {
  objectAddressSchema,
  viewHistoryBounds,
  viewHistoryEntrySchema,
  viewHistoryListInputSchema,
  viewHistoryPinInputSchema,
  viewHistoryRecordInputSchema
} from "./view-history";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const mixed = "00000aa0-0000-4000-8000-00000000abcd";

describe("object addresses", () => {
  it("are memora://<kind>/<uuid> and round-trip", () => {
    for (const kind of objectKinds) {
      const address = formatObjectAddress({ kind, id });
      expect(address).toBe(`memora://${kind}/${id}`);
      expect(parseObjectAddress(address)).toEqual({ kind, id });
    }
  });

  it("are the domain's: one parser and one kind list, with no anchors in a history address", () => {
    for (const kind of objectKinds)
      expect(objectAddressSchema.parse(`memora://${kind}/${id}`)).toBe(`memora://${kind}/${id}`);
    expect(objectKinds).toEqual(["source", "note", "topic", "question", "entity"]);
  });

  it("refuse titles, paths and other schemes, and normalize the case of the id", () => {
    for (const bad of [
      "",
      `memora://page/${id}`,
      `memora://source/${id}/extra`,
      `memora://source/${id}?x=1`,
      `memora://source/${id}#passage=${other}`,
      "memora://source/My Source",
      `https://example.com/source/${id}`,
      `memora://open/source/${id}`,
      `MEMORA://Note/${id}`,
      `memora://source/${id}#span=${other}`,
      `memora://source/${id}${"a".repeat(400)}`
    ])
      expect(objectAddressSchema.safeParse(bad).success, bad).toBe(false);
    expect(objectAddressSchema.parse(`memora://note/${mixed.toUpperCase()}`)).toBe(
      `memora://note/${mixed}`
    );
  });
});

describe("view history requests", () => {
  it("accepts an open with a one-line title cut to the stored bound", () => {
    const parsed = viewHistoryRecordInputSchema.parse({
      kind: "note",
      id,
      title: `  Line one\n  line two ${"x".repeat(400)}`,
      parentAddress: formatObjectAddress({ kind: "source", id: other })
    });
    expect(parsed.title.startsWith("Line one line two xxx")).toBe(true);
    expect(Array.from(parsed.title)).toHaveLength(viewHistoryBounds.titleCharacters);
    expect(parsed.parentAddress).toBe(`memora://source/${other}`);
    expect(
      viewHistoryRecordInputSchema.parse({ kind: "source", id, title: "😀".repeat(500) }).title
    ).toBe("😀".repeat(viewHistoryBounds.titleCharacters));
  });

  it("refuses a title that is empty, an ID that is not a UUID and unknown fields", () => {
    for (const bad of [
      { kind: "source", id, title: " \n " },
      { kind: "source", id: "My Source", title: "x" },
      { kind: "source", id, title: "x", unexpected: 1 },
      { kind: "page", id, title: "x" },
      { kind: "source", id, title: "x", parentAddress: "not an address" },
      {
        kind: "source",
        id,
        title: "x",
        parentAddress: formatObjectAddress({ kind: "source", id })
      },
      // The same object in another case is still the object itself.
      {
        kind: "source",
        id: mixed,
        title: "x",
        parentAddress: `memora://source/${mixed.toUpperCase()}`
      }
    ])
      expect(viewHistoryRecordInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("bounds the page of a list", () => {
    expect(viewHistoryListInputSchema.parse({})).toEqual({});
    expect(viewHistoryListInputSchema.parse({ limit: 10, kinds: ["source", "note"] })).toEqual({
      limit: 10,
      kinds: ["source", "note"]
    });
    for (const bad of [{ limit: 0 }, { limit: viewHistoryBounds.listMax + 1 }, { limit: 2.5 }])
      expect(viewHistoryListInputSchema.safeParse(bad).success).toBe(false);
  });

  it("pins by address with a real boolean", () => {
    expect(
      viewHistoryPinInputSchema.parse({
        address: formatObjectAddress({ kind: "source", id }),
        pinned: false
      })
    ).toEqual({ address: `memora://source/${id}`, pinned: false });
    expect(viewHistoryPinInputSchema.safeParse({ address: `memora://source/${id}` }).success).toBe(
      false
    );
  });

  it("reads back what the service sends", () => {
    const entry = {
      address: formatObjectAddress({ kind: "source", id }),
      kind: "source",
      id,
      title: "A source",
      parentAddress: null,
      openedAt: "2026-10-15T10:00:00.000Z",
      openCount: 1,
      pinned: false
    };
    expect(viewHistoryEntrySchema.parse(entry)).toEqual(entry);
    expect(viewHistoryEntrySchema.safeParse({ ...entry, openCount: 0 }).success).toBe(false);
    expect(viewHistoryEntrySchema.safeParse({ ...entry, openedAt: "yesterday" }).success).toBe(
      false
    );
  });

  it("counts a stored title in characters, like the database, not in UTF-16 units", () => {
    const entry = (title: string) => ({
      address: formatObjectAddress({ kind: "source", id }),
      kind: "source",
      id,
      title,
      parentAddress: null,
      openedAt: "2026-10-15T10:00:00.000Z",
      openCount: 1,
      pinned: false
    });
    // The input is cut to 300 characters; such a title has more than 300 UTF-16 units.
    for (const title of ["📚" + "a".repeat(400), "😀".repeat(400)]) {
      const stored = viewHistoryRecordInputSchema.parse({ kind: "source", id, title }).title;
      expect(Array.from(stored)).toHaveLength(viewHistoryBounds.titleCharacters);
      expect(stored.length).toBeGreaterThan(viewHistoryBounds.titleCharacters);
      expect(viewHistoryEntrySchema.safeParse(entry(stored)).success, stored.slice(0, 4)).toBe(
        true
      );
    }
    // One character beyond the bound, or nothing at all, is still refused.
    expect(
      viewHistoryEntrySchema.safeParse(entry("📚".repeat(viewHistoryBounds.titleCharacters + 1)))
        .success
    ).toBe(false);
    expect(viewHistoryEntrySchema.safeParse(entry("")).success).toBe(false);
  });

  it("caps the pins at ten, so every pin fits on the Recents list", () => {
    expect(viewHistoryBounds.pinMax).toBe(10);
  });
});

describe("application menu commands", () => {
  it("are the four the renderer understands", () => {
    expect(appMenuCommandSchema.parse({ type: "close-panel" })).toEqual({ type: "close-panel" });
    expect(appMenuCommandSchema.parse({ type: "toggle-navigation" })).toEqual({
      type: "toggle-navigation"
    });
    expect(appMenuCommandSchema.parse({ type: "toggle-theme" })).toEqual({ type: "toggle-theme" });
    for (const view of appViewIds)
      expect(appMenuCommandSchema.parse({ type: "go-to", view })).toEqual({ type: "go-to", view });
  });

  it("refuse an unknown command, view or field", () => {
    for (const bad of [
      { type: "quit" },
      { type: "go-to", view: "nowhere" },
      { type: "go-to" },
      { type: "close-panel", force: true },
      "close-panel",
      null
    ])
      expect(appMenuCommandSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
