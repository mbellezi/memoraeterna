import { describe, expect, it } from "vitest";
import { appMenuCommandSchema, appViewIds } from "./app-menu";
import {
  formatObjectAddress,
  objectAddressSchema,
  objectKinds,
  parseObjectAddress,
  viewHistoryBounds,
  viewHistoryEntrySchema,
  viewHistoryListInputSchema,
  viewHistoryPinInputSchema,
  viewHistoryRecordInputSchema
} from "./view-history";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

describe("object addresses", () => {
  it("are memora://<kind>/<uuid> and round-trip", () => {
    for (const kind of objectKinds) {
      const address = formatObjectAddress(kind, id);
      expect(address).toBe(`memora://${kind}/${id}`);
      expect(parseObjectAddress(address)).toEqual({ kind, id });
    }
  });

  it("refuse titles, paths and other schemes, and normalize case", () => {
    for (const bad of [
      "",
      `memora://page/${id}`,
      `memora://source/${id}/extra`,
      `memora://source/${id}?x=1`,
      `memora://source/${id}#passage=${other}`,
      "memora://source/My Source",
      `https://example.com/source/${id}`,
      `memora://open/source/${id}`
    ])
      expect(objectAddressSchema.safeParse(bad).success, bad).toBe(false);
    expect(objectAddressSchema.parse(`MEMORA://Note/${id.toUpperCase()}`)).toBe(
      `memora://note/${id}`
    );
  });
});

describe("view history requests", () => {
  it("accepts an open with a one-line title cut to the stored bound", () => {
    const parsed = viewHistoryRecordInputSchema.parse({
      kind: "note",
      id,
      title: `  Line one\n  line two ${"x".repeat(400)}`,
      parentAddress: formatObjectAddress("source", other)
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
      { kind: "source", id, title: "x", parentAddress: formatObjectAddress("source", id) }
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
      viewHistoryPinInputSchema.parse({ address: formatObjectAddress("source", id), pinned: false })
    ).toEqual({ address: `memora://source/${id}`, pinned: false });
    expect(viewHistoryPinInputSchema.safeParse({ address: `memora://source/${id}` }).success).toBe(
      false
    );
  });

  it("reads back what the service sends", () => {
    const entry = {
      address: formatObjectAddress("source", id),
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
