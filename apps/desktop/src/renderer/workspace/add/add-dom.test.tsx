// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { AddMenu } from "./AddMenu";
import { AddFlow } from "./add-flow";
import { useWindowDrop } from "./use-window-drop";

const en = createTranslator("en");
let dom: TestDom;

beforeEach(() => {
  dom = createTestDom();
});
afterEach(async () => {
  await dom.dispose();
});

function flowOver() {
  const openImportPanel = vi.fn();
  const flow = new AddFlow({
    api: () => ({}) as never,
    openSource: vi.fn(),
    openImportPanel,
    storage: null
  });
  // Nothing under the menu needs a window: the menu only reads the flow's snapshot here.
  const pickFile = vi.spyOn(flow, "pickFile").mockResolvedValue();
  vi.spyOn(flow, "refreshReadiness").mockResolvedValue({ status: "ready", writer: true });
  return { flow, openImportPanel, pickFile };
}

const items = () => Array.from(dom.document.querySelectorAll('[role="menuitem"]'));
const itemNamed = (text: string) =>
  items().find((item) => item.textContent?.includes(text)) as HTMLElement;
const click = (element: Element) =>
  dom.act(() => void element.dispatchEvent(new dom.window.Event("click", { bubbles: true })));

describe("the Add menu, in the DOM", () => {
  it("sends the file item to the picker", async () => {
    const { flow, openImportPanel, pickFile } = flowOver();
    await dom.render(<AddMenu t={en} flow={flow} portal={false} openMenu />);
    await click(itemNamed("Choose a file"));
    expect(pickFile).toHaveBeenCalledTimes(1);
    expect(openImportPanel).not.toHaveBeenCalled();
  });

  // The menu closes on a choice, so each item gets its own menu.
  it.each(["Paste a link", "Write a note", "More import options"])(
    "sends %s to the advanced import panel",
    async (name) => {
      const { flow, openImportPanel, pickFile } = flowOver();
      await dom.render(<AddMenu t={en} flow={flow} portal={false} openMenu />);
      await click(itemNamed(name));
      expect(openImportPanel).toHaveBeenCalledTimes(1);
      expect(pickFile).not.toHaveBeenCalled();
    }
  );
});

function Probe({
  onFiles,
  enabled = true
}: {
  onFiles: (files: File[]) => void;
  enabled?: boolean;
}) {
  const drag = useWindowDrop(onFiles, enabled);
  return <output>{drag.active ? `over ${drag.count}` : "idle"}</output>;
}

const transfer = (types: string[], files: unknown[] = []) => ({
  types,
  items: files.map(() => ({ kind: "file" })),
  files,
  dropEffect: "none"
});
const fire = (type: string, dataTransfer: unknown) =>
  dom.act(() => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { dataTransfer });
    dom.window.dispatchEvent(event);
  });
const shown = () => dom.document.querySelector("output")?.textContent;

describe("a drag over the window, in the DOM", () => {
  it("shows the overlay state while files are over it and hands the dropped files over", async () => {
    const onFiles = vi.fn();
    await dom.render(<Probe onFiles={onFiles} />);
    expect(shown()).toBe("idle");
    const files = [{ name: "a.pdf" }, { name: "b.md" }];
    await fire("dragenter", transfer(["Files"], files));
    expect(shown()).toBe("over 2");
    await fire("drop", transfer(["Files"], files));
    expect(shown()).toBe("idle");
    expect(onFiles).toHaveBeenCalledWith(files);
  });

  it("stays out of the way of a dragged selection or link", async () => {
    const onFiles = vi.fn();
    await dom.render(<Probe onFiles={onFiles} />);
    await fire("dragenter", transfer(["text/plain"]));
    expect(shown()).toBe("idle");
    await fire("drop", transfer(["text/plain"]));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("leaves when the drag leaves, and takes nothing while disabled", async () => {
    const onFiles = vi.fn();
    await dom.render(<Probe onFiles={onFiles} />);
    await fire("dragenter", transfer(["Files"], [{ name: "a.pdf" }]));
    await fire("dragleave", transfer(["Files"], [{ name: "a.pdf" }]));
    expect(shown()).toBe("idle");
    await dom.render(<Probe onFiles={onFiles} enabled={false} />);
    await fire("dragenter", transfer(["Files"], [{ name: "a.pdf" }]));
    expect(shown()).toBe("idle");
    await fire("drop", transfer(["Files"], [{ name: "a.pdf" }]));
    expect(onFiles).not.toHaveBeenCalled();
  });
});
