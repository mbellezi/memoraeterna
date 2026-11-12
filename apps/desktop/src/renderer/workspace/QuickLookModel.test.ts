import { describe, expect, it, vi } from "vitest";

import {
  createQuickLookStore,
  isEditableElement,
  quickLookKey,
  quickLookTarget,
  toggleQuickLook,
  type QuickLookKey,
  type RowLookup
} from "./QuickLookModel";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number) => `memora://note/${uuid(n)}`;

const key = (overrides: Partial<QuickLookKey>): QuickLookKey => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides
});
const space = (overrides: Partial<QuickLookKey> = {}) =>
  key({ key: " ", code: "Space", ...overrides });
const cmdY = (overrides: Partial<QuickLookKey> = {}) =>
  key({ key: "y", code: "KeyY", metaKey: true, ...overrides });

describe("quick-look keys", () => {
  it("opens on Space from a row and closes on Space, outside text fields", () => {
    expect(quickLookKey(space(), false)).toBe("open-from-row");
    expect(quickLookKey(space(), true)).toBe("close");
  });

  it("refuses Space in a text field, open or not, and a modified Space", () => {
    expect(quickLookKey(space({ editable: true }), false)).toBeNull();
    expect(quickLookKey(space({ editable: true }), true)).toBeNull();
    expect(quickLookKey(space({ metaKey: true }), false)).toBeNull();
    expect(quickLookKey(space({ shiftKey: true }), true)).toBeNull();
    expect(quickLookKey(space({ altKey: true }), false)).toBeNull();
    expect(quickLookKey(space({ isComposing: true }), false)).toBeNull();
  });

  it("accepts Cmd-Y anywhere: in a text field, in Cmd-K, open or closed", () => {
    expect(quickLookKey(cmdY(), false)).toBe("toggle");
    expect(quickLookKey(cmdY(), true)).toBe("toggle");
    expect(quickLookKey(cmdY({ editable: true }), false)).toBe("toggle");
    // Ctrl-Y is not Cmd-Y on a Mac; on another platform it is.
    expect(quickLookKey(cmdY({ metaKey: false, ctrlKey: true }), false)).toBeNull();
    expect(quickLookKey(cmdY({ metaKey: false, ctrlKey: true }), false, "other")).toBe("toggle");
    // Cmd-Shift-Y is something else.
    expect(quickLookKey(cmdY({ shiftKey: true }), false)).toBeNull();
  });

  it("follows the list on the arrows only while the sheet is open, in a field too (Cmd-K)", () => {
    expect(quickLookKey(key({ key: "ArrowDown" }), true)).toBe("follow");
    expect(quickLookKey(key({ key: "ArrowUp" }), true)).toBe("follow");
    expect(quickLookKey(key({ key: "ArrowDown", editable: true }), true)).toBe("follow");
    expect(quickLookKey(key({ key: "ArrowDown" }), false)).toBeNull();
  });

  it("ends the peek after Enter, which the row handles itself; other keys are not its keys", () => {
    expect(quickLookKey(key({ key: "Enter" }), true)).toBe("close-after-enter");
    expect(quickLookKey(key({ key: "Enter", altKey: true }), true)).toBe("close-after-enter");
    expect(quickLookKey(key({ key: "Enter" }), false)).toBeNull();
    // Esc is the sheet primitive's own key; the model never claims it.
    expect(quickLookKey(key({ key: "Escape" }), true)).toBeNull();
    expect(quickLookKey(key({ key: "a" }), true)).toBeNull();
  });
});

// A row is a plain object that answers what the lookup reads.
interface FakeElement {
  attrs: Record<string, string>;
  tag?: string;
  parent?: FakeElement | null;
  closest(selector: string): FakeElement | null;
  getAttribute(name: string): string | null;
}
function element(attrs: Record<string, string>, parent: FakeElement | null = null): FakeElement {
  const self: FakeElement = {
    attrs,
    parent,
    closest(selector) {
      if (selector === "[data-quick-look]")
        return "data-quick-look" in this.attrs ? this : (this.parent?.closest(selector) ?? null);
      return null;
    },
    getAttribute: (name) => attrs[name] ?? null
  };
  return self;
}
const lookup = (parts: {
  active?: FakeElement | null;
  byId?: Record<string, FakeElement>;
  selected?: FakeElement | null;
}): RowLookup =>
  ({
    activeElement: parts.active ?? null,
    getElementById: (id: string) => parts.byId?.[id] ?? null,
    querySelectorAll: () => (parts.selected ? [parts.selected] : [])
  }) as unknown as RowLookup;

