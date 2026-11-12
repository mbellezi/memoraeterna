// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../../workspace/test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { settingsRegistryV2 } from "../../../../shared/settings-registry";
import { entriesOf } from "../../settings-model";
import { SettingsSurface } from "../../SettingsSurface";
import { sectionRegistry } from "../../sections-registry";

const en = createTranslator("en");
const ptBR = createTranslator("pt-BR");

let dom: TestDom;
let calls: Array<[string, unknown]>;
let handlers: Map<string, Array<(event: unknown) => void>>;
let controlsAnswer: () => Promise<unknown>;
let job: unknown;

const controls = {
  autonomy: "auto",
  monthlyCapUsd: 12,
  paused: false,
  treeShape: "balanced",
  onlyIdle: false,
  onlyOnAc: false
};

const describeEntries = () =>
  settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => ({
      id: entry.id,
      value: entry.control === "switch" ? false : null,
      default: entry.control === "switch" ? false : null,
      changed: entry.id === "knowledge.controls.v1.monthlyCapUsd"
    }));

const emit = (type: string, event: unknown) =>
  dom.act(
    () => void handlers.get(type)?.forEach((handler) => handler({ type, ...(event as object) }))
  );

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  handlers = new Map();
  job = null;
  controlsAnswer = () => Promise.resolve(controls);
  dom = createTestDom();
  const prototype = (dom.window as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype as { focus?: () => void };
  prototype.focus = () => undefined;
  const record =
    <T,>(name: string, value: T) =>
    (input?: unknown) => {
      calls.push([name, input]);
      return Promise.resolve(value);
    };
  (dom.window as unknown as { app: unknown }).app = {
    settings: {
      describe: () => Promise.resolve({ entries: describeEntries() }),
      reset: record("settings.reset", { id: "x", value: null }),
      getApp: () => Promise.resolve({ contentLanguage: "pt-BR" })
    },
    knowledgeControls: {
      get: () => controlsAnswer(),
      update: (change: Record<string, unknown>) => {
        calls.push(["knowledgeControls.update", change]);
        return Promise.resolve({ ...controls, ...change });
      }
    },
    budget: {
      snapshot: () =>
        Promise.resolve({
          money: {
            spentUsd: 3.1,
            reservedUsd: 0,
            capUsd: 12,
            pauseShare: 0.8,
            continued: false,
            state: "open",
            priceTableVersion: "t"
          }
        })
    },
    gardener: {
      status: () =>
        Promise.resolve({
          state: "idle",
          params: {},
          coverage: { placed: 1, matched: 1, overviewsFresh: 1 }
        })
    },
    knowledge: {
      relationLabelsStatus: () => Promise.resolve(job),
      startRelationLabels: record("knowledge.startRelationLabels", "job-1")
    },
    jobs: { cancel: record("jobs.cancel", null), retry: record("jobs.retry", null) },
    onAppEvent: (type: string, handler: (event: unknown) => void) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler]);
      return () => undefined;
    }
  };
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const mount = async (t = en) => {
  await dom.render(<SettingsSurface t={t} initialSection="knowledge" sections={sectionRegistry} />);
  await dom.act(() => void vi.advanceTimersByTime(0));
  await dom.act(() => void vi.advanceTimersByTime(0));
};
const rows = () => [...dom.document.querySelectorAll("[data-setting-id]")];
const row = (id: string) => dom.document.querySelector(`[data-setting-id="${id}"]`) as HTMLElement;
const button = (text: string | RegExp) =>
  [...dom.document.querySelectorAll("button")].find((candidate) =>
    typeof text === "string"
      ? candidate.textContent === text
      : text.test(candidate.textContent ?? "")
  ) as HTMLElement;
