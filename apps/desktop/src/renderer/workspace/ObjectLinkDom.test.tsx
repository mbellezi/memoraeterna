// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "./test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { hoverCardOpenDelayMs } from "../components/ui/hover-card";
import { ObjectLink } from "./ObjectLink";
import type { PreviewBatcher, PreviewResult } from "./preview-batcher";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const address = `memora://note/${uuid(1)}`;
const en = createTranslator("en");

let dom: TestDom;
let requests: Array<{ address: string; fresh: boolean }>;
let emitChange: (event: unknown) => void;

const ready: PreviewResult = {
  status: "ready",
  item: {
    address,
    kind: "note",
    title: "Lactic acid lowers the pH",
    status: "current",
    preview: "The acid brings the pH down.",
    updatedAt: "2026-11-03T09:12:00.000Z"
  }
};
const batcher: PreviewBatcher = {
  request(asked, options) {
    requests.push({ address: asked, fresh: options?.fresh === true });
    return Promise.resolve(ready);
  }
};

beforeEach(async () => {
  vi.useFakeTimers();
  requests = [];
  dom = createTestDom();
  (dom.window as unknown as { app: unknown }).app = {
    onAppEvent: (_type: string, handler: (event: unknown) => void) => {
      emitChange = handler;
      return () => undefined;
    }
  };
  await dom.render(
    <ObjectLink t={en} address={address} onOpen={() => undefined} portal={false} batcher={batcher}>
      Lactic acid
    </ObjectLink>
  );
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const link = () => dom.document.querySelector("a") as HTMLElement;
const card = () => dom.document.querySelector('[data-surface="object-card"]');
const advance = (ms: number) => dom.act(() => void vi.advanceTimersByTime(ms));

describe("the object card, in the DOM", () => {
  it("opens after 300 ms of keyboard focus, not before, and reads the object only then", async () => {
    expect(card()).toBeNull();
    dom.focus(link());
    await advance(hoverCardOpenDelayMs - 1);
    expect(link().getAttribute("data-state")).toBe("closed");
    expect(card()).toBeNull();
    expect(requests).toEqual([]);
    await advance(2);
    expect(link().getAttribute("data-state")).toBe("open");
    await advance(20);
    expect(card()?.getAttribute("data-state")).toBe("success");
    expect(requests).toEqual([{ address, fresh: false }]);
  });

  it("opens on hover after the same 300 ms", async () => {
    await dom.act(() => {
      const enter = new dom.window.Event("pointerover", { bubbles: true });
      link().dispatchEvent(enter);
    });
    await advance(hoverCardOpenDelayMs - 1);
    expect(link().getAttribute("data-state")).toBe("closed");
    await advance(2);
    expect(link().getAttribute("data-state")).toBe("open");
  });

  it("closes with Esc, and neither takes the focus nor traps it", async () => {
    dom.focus(link());
    await advance(hoverCardOpenDelayMs + 20);
    expect(card()).not.toBeNull();
    // The focus is still on the link, and the card is not modal.
    expect(dom.document.activeElement).toBe(link());
    expect(dom.document.querySelector("[aria-modal]")).toBeNull();
    expect(dom.document.querySelector("[data-focus-guard]")).toBeNull();
    dom.key(dom.document.body, "Escape");
    await advance(20);
    expect(link().getAttribute("data-state")).toBe("closed");
    expect(card()).toBeNull();
    expect(dom.document.activeElement).toBe(link());
  });

  it("reads again after the object changes, and the re-read never joins an earlier call", async () => {
    dom.focus(link());
    await advance(hoverCardOpenDelayMs + 20);
    expect(requests).toEqual([{ address, fresh: false }]);
    await dom.act(() => {
      emitChange({
        type: "object.changed",
        refs: [{ kind: "note", id: uuid(1), change: "updated" }]
      });
    });
    await advance(20);
    expect(requests).toEqual([
      { address, fresh: false },
      { address, fresh: true }
    ]);
  });
});
