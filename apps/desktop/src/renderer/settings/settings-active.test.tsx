// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../workspace/test-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { createFakeAppEvents, type FakeAppEvents } from "../lib/fake-app-events";
import { settingsRegistryV2 } from "../../shared/settings-registry";
import { SettingsSurface } from "./SettingsSurface";
import { sectionRegistry } from "./sections-registry";

// The `active` contract of the Settings context: Settings stays mounted while another place is shown;
// then it listens to nothing and reads nothing, and it reads once more when it is shown again.

const en = createTranslator("en");

let dom: TestDom;
let bus: FakeAppEvents;
let reads: Record<string, number>;

const count = (name: string) => reads[name] ?? 0;
const counted =
  <T,>(name: string, value: T) =>
  () => {
    reads[name] = count(name) + 1;
    return Promise.resolve(value);
  };

const vault = {
  obsidianVaultPath: "~/Vault",
  managedRoot: "Memora",
  obsidianSyncEnabled: true,
  obsidianSyncPaused: false,
  uploadCopiesEnabled: false,
  uploadCopiesFolderPath: null,
  updatedAt: "2026-11-12T09:00:00.000Z"
};
const money = {
  spentUsd: 3.1,
  reservedUsd: 0,
  capUsd: 12,
  pauseShare: 0.8,
  continued: false,
  state: "open",
  priceTableVersion: "t"
};
const sync = {
  state: "completed",
  stage: "completed",
  progress: 1,
  processed: 0,
  total: 0,
  synced: 0,
  conflicts: 0,
  projected: 0,
  startedAt: null,
  finishedAt: "2026-11-12T09:00:00.000Z",
  error: null
};

beforeEach(() => {
  vi.useFakeTimers();
  reads = {};
  bus = createFakeAppEvents();
  dom = createTestDom();
  const prototype = (dom.window as unknown as { HTMLElement: { prototype: object } }).HTMLElement
    .prototype as { focus?: () => void };
  prototype.focus = () => undefined;
  const entries = settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => ({
      id: entry.id,
      value: entry.control === "switch" ? false : null,
      default: entry.control === "switch" ? false : null,
      changed: false
    }));
  (dom.window as unknown as { app: unknown }).app = {
    settings: {
      describe: () => Promise.resolve({ entries }),
      reset: () => Promise.resolve({ id: "x", value: null }),
      get: counted("settings.get", vault),
      getApp: counted("settings.getApp", { contentLanguage: "pt-BR" })
    },
    knowledgeControls: {
      get: counted("knowledgeControls.get", {
        autonomy: "auto",
        monthlyCapUsd: 12,
        paused: false,
        treeShape: "balanced",
        onlyIdle: false,
        onlyOnAc: false
      }),
      update: () => Promise.resolve({})
    },
    budget: { snapshot: () => counted("budget.snapshot", { money })() },
    gardener: {
      status: counted("gardener.status", {
        state: "idle",
        params: {},
        coverage: { placed: 1, matched: 1, overviewsFresh: 1 }
      })
    },
    knowledge: { relationLabelsStatus: counted("knowledge.relationLabelsStatus", null) },
    jobs: {},
    obsidian: {
      getSyncStatus: counted("obsidian.getSyncStatus", sync),
      wikiStatus: counted("obsidian.wikiStatus", {
        active: true,
        job: null,
        delivery: null,
        scope: { sourceIds: [], includeDescendants: true },
        conflicts: [],
        retired: { archived: 0, absent: 0, keptTotal: 0, kept: [] }
      }),
      layoutStatus: counted("obsidian.layoutStatus", {
        config: { version: 2, language: "pt-BR", attachments: "omit" },
        migrations: []
      }),
      editorialConflicts: counted("obsidian.editorialConflicts", [])
    },
    integrations: {
      getGatewayStatus: counted("integrations.getGatewayStatus", {
        state: "ready",
        host: "127.0.0.1",
        port: 47613,
        baseUrl: "http://127.0.0.1:47613"
      }),
      listClients: counted("integrations.listClients", [])
    },
    onAppEvent: bus.api.onAppEvent
  };
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const settle = async () => {
  for (let round = 0; round < 4; round += 1) await dom.act(() => void vi.advanceTimersByTime(0));
};
const show = async (section: "knowledge" | "integrations", active: boolean) => {
  await dom.render(
    <SettingsSurface t={en} initialSection={section} sections={sectionRegistry} active={active} />
  );
  await settle();
};
const watched = [
  "settings.changed",
  "budget.changed",
  "gardener.status",
  "job.progress",
  "obsidian.sync",
  "obsidian.projection"
] as const;
const listeners = () => watched.map((type) => bus.listening(type));
const snapshotReads = () => ({ ...reads });

describe("the active contract of Settings › Knowledge and Integrations", () => {
  it.each([
    [
      "knowledge",
      [
        "knowledgeControls.get",
        "budget.snapshot",
        "gardener.status",
        "knowledge.relationLabelsStatus",
        "settings.getApp"
      ],
      ["settings.changed", "budget.changed", "gardener.status", "job.progress"]
    ],
    [
      "integrations",
      [
        "settings.get",
        "obsidian.getSyncStatus",
        "obsidian.wikiStatus",
        "obsidian.layoutStatus",
        "obsidian.editorialConflicts",
        "integrations.getGatewayStatus",
        "settings.getApp"
      ],
      ["settings.changed", "obsidian.sync", "obsidian.projection"]
    ]
  ] as const)(
    "%s: listens and reads while shown, nothing while hidden, one fresh read on return",
    async (section, readNames, eventTypes) => {
      await show(section, true);
      for (const name of readNames) expect(count(name), `${name} read once`).toBeGreaterThan(0);
      for (const type of eventTypes)
        expect(bus.listening(type), `${type} followed`).toBeGreaterThan(0);

      // Hidden: every subscription is released, and an event moves nothing.
      await show(section, false);
      expect(listeners()).toEqual([0, 0, 0, 0, 0, 0]);
      const hidden = snapshotReads();
      bus.emit({ type: "settings.changed", stores: ["app", "storage", "knowledge.controls"] });
      await settle();
      expect(snapshotReads()).toEqual(hidden);

      // Shown again: each read runs once more (not twice) and the subscriptions are back.
      await show(section, true);
      // `settings.get` and `settings.getApp` are read by several followers of one section (the
      // storage, the editorial reviews, the layout), so they move by more than one.
      for (const name of readNames) {
        const before = hidden[name] ?? 0;
        if (name.startsWith("settings.get")) expect(count(name)).toBeGreaterThan(before);
        else expect(count(name), `${name} read again on return`).toBe(before + 1);
      }
      for (const type of eventTypes)
        expect(bus.listening(type), `${type} again`).toBeGreaterThan(0);

      // The bus works again after the return.
      const afterReturn = snapshotReads();
      bus.emit({ type: "settings.changed", stores: ["app", "storage", "knowledge.controls"] });
      await settle();
      expect(count("settings.getApp")).toBeGreaterThan(afterReturn["settings.getApp"] ?? 0);
    }
  );
});