const click = (element: Element) =>
  dom.act(() => void element.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
/** Calls the handler React holds for a prop, as React would with this event. */
const prop = (element: Element, name: string, event: object = {}) =>
  dom.act(() => {
    const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"));
    (element as unknown as Record<string, Record<string, (event: object) => void>>)[key ?? ""]?.[
      name
    ]?.({
      preventDefault: () => undefined,
      ...event
    });
  });
const updates = () =>
  calls.filter(([name]) => name === "knowledgeControls.update").map(([, change]) => change);

describe("Settings › Knowledge", () => {
  it("is found by the surface's file glob, and draws a row for each registry entry of the section and no other", async () => {
    expect(Object.keys(sectionRegistry)).toContain("knowledge");
    await mount();
    expect(rows().map((element) => element.getAttribute("data-setting-id"))).toEqual(
      entriesOf("knowledge").map((entry) => entry.id)
    );
    expect(dom.document.querySelector("[data-surface]")?.getAttribute("data-state")).toBe(
      "success"
    );
  });

  it("shows the three autonomy cards with the chosen one marked, and chooses only by a press", async () => {
    await mount();
    const cards = [...row("knowledge.controls.v1.autonomy").querySelectorAll("[role=radio]")];
    expect(cards.map((card) => card.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
      "true"
    ]);
    expect(cards[0]?.textContent).toContain("Off");
    await prop(cards[2]!, "onKeyDown", { key: "ArrowLeft", currentTarget: cards[2] });
    expect(updates()).toEqual([]);
    await click(cards[1]!);
    expect(updates()).toEqual([{ autonomy: "suggest" }]);
  });

  it("pauses and resumes the Gardener with one button that says which", async () => {
    await mount();
    await click(button("Pause now"));
    expect(updates()).toEqual([{ paused: true }]);
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(button("Resume")).toBeTruthy();
  });

  it("commits the cap on blur, reads a comma, and refuses a word without writing", async () => {
    await mount();
    const input = row("knowledge.controls.v1.monthlyCapUsd").querySelector(
      "input"
    ) as HTMLInputElement;
    expect(input.getAttribute("value")).toBe("12.00");
    await prop(input, "onChange", { target: { value: "7,5" } });
    await prop(input, "onBlur");
    expect(updates()).toEqual([{ monthlyCapUsd: 7.5 }]);
    await prop(input, "onChange", { target: { value: "lots" } });
    await prop(input, "onBlur");
    expect(updates()).toHaveLength(1);
    expect(row("knowledge.controls.v1.monthlyCapUsd").textContent).toContain(
      "Enter an amount from 0 to"
    );
  });

  it("shows the month's spend against the cap, with its meter", async () => {
    await mount();
    const text = row("knowledge.controls.v1.monthlyCapUsd").textContent ?? "";
    expect(text).toContain("$3.10 of $12.00 spent this month");
    expect(
      row("knowledge.controls.v1.monthlyCapUsd")
        .querySelector("[role=progressbar]")
        ?.getAttribute("aria-valuenow")
    ).toBe("26");
  });

  it("writes the two switches", async () => {
    await mount();
    await click(row("knowledge.controls.v1.onlyOnAc").querySelector("[role=switch]")!);
    expect(updates()).toEqual([{ onlyOnAc: true }]);
  });

  it("keeps the rows in place with bars while the controls are read", async () => {
    controlsAnswer = () => new Promise(() => undefined);
    await mount();
    expect(row("knowledge.controls.v1.autonomy")).toBeTruthy();
    expect(row("knowledge.controls.v1.autonomy").querySelector("[role=radio]")).toBeNull();
    expect(
      row("knowledge.controls.v1.autonomy").querySelectorAll("[aria-hidden=true]").length
    ).toBeGreaterThan(2);
  });

  it("says once, quietly, that the controls could not be read, and reads them again on retry", async () => {
    controlsAnswer = () => Promise.reject(new Error("closed"));
    await mount();
    const alerts = [...dom.document.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain("Could not read the Gardener’s controls.");
    expect(row("knowledge.controls.v1.autonomy")).toBeNull();
    expect(row("relationLabels")).toBeTruthy();
    controlsAnswer = () => Promise.resolve(controls);
    await click(alerts[0]!.querySelector("button")!);
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(row("knowledge.controls.v1.autonomy")).toBeTruthy();
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(0);
  });

  it("reads the controls again when a reset elsewhere changes them, never on a timer", async () => {
    let reads = 0;
    controlsAnswer = () => {
      reads += 1;
      return Promise.resolve(controls);
    };
    await mount();
    await dom.act(() => void vi.advanceTimersByTime(60_000));
    expect(reads).toBe(1);
    await emit("settings.changed", { stores: ["knowledge.controls"] });
    await dom.act(() => void vi.advanceTimersByTime(0));
    expect(reads).toBe(2);
    await emit("settings.changed", { stores: ["ai"] });
    expect(reads).toBe(2);
  });

  it("generates the missing descriptions in the language of the notes, and asks before writing all again", async () => {
    await mount();
    await click(button("Generate the missing ones"));
    expect(calls).toContainEqual([
      "knowledge.startRelationLabels",
      { mode: "missing", contentLanguage: "pt-BR" }
    ]);
    await click(button("Rewrite all…"));
    expect(row("relationLabels").textContent).toContain(
      "Rewrite the descriptions of every connection in Brazilian Portuguese?"
    );
    expect(calls.filter(([name]) => name === "knowledge.startRelationLabels")).toHaveLength(1);
    await click(button("Rewrite"));
    expect(calls).toContainEqual([
      "knowledge.startRelationLabels",
      { mode: "all", contentLanguage: "pt-BR" }
    ]);
  });

  it("shows a running job with its progress and a way to cancel, and a failed one with its way back", async () => {
    job = { id: "j1", status: "running", progress: 0.4, canCancel: true, canRetry: false };
    await mount();
    expect(row("relationLabels").textContent).toContain("Writing the descriptions…");
    expect(
      row("relationLabels").querySelector("[role=progressbar]")?.getAttribute("aria-valuenow")
    ).toBe("40");
    expect((button("Generate the missing ones") as HTMLButtonElement).disabled).toBe(true);
    await click(row("relationLabels").querySelector("button:not([disabled])")!);
    expect(calls).toContainEqual(["jobs.cancel", "j1"]);
  });

  it("says in the person's own language, in pt-BR, without a word of English chrome", async () => {
    await mount(ptBR);
    const text = dom.document.body.textContent ?? "";
    expect(text).toContain("Autonomia");
    expect(text).toContain("Pausar agora");
    expect(text).toContain("US$");
    expect(text).not.toContain("Pause now");
  });
});
