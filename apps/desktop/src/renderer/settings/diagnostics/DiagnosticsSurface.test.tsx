// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../workspace/test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { fixtures } from "./diagnostics.screen";
import { DiagnosticsSurface } from "./DiagnosticsSurface";

const en = createTranslator("en");
let dom: TestDom;
let mode: "loading" | "empty" | "error" | "success";
let list: ReturnType<typeof vi.fn>;
let jobs: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  mode = "success";
  const answer = (fixture: unknown, args: unknown[]) => {
    if (mode === "loading") return new Promise(() => undefined);
    if (mode === "error") return Promise.reject(new Error("closed"));
    return Promise.resolve(typeof fixture === "function" ? fixture(...args) : fixture);
  };
  const set = () => (mode === "empty" ? fixtures.empty : fixtures.success);
  list = vi.fn((...args: unknown[]) => answer(set()["monitoring.list"], args));
  jobs = vi.fn((...args: unknown[]) => answer(set()["jobs.list"], args));
  dom = createTestDom();
  (dom.window as unknown as { app: unknown }).app = {
    monitoring: { list },
    jobs: { list: jobs },
    onAppEvent: () => () => undefined
  };
});
afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const mount = async () => {
  await dom.render(<DiagnosticsSurface t={en} />);
  await dom.act(() => void vi.advanceTimersByTime(0));
  await dom.act(() => void vi.advanceTimersByTime(0));
};
const state = () => dom.document.querySelector("[data-surface]")?.getAttribute("data-state");

describe("the Diagnostics surface", () => {
  it("reports its own surface id and, with the call log and the job history, success", async () => {
    await mount();
    expect(dom.document.querySelector("[data-surface]")?.getAttribute("data-surface")).toBe(
      "settings-diagnostics"
    );
    expect(state()).toBe("success");
    expect(dom.document.body.textContent).toContain("1,284 calls recorded");
    expect(dom.document.body.textContent).toContain("5 finished runs");
    expect(list).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveBeenCalledTimes(1);
  });

  it("is loading while the pages read, with a busy status and no alert", async () => {
    mode = "loading";
    await mount();
    expect(state()).toBe("loading");
    expect(dom.document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    expect(dom.document.querySelector('[role="alert"]')).toBeNull();
  });

  it("is empty when the log and the history have nothing, and says what they are for", async () => {
    mode = "empty";
    await mount();
    expect(state()).toBe("empty");
    expect(dom.document.body.textContent).toContain("No AI calls recorded yet");
    expect(dom.document.body.textContent).toContain("No finished jobs yet");
  });

  it("says one failure once, with one retry, when neither page could be read, and reads both again", async () => {
    mode = "error";
    await mount();
    expect(state()).toBe("error");
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(dom.document.body.textContent).toContain("The diagnostics could not be read.");
    expect(dom.document.body.textContent).toContain("Nothing was changed.");
    mode = "success";
    const retry = [...dom.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry"
    )!;
    await dom.act(() => void retry.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
    await dom.act(() => void vi.advanceTimersByTime(0));
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(state()).toBe("success");
    expect(list).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveBeenCalledTimes(2);
  });

  it("reads the failed calls only when asked, and reads again on a monitoring change, never on a timer", async () => {
    await mount();
    await dom.act(() => void vi.advanceTimersByTime(60_000));
    expect(list).toHaveBeenCalledTimes(1);
    const failedOnly = [...dom.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Failed only"
    )!;
    await dom.act(
      () => void failedOnly.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
    );
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", limit: 25 }));
  });
});