describe("which row quick-look peeks at", () => {
  it("takes the focused row, or the row that holds the focused element", () => {
    const row = element({ "data-quick-look": note(1) });
    const inside = element({}, row);
    expect(quickLookTarget(lookup({ active: row }))).toBe(note(1));
    expect(quickLookTarget(lookup({ active: inside }))).toBe(note(1));
  });

  it("follows aria-activedescendant, which is how Cmd-K keeps focus in its input", () => {
    const input = element({ "aria-activedescendant": "result-2" });
    const result = element({ "data-quick-look": note(2) });
    expect(quickLookTarget(lookup({ active: input, byId: { "result-2": result } }))).toBe(note(2));
  });

  it("falls back to the row marked selected, and to nothing", () => {
    const body = element({});
    const selected = element({ "data-quick-look": note(3), "aria-selected": "true" });
    expect(quickLookTarget(lookup({ active: body, selected }))).toBe(note(3));
    expect(quickLookTarget(lookup({ active: body }))).toBeNull();
    // Space never reaches for a selected row: the focus may be on a button or a switch elsewhere.
    expect(quickLookTarget(lookup({ active: body, selected }), false)).toBeNull();
    expect(quickLookTarget(lookup({}))).toBeNull();
  });

  it("skips a selected row inside a destination that is mounted but hidden", () => {
    const body = element({});
    const hiddenSelected = element({ "data-quick-look": note(4), "aria-selected": "true" });
    hiddenSelected.closest = (selector) =>
      selector === "[hidden], [inert]" ? element({ hidden: "" }) : null;
    const shown = element({ "data-quick-look": note(6), "data-selected": "true" });
    const doc = {
      activeElement: body,
      getElementById: () => null,
      querySelectorAll: () => [hiddenSelected, shown]
    } as unknown as RowLookup;
    // `closest` of the shown fake answers the peekable selector only, so it is shown.
    shown.closest = (selector) => (selector === "[data-quick-look]" ? shown : null);
    expect(quickLookTarget(doc)).toBe(note(6));
    const onlyHidden = {
      ...doc,
      querySelectorAll: () => [hiddenSelected]
    } as unknown as RowLookup;
    expect(quickLookTarget(onlyHidden)).toBeNull();
  });

  it("never peeks at an address that is not an object's", () => {
    const row = element({ "data-quick-look": "memora://settings" });
    expect(quickLookTarget(lookup({ active: row }))).toBeNull();
  });
});

describe("text fields", () => {
  const field = (tag: string, type?: string, editable?: boolean) =>
    ({
      tagName: tag.toUpperCase(),
      isContentEditable: editable,
      getAttribute: (name: string) => (name === "type" ? (type ?? null) : null)
    }) as unknown as Element;
  it("knows what takes text", () => {
    expect(isEditableElement(field("input"))).toBe(true);
    expect(isEditableElement(field("input", "search"))).toBe(true);
    expect(isEditableElement(field("textarea"))).toBe(true);
    expect(isEditableElement(field("div", undefined, true))).toBe(true);
    expect(isEditableElement(field("input", "checkbox"))).toBe(false);
    expect(isEditableElement(field("button"))).toBe(false);
    expect(isEditableElement(null)).toBe(false);
  });
});

describe("the store", () => {
  it("opens an object address, ignores any other, and tells its listeners once per change", () => {
    const store = createQuickLookStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.open("memora://search?q=salt");
    expect(store.get()).toBeNull();
    store.open(note(1));
    store.open(note(1));
    expect(store.get()).toBe(note(1));
    store.open(note(2));
    expect(store.get()).toBe(note(2));
    store.close();
    expect(store.get()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("toggles: closes what is open, else opens the row's address, else does nothing", () => {
    const store = createQuickLookStore();
    store.toggle(null);
    expect(store.get()).toBeNull();
    store.toggle(note(1));
    expect(store.get()).toBe(note(1));
    store.toggle(note(2));
    expect(store.get()).toBeNull();
  });

  it("Cmd-Y from anywhere peeks at the row the keyboard is on, and closes the open sheet", () => {
    const store = createQuickLookStore();
    const row = element({ "data-quick-look": note(5) });
    toggleQuickLook(lookup({ active: row }), store);
    expect(store.get()).toBe(note(5));
    toggleQuickLook(lookup({ active: row }), store);
    expect(store.get()).toBeNull();
    toggleQuickLook(lookup({}), store);
    expect(store.get()).toBeNull();
  });
});
