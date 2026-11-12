// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { AddFailureNotice } from "./AddFailureNotice";
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

const reject = () => Promise.reject(new Error("nope"));
const pending = () => new Promise<never>(() => undefined);

function flowWith(api: unknown) {
  return new AddFlow({
    api: () => api as never,
    openSource: vi.fn(),
    openImportPanel: vi.fn(),
    storage: null
  });
}

describe("what the Add menu says when something fails", () => {
  it("marks no import mode while the first read is out, so the choice cannot jump", async () => {
    const flow = flowWith({
      ai: {
        listProfiles: pending,
        listProfileTasks: pending,
        listTaskRoutes: pending,
        listProviders: pending
      },
      localModels: { statuses: pending }
    });
    void flow.ensureReadiness();
    await dom.render(<AddMenu t={en} flow={flow} portal={false} openMenu />);
    const radios = Array.from(dom.document.querySelectorAll('[role="menuitemradio"]'));
    expect(radios).toHaveLength(3);
    expect(radios.every((radio) => radio.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("tells an unreadable mode inside the menu in a quiet line with one retry", async () => {
    const flow = flowWith({
      ai: {
        listProfiles: reject,
        listProfileTasks: reject,
        listTaskRoutes: reject,
        listProviders: reject
      },
      localModels: { statuses: reject }
    });
    await flow.ensureReadiness();
    await dom.render(<AddMenu t={en} flow={flow} portal={false} openMenu />);
    const menu = dom.document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu.textContent).toContain("Retry");
    expect(menu.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(menu.textContent?.match(/Retry/gu)).toHaveLength(1);
  });

  it("tells a failed pick once, in the status slot's notice, not inside the button or the menu", async () => {
    const flow = flowWith({
      ai: {
        listProfiles: async () => [],
        listProfileTasks: async () => [],
        listTaskRoutes: async () => [],
        listProviders: async () => []
      },
      localModels: { statuses: async () => [] },
      ingestion: { extractFileMetadata: reject }
    });
    await flow.pickFile();
    await dom.render(
      <>
        <AddFailureNotice t={en} flow={flow} />
        <AddMenu t={en} flow={flow} portal={false} />
      </>
    );
    const alerts = Array.from(dom.document.querySelectorAll('[role="alert"]'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("could not be added");
    expect(alerts[0]?.textContent).toContain("Retry");
    expect(alerts[0]?.className ?? "").not.toContain("shadow");
    // One line in the bar: a shorter whole form stands in for the sentence in a narrow slot, a
    // screen reader hears the sentence and what is kept either way, and the close names itself.
    expect(alerts[0]?.textContent).toContain("File not added.");
    expect(alerts[0]?.querySelector(".sr-only")?.textContent).toContain("could not be added");
    expect(alerts[0]?.querySelector(".sr-only")?.textContent).toContain("Nothing was saved");
    expect(alerts[0]?.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });
});
