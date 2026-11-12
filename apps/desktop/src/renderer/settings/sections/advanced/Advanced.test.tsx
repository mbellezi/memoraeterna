// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../../../workspace/test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatchingConfigurationSchema, recommendedMatchingConfiguration } from "@app/domain";
import { createTranslator } from "@app/i18n";

import { defaultAppSettings, type AppSettings } from "../../../../shared/ipc";
import { settingsRegistryV2, type Json } from "../../../../shared/settings-registry";
import { SettingsSurface } from "../../SettingsSurface";
import { requestSettingsTarget, resetSettingsTargetForTests } from "../../settings-target";

const en = createTranslator("en");
const customId = "9d1c5a2e-4b1f-4d6a-9b0e-3f5c7a1d2e40";
const customConfiguration = MatchingConfigurationSchema.parse({
  ...recommendedMatchingConfiguration,
  sourceRelationSettings: {
    ...recommendedMatchingConfiguration.sourceRelationSettings,
    minConfidence: 0.8
  }
});
const recommendedApp = {
  ...defaultAppSettings,
  language: "en",
  updatedAt: "2026-11-12T09:00:00.000Z"
} as AppSettings;
const customApp: AppSettings = {
  ...recommendedApp,
  ...customConfiguration,
  matchingPresets: [{ id: customId, name: "Confidence test", settings: customConfiguration }],
  activeMatchingPresetId: customId
};

let dom: TestDom;
let app: AppSettings;
let values: Record<string, Json>;
let getApp: () => Promise<AppSettings>;
let updates: unknown[];
let storageUpdates: unknown[];
let calls: string[];
let monitoring: { list: ReturnType<typeof vi.fn>; prune: ReturnType<typeof vi.fn> };
let events: Record<string, Array<(event: unknown) => void>>;
let focused: Element[];

const describeEntries = () =>
  settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => ({
      id: entry.id,
      value: values[entry.id] ?? (entry.control === "switch" ? false : null),
      default: values[entry.id] ?? (entry.control === "switch" ? false : null),
      changed: false
    }));

