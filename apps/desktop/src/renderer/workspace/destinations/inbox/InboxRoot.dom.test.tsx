// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyInboxCounts } from "@app/domain";
import { createTranslator } from "@app/i18n";

import type { PanelProps } from "../../PanelStack";
import { formatView } from "../../route";
import { InboxRoot, inboxKindOf } from "./InboxRoot";

// A Home "needs you" row opens `memora://inbox?kind=…`: the Inbox lists only that kind.
let dom: TestDom;
const list = vi.fn(() => Promise.resolve({ items: [], nextCursor: null }));

const onOpen = vi.fn();
const props = (address: string, over: Partial<PanelProps> = {}): PanelProps =>
  ({
    t: createTranslator("en"),
    address,
    mode: "full",
    active: true,
    onState: () => undefined,
    onPlace: () => undefined,
    onOpen,
    ...over
  }) as PanelProps;

beforeEach(() => {
  list.mockClear();
  onOpen.mockClear();
  dom = createTestDom();
  (dom.window as unknown as { app: unknown }).app = {
    inbox: { list, counts: () => Promise.resolve(emptyInboxCounts()), act: vi.fn() },
    changes: { diff: vi.fn() },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
});

const settle = () => dom.act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));
const lastKinds = () => (list.mock.calls.at(-1) as unknown as [{ kinds?: string[] }])[0].kinds;

describe("the Inbox root's address", () => {
  it("names the kind it was opened for, and none for the whole Inbox", () => {
    expect(inboxKindOf(formatView({ view: "inbox", kind: "suggestion" }))).toBe("suggestion");
    expect(inboxKindOf("memora://inbox")).toBeUndefined();
    expect(inboxKindOf("memora://home")).toBeUndefined();
  });

  it("narrows the list to the kind of memora://inbox?kind=suggestion", async () => {
    await dom.render(<InboxRoot {...props("memora://inbox?kind=suggestion")} />);
    await settle();
    expect(list).toHaveBeenCalled();
    expect(lastKinds()).toEqual(["suggestion"]);
  });

  it("follows a new kind in the address, and leaves the person's filter alone without one", async () => {
    await dom.render(<InboxRoot {...props("memora://inbox?kind=suggestion")} />);
    await settle();
    await dom.render(<InboxRoot {...props("memora://inbox?kind=review")} />);
    await settle();
    expect(lastKinds()).toEqual(["review"]);
    const reads = list.mock.calls.length;
    await dom.render(<InboxRoot {...props("memora://inbox")} />);
    await settle();
    // No kind in the address: nothing changes and nothing is read again.
    expect(list.mock.calls.length).toBe(reads);
  });

  it("lists everything for the plain root", async () => {
    await dom.render(<InboxRoot {...props("memora://inbox")} />);
    await settle();
    expect(lastKinds()).toBeUndefined();
  });

  it("spends the request: the root goes back to the plain Inbox once the kind is on screen", async () => {
    await dom.render(<InboxRoot {...props("memora://inbox?kind=suggestion")} />);
    await settle();
    expect(lastKinds()).toEqual(["suggestion"]);
    expect(onOpen).toHaveBeenCalledWith("memora://inbox", { replace: true });
    // The plain address asks for nothing, so a second Home row for the same kind is a change of
    // address again and narrows the list again.
    onOpen.mockClear();
    await dom.render(<InboxRoot {...props("memora://inbox")} />);
    await dom.render(<InboxRoot {...props("memora://inbox?kind=suggestion")} />);
    await settle();
    expect(lastKinds()).toEqual(["suggestion"]);
    expect(onOpen).toHaveBeenCalledWith("memora://inbox", { replace: true });
  });

  it("keeps the request while the root is hidden or only the previous panel, and has none to spend for the plain root", async () => {
    await dom.render(<InboxRoot {...props("memora://inbox?kind=review", { active: false })} />);
    await settle();
    await dom.render(<InboxRoot {...props("memora://inbox?kind=review", { mode: "compact" })} />);
    await settle();
    await dom.render(<InboxRoot {...props("memora://inbox")} />);
    await settle();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
