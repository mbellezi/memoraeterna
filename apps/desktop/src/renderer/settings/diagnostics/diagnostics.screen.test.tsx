// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../workspace/test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtures, render } from "./diagnostics.screen";

type Mode = "loading" | "empty" | "error" | "success";
let dom: TestDom;
let calls: string[];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const settle = () => dom.act(() => void vi.advanceTimersByTime(0));
/**
 * The fake `window.app` of the screens tool, in short: a call answers from the fixtures; in loading
 * the pages' reads wait and in error they fail (Settings' own reads answer in both, as the screen
 * module says).
 */
const mount = async (mode: Mode) => {
  dom = createTestDom();
  calls = [];
  const set = mode === "empty" || mode === "success" ? fixtures[mode] : (fixtures[mode] ?? {});
  const call =
    (path: string) =>
    (...args: unknown[]) => {
      calls.push(path);
      const fixture = (set as Record<string, unknown>)[path];
      if (fixture !== undefined)
        return Promise.resolve(typeof fixture === "function" ? fixture(...args) : fixture);
      if (mode === "loading") return new Promise(() => undefined);
      return Promise.reject(new Error(`no ${path}`));
    };
  (dom.window as unknown as { app: unknown }).app = {
    settings: { describe: call("settings.describe"), getApp: call("settings.getApp") },
    monitoring: { list: call("monitoring.list") },
    jobs: { list: call("jobs.list") },
    onAppEvent: () => () => undefined
  };
  await dom.render(render());
  for (let step = 0; step < 4; step += 1) await settle();
};
const reads = (path: string) => calls.filter((call) => call === path).length;
const frame = () => dom.document.querySelector("[data-surface]");
const state = () => frame()?.getAttribute("data-state");
const text = () => dom.document.body.textContent ?? "";
const press = (label: string) => {
  const found = [...dom.document.querySelectorAll("button")].find(
    (button) => button.textContent === label
  );
  return dom.act(() => void found?.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
};

describe("the Diagnostics screen: Advanced as the app shows it, both pages open", () => {
  it("reports its own surface id and, with the call log and the job history, success", async () => {
    await mount("success");
    expect(frame()?.getAttribute("data-surface")).toBe("settings-diagnostics");
    expect(state()).toBe("success");
    expect(text()).toContain("1,284 calls recorded");
    expect(text()).toContain("5 finished runs");
    expect(reads("monitoring.list")).toBe(1);
    expect(reads("jobs.list")).toBe(1);
  });

  it("shows the pages in the Settings content column, each under its own row", async () => {
    await mount("success");
    const log = dom.document.querySelector('[data-setting-id="advanced.callLog"]');
    const history = dom.document.querySelector('[data-setting-id="advanced.taskHistory"]');
    expect(log?.querySelector("table")).not.toBeNull();
    expect(history?.textContent).toContain("5 finished runs");
    expect(frame()?.contains(log as Node)).toBe(true);
  });

  it("is loading while the pages read, with a busy status and no alert", async () => {
    await mount("loading");
    expect(state()).toBe("loading");
    expect(dom.document.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    expect(dom.document.querySelector('[role="alert"]')).toBeNull();
  });

  it("is empty when the log and the history have nothing, and says what they are for", async () => {
    await mount("empty");
    expect(state()).toBe("empty");
    expect(text()).toContain("No AI calls recorded yet");
    expect(text()).toContain("No finished jobs yet");
  });

  it("says each page's failure in place with its own retry, which reads only that page again", async () => {
    await mount("error");
    expect(state()).toBe("error");
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(text()).toContain("Nothing was changed.");
    expect(reads("monitoring.list")).toBe(1);
    expect(reads("jobs.list")).toBe(1);
    const log = dom.document.querySelector('[data-setting-id="advanced.callLog"]');
    const retry = [...(log?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Retry"
    );
    await dom.act(
      () => void retry?.dispatchEvent(new dom.window.Event("click", { bubbles: true }))
    );
    await settle();
    expect(reads("monitoring.list")).toBe(2);
    expect(reads("jobs.list")).toBe(1);
  });

  it("reads the failed calls only when asked, never on a timer", async () => {
    await mount("success");
    await dom.act(() => void vi.advanceTimersByTime(60_000));
    expect(reads("monitoring.list")).toBe(1);
    await press("Failed only");
    await settle();
    expect(reads("monitoring.list")).toBe(2);
  });
});