beforeEach(() => {
  vi.useFakeTimers();
  resetSettingsTargetForTests();
  app = recommendedApp;
  values = { debugMode: false, debugFullCapture: false, obsidianVaultPath: true };
  getApp = () => Promise.resolve(app);
  updates = [];
  storageUpdates = [];
  calls = [];
  events = {};
  monitoring = {
    list: vi.fn(() =>
      Promise.resolve({
        rows: [],
        totals: {
          count: 0,
          failed: 0,
          running: 0,
          tokens: null,
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          cachedInputTokens: null,
          costEstimate: null,
          missingUsage: 0,
          missingCost: 0
        }
      })
    ),
    prune: vi.fn(() => Promise.resolve({ cutoff: "2026-10-12T00:00:00.000Z", count: 4 }))
  };
  dom = createTestDom();
  const prototype = (dom.window as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype as { focus?: () => void; select?: () => void };
  focused = [];
  prototype.focus = function focus(this: Element) {
    focused.push(this);
  };
  prototype.select = () => undefined;
  (dom.window as unknown as { app: unknown }).app = {
    settings: {
      describe: () => Promise.resolve({ entries: describeEntries() }),
      reset: (input: { id: string }) => Promise.resolve({ id: input.id, value: null }),
      getApp: () => getApp(),
      updateApp: (update: Record<string, unknown>) => {
        updates.push(update);
        app = { ...app, ...update } as AppSettings;
        return Promise.resolve(app);
      },
      update: (update: unknown) => {
        storageUpdates.push(update);
        return Promise.resolve({});
      }
    },
    ai: {
      setDeciderMode: (mode: string | null) => {
        calls.push(`decider:${mode}`);
        return Promise.resolve({});
      }
    },
    obsidian: {
      previewLayout: (input: { language: string }) => {
        calls.push(`layout:${input.language}`);
        return Promise.resolve({});
      }
    },
    debug: {
      clearSimilarityRuns: () => {
        calls.push("similarity");
        return Promise.resolve({ deletedCount: 12 });
      }
    },
    monitoring,
    jobs: {
      list: () => Promise.resolve([]),
      clearCompletedOrFailed: () => Promise.resolve({ deletedCount: 3 })
    },
    onAppEvent: (type: string, handler: (event: unknown) => void) => {
      (events[type] ??= []).push(handler);
      return () => undefined;
    }
  };
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const settle = () => dom.act(() => void vi.advanceTimersByTime(0));
const mount = async () => {
  await dom.render(<SettingsSurface t={en} initialSection="advanced" />);
  await settle();
  await settle();
};
const row = (id: string) =>
  dom.document.querySelector(`[data-setting-id="${id}"]`) as HTMLElement | null;
const text = () => dom.document.body.textContent ?? "";
const click = (element: Element) =>
  dom.act(() => void element.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
const propsOf = (element: Element) => {
  const key = Object.keys(element).find((name) => name.startsWith("__reactProps$"));
  return (element as unknown as Record<string, Record<string, (event: unknown) => void>>)[
    key ?? ""
  ]!;
};
const type = (input: Element, value: string) =>
  dom.act(() => propsOf(input).onChange?.({ target: { value } }));
const press = (input: Element, key: string) =>
  dom.act(() =>
    propsOf(input).onKeyDown?.({ key, preventDefault: () => undefined, currentTarget: input })
  );
const button = (label: string) =>
  [...dom.document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label)
  ) ?? null;
const within = (id: string, selector: string) => row(id)?.querySelector(selector) as HTMLElement;

describe("Advanced, in the DOM", () => {
  it("shows every setting the registry holds for it, and only those, each findable by its id", async () => {
    await mount();
    const shown = [...dom.document.querySelectorAll("[data-setting-id]")].map((element) =>
      element.getAttribute("data-setting-id")
    );
    const expected = settingsRegistryV2
      .filter((entry) => entry.section === "advanced")
      .map((entry) => entry.id);
    expect(new Set(shown)).toEqual(new Set(expected));
    expect(shown).toHaveLength(expected.length);
  });

  it("keeps the matching values read-only while Balanced is selected", async () => {
    await mount();
    expect(within("sourceRelationSettings.minConfidence", "input")?.hasAttribute("disabled")).toBe(
      true
    );
    expect(text()).not.toContain("differ from the calibrated set");
  });

  it("saves a number on Enter as the changed group with its neighbours, clamped to its limits", async () => {
    app = customApp;
    await mount();
    const input = within("sourceRelationSettings.maxRelationsPerPair", "input");
    expect(input.hasAttribute("disabled")).toBe(false);
    await type(input, "99");
    await press(input, "Enter");
    expect(updates).toEqual([
      {
        sourceRelationSettings: {
          ...customConfiguration.sourceRelationSettings,
          maxRelationsPerPair: 20
        }
      }
    ]);
  });

  it("says which values differ from the calibrated set and restores them in one press", async () => {
    app = customApp;
    await mount();
    expect(text()).toContain("1 value differs from the calibrated set.");
    expect(text()).toContain("Minimum confidence (0.80 instead of 0.85)");
    await click(button("Restore the calibrated values")!);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ activeMatchingPresetId: "recommended-v2" });
  });

  it("shows rows shaped like rows while the presets are read", async () => {
    getApp = () => new Promise(() => undefined);
    await mount();
    expect(dom.document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(row("sourceRelationSettings.minConfidence")).toBeNull();
    // The rows that need no preset are there already.
    expect(row("keepLocalEmbeddingModelsLoaded")).not.toBeNull();
  });

  it("says in place, quietly, that the presets could not be read, and reads again on the retry", async () => {
    getApp = () => Promise.reject(new Error("closed"));
    await mount();
    expect(dom.document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(text()).toContain("The matching presets could not be read.");
    expect(text()).toContain("Your saved values stay as they were.");
    getApp = () => Promise.resolve(app);
    await click(button("Retry")!);
    await settle();
    expect(row("sourceRelationSettings.minConfidence")).not.toBeNull();
  });

  it("writes a decider choice through the decider call, and a folder language only prepares the move", async () => {
    await mount();
    const select = within("relations.deciderMode", "select") as HTMLSelectElement;
    await dom.act(() => propsOf(select).onChange?.({ target: { value: "generative" } }));
    expect(calls).toContain("decider:generative");
    expect(text()).toContain("sends the notes’ text out");
    const layout = within("obsidian.layout.language", "select");
    await dom.act(() => propsOf(layout).onChange?.({ target: { value: "fr" } }));
    expect(calls).toContain("layout:fr");
    expect(text()).toContain("ready to review");
  });

  it("asks before it keeps complete prompts, and turns the diagnostics off together with the capture", async () => {
    values = { debugMode: true, debugFullCapture: false, obsidianVaultPath: true };
    await mount();
    const capture = within("debugFullCapture", '[role="switch"]');
    await click(capture);
    expect(text()).toContain("Keep complete prompts and responses?");
    expect(updates).toEqual([]);
    await click(button("Turn capture on")!);
    expect(updates).toEqual([{ debugFullCapture: true }]);
    const mode = within("debugMode", '[role="switch"]');
    await click(mode);
    expect(updates.at(-1)).toEqual({ debugMode: false, debugFullCapture: false });
  });

  it("opens a page a link names, reads it only then, and shows its empty state", async () => {
    await mount();
    expect(monitoring.list).not.toHaveBeenCalled();
    requestSettingsTarget({ section: "advanced", setting: "advanced.callLog" });
    await settle();
    await settle();
    expect(monitoring.list).toHaveBeenCalled();
    expect(text()).toContain("No AI calls recorded yet");
  });

  it("counts before it deletes old records, and deletes only after the confirmation", async () => {
    monitoring.list.mockResolvedValue({
      rows: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          kind: "ai",
          operation: "embed",
          taskType: "embed",
          modelId: "Qwen3-Embedding-0.6B",
          status: "succeeded",
          startedAt: new Date().toISOString(),
          durationMs: 38,
          tokenUsage: { totalTokens: 512 },
          error: null
        }
      ],
      totals: { count: 5, failed: 0, running: 0, tokens: null }
    });
    await mount();
    await click(within("advanced.callLog", "button"));
    await settle();
    await click(button("Delete old records…")!);
    expect(monitoring.prune).not.toHaveBeenCalled();
    await dom.act(() => void vi.advanceTimersByTime(300));
    await settle();
    expect(monitoring.prune).toHaveBeenCalledTimes(1);
    expect(monitoring.prune).toHaveBeenCalledWith({
      amount: 30,
      unit: "days",
      scope: "all",
      preview: true
    });
    expect(text()).toContain("4 records from before");
    await click(button("Delete records")!);
    await settle();
    expect(monitoring.prune).toHaveBeenLastCalledWith({
      amount: 30,
      unit: "days",
      scope: "all",
      preview: false
    });
    expect(text()).toContain("4 records deleted.");
  });

  it("asks before it deletes the similarity runs, and says how many went", async () => {
    await mount();
    await click(button("Delete runs…")!);
    expect(calls).not.toContain("similarity");
    await click(
      [...dom.document.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Delete runs"
      )!
    );
    await settle();
    expect(calls).toContain("similarity");
    expect(text()).toContain("12 runs deleted.");
  });

  it("takes a link to a matching value to its row even though the presets are still being read", async () => {
    let answer: (value: AppSettings) => void = () => undefined;
    getApp = () =>
      new Promise<AppSettings>((resolve) => {
        answer = resolve;
      });
    await mount();
    expect(row("sourceRelationSettings.minConfidence")).toBeNull();
    requestSettingsTarget({ section: "advanced", setting: "sourceRelationSettings.minConfidence" });
    await settle();
    expect(row("sourceRelationSettings.minConfidence")).toBeNull();
    answer(app);
    await settle();
    await settle();
    const target = row("sourceRelationSettings.minConfidence");
    expect(target).not.toBeNull();
    expect(focused).toContain(target);
    expect(target?.className).toContain("bg-surface-selected");
  });

  it("names, in the deletion's confirmation, everything that goes with the old calls", async () => {
    monitoring.list.mockResolvedValue({
      rows: [
        {
          id: "50000000-0000-4000-8000-000000000001",
          kind: "ai",
          operation: "embed",
          taskType: "embed",
          modelId: "Qwen3-Embedding-0.6B",
          status: "succeeded",
          startedAt: new Date().toISOString(),
          durationMs: 38,
          tokenUsage: { totalTokens: 512 },
          error: null
        }
      ],
      totals: { count: 5, failed: 0, running: 0, tokens: null }
    });
    await mount();
    await click(within("advanced.callLog", "button"));
    await settle();
    await click(button("Delete old records…")!);
    const dialog = text();
    expect(dialog).toContain("operation");
    expect(dialog).toContain("similarity");
  });

  it("starts a rename from the preset's own name and a copy from it, never from the 'Custom:' label", async () => {
    app = customApp;
    await mount();
    expect(text()).toContain("Custom: Confidence test");
    await click(button("Rename")!);
    const rename = within("activeMatchingPresetId", "input") as HTMLInputElement;
    expect(propsOf(rename).value).toBe("Confidence test");
    await click(button("Cancel")!);
    await click(button("Duplicate")!);
    const copy = within("activeMatchingPresetId", "input") as HTMLInputElement;
    expect(propsOf(copy).value).toBe("Confidence test (copy)");
  });

  it("reads the job history again on the first run that finishes after it opened", async () => {
    const jobsList = vi.fn(() => Promise.resolve([]));
    (dom.window as unknown as { app: { jobs: unknown } }).app.jobs = {
      list: jobsList,
      clearCompletedOrFailed: () => Promise.resolve({ deletedCount: 0 })
    };
    await mount();
    await click(within("advanced.taskHistory", "button"));
    await settle();
    expect(jobsList).toHaveBeenCalledTimes(1);
    const lane = { queued: 0, blocked: 0, running: 0, succeeded: 1, failed: 0, canceled: 0 };
    const idle = { ...lane, succeeded: 0 };
    await dom.act(() =>
      (events["job.progress"] ?? []).forEach((handler) =>
        handler({
          type: "job.progress",
          lanes: { heavy: idle, light: lane },
          changedIds: ["60000000-0000-4000-8000-000000000001"],
          changedIdsTruncated: false
        })
      )
    );
    await settle();
    expect(jobsList).toHaveBeenCalledTimes(2);
  });

  it("does not keep the rows of every call under the 'Only failures' chip while the failed ones are read", async () => {
    const calls = [
      {
        id: "50000000-0000-4000-8000-000000000001",
        kind: "ai",
        operation: "embed",
        taskType: "embed",
        modelId: "Qwen3-Embedding-0.6B",
        status: "succeeded",
        startedAt: new Date().toISOString(),
        durationMs: 38,
        tokenUsage: { totalTokens: 512 },
        error: null
      }
    ];
    monitoring.list.mockImplementation((query: { status: string }) =>
      query.status === "failed"
        ? new Promise(() => undefined)
        : Promise.resolve({
            rows: calls,
            totals: { count: 1, failed: 0, running: 0, tokens: null }
          })
    );
    await mount();
    await click(within("advanced.callLog", "button"));
    await settle();
    expect(dom.document.querySelector("table")).not.toBeNull();
    await click(button("Failed only")!);
    await settle();
    expect(dom.document.querySelector("table")).toBeNull();
    expect(button("Failed only")?.getAttribute("aria-pressed")).toBe("true");
  });
});
