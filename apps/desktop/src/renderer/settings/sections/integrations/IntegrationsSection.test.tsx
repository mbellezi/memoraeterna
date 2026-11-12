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
let storage: () => Promise<unknown>;
let gateway: () => Promise<unknown>;
let layout: unknown;
let describeValues: Record<string, unknown>;
let editorial: unknown[];
let editorialRead: (() => Promise<unknown>) | null;
let applied: unknown;
let startSync: () => Promise<unknown>;
let reads: number;
let wikiRead: () => Promise<unknown>;
const wikiStatusOf = (conflicts: unknown[] = []) => ({
  active: true,
  job: null,
  delivery: null,
  scope: { sourceIds: ["6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e01"], includeDescendants: true },
  conflicts,
  retired: { archived: 0, absent: 0, keptTotal: 0, kept: [] }
});

const vaultSettings = {
  obsidianVaultPath: "~/Vault",
  managedRoot: "Memora",
  obsidianSyncEnabled: true,
  obsidianSyncPaused: false,
  uploadCopiesEnabled: false,
  uploadCopiesFolderPath: null,
  updatedAt: "2026-11-12T09:00:00.000Z"
};
const client = (status: string, name = "Browser") => ({
  id: "0b6c9a40-7a41-4f10-8c0b-5a0b7f3a9c11",
  clientType: "chrome-extension",
  displayName: name,
  status,
  createdAt: new Date(Date.now() - 12 * 86_400_000),
  lastSeenAt: null
});
const migration = (status: string) => ({
  id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e55",
  status,
  createdAt: "x",
  config: { version: 2, language: "pt-BR", attachments: "copy" },
  targets: [
    {
      id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e56",
      oldPath: null,
      newPath: "Memora/a.pdf",
      status: "planned",
      reason: null,
      bytes: 1,
      links: [],
      base: null,
      local: null,
      proposed: null
    }
  ]
});

const describeEntries = () =>
  settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => ({
      id: entry.id,
      value: describeValues[entry.id] ?? (entry.control === "switch" ? false : null),
      default: null,
      changed: false
    }));

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  reads = 0;
  wikiRead = () => Promise.resolve(wikiStatusOf());
  editorial = [];
  editorialRead = null;
  applied = { config: null, migrations: [] };
  startSync = () => Promise.resolve({});
  storage = () => {
    reads += 1;
    return Promise.resolve(vaultSettings);
  };
  gateway = () => {
    reads += 1;
    return Promise.resolve({
      state: "ready",
      host: "127.0.0.1",
      port: 47613,
      baseUrl: "http://127.0.0.1:47613"
    });
  };
  layout = { config: { version: 2, language: "pt-BR", attachments: "omit" }, migrations: [] };
  describeValues = { bookLookup: "auto", "metadata:google-books": null };
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
      get: () => storage(),
      getApp: () => Promise.resolve({ contentLanguage: "pt-BR" }),
      update: (patch: object) => {
        calls.push(["settings.update", patch]);
        return Promise.resolve({ ...vaultSettings, ...patch });
      },
      updateApp: record("settings.updateApp", {}),
      selectObsidianVault: record("settings.selectObsidianVault", {
        ...vaultSettings,
        obsidianVaultPath: "~/Other"
      }),
      updateGoogleBooksKey: record("settings.updateGoogleBooksKey", { configured: true })
    },
    obsidian: {
      getSyncStatus: () =>
        Promise.resolve({
          state: "completed",
          stage: "completed",
          progress: 1,
          processed: 0,
          total: 0,
          synced: 0,
          conflicts: 0,
          projected: 0,
          startedAt: null,
          finishedAt: new Date().toISOString(),
          error: null
        }),
      startSync: () => {
        calls.push(["obsidian.startSync", {}]);
        return startSync();
      },
      wikiStatus: () => {
        reads += 1;
        return wikiRead();
      },
      saveWikiScope: record("obsidian.saveWikiScope", {}),
      layoutStatus: () => {
        reads += 1;
        return Promise.resolve(layout);
      },
      previewLayout: (input: unknown) => {
        calls.push(["obsidian.previewLayout", input]);
        return Promise.resolve({ ...(layout as object), migrations: [migration("preview")] });
      },
      applyLayout: (input: unknown) => {
        calls.push(["obsidian.applyLayout", input]);
        return Promise.resolve(applied);
      },
      rollbackLayout: (input: unknown) => {
        calls.push(["obsidian.rollbackLayout", input]);
        return Promise.resolve(applied);
      },
      editorialConflicts: () => {
        reads += 1;
        return editorialRead ? editorialRead() : Promise.resolve(editorial);
      }
    },
    integrations: {
      getGatewayStatus: () => gateway(),
      listClients: () =>
        Promise.resolve([client("paired", "My Chrome"), client("revoked", "Old one")]),
      revokeClient: record("integrations.revokeClient", true),
      createPairing: record("integrations.createPairing", {
        clientId: "0b6c9a40-7a41-4f10-8c0b-5a0b7f3a9c99",
        token: "t".repeat(40)
      })
    },
    onAppEvent: () => () => undefined
  };
});

afterEach(async () => {
  await dom.dispose();
  vi.useRealTimers();
});

const settle = async () => {
  for (let round = 0; round < 3; round += 1) await dom.act(() => void vi.advanceTimersByTime(0));
};
const mount = async (t = en) => {
  await dom.render(
    <SettingsSurface t={t} initialSection="integrations" sections={sectionRegistry} />
  );
  await settle();
};
const row = (id: string) => dom.document.querySelector(`[data-setting-id="${id}"]`) as HTMLElement;
const button = (text: string | RegExp, within: ParentNode = dom.document) =>
  [...within.querySelectorAll("button")].find((candidate) => {
    const name = `${candidate.getAttribute("aria-label") ?? ""}|${candidate.textContent ?? ""}`;
    return typeof text === "string" ? candidate.textContent === text : text.test(name);
  }) as HTMLElement;
const click = (element: Element) =>
  dom.act(() => void element.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
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
const called = (name: string) =>
  calls.filter(([candidate]) => candidate === name).map(([, input]) => input);

describe("Settings › Integrations", () => {
  it("draws a row for each registry entry of the section and no other, and reports success", async () => {
    expect(Object.keys(sectionRegistry)).toContain("integrations");
    await mount();
    expect(
      [...dom.document.querySelectorAll("[data-setting-id]")].map((element) =>
        element.getAttribute("data-setting-id")
      )
    ).toEqual(entriesOf("integrations").map((entry) => entry.id));
    expect(dom.document.querySelector("[data-surface]")?.getAttribute("data-state")).toBe(
      "success"
    );
  });

  it("shows the vault folder, and chooses another through the system picker", async () => {
    await mount();
    expect(row("obsidianVaultPath").textContent).toContain("~/Vault");
    await click(button(/Change folder/, row("obsidianVaultPath")));
    expect(called("settings.selectObsidianVault")).toHaveLength(1);
    expect(row("obsidianVaultPath").textContent).toContain("~/Other");
  });

  it("says no vault is chosen, and keeps the sync's On and Paused out of reach until one is", async () => {
    storage = () =>
      Promise.resolve({ ...vaultSettings, obsidianVaultPath: null, obsidianSyncEnabled: false });
    await mount();
    expect(row("obsidianVaultPath").textContent).toContain("No vault chosen");
    expect(row("obsidianSync").textContent).toContain(
      "Choose the vault folder above to turn the sync on."
    );
    const segments = [
      ...row("obsidianSync").querySelectorAll("[aria-pressed]")
    ] as HTMLButtonElement[];
    expect(segments.map((segment) => segment.disabled)).toEqual([false, true, true]);
  });

  it("shows when the sync last ran, says nothing about conflicts while none waits, and runs it now", async () => {
    await mount();
    expect(row("obsidianSync").textContent).toContain("Synced today");
    expect(row("obsidianSync").textContent).not.toContain("conflict");
    expect(row("obsidianSync").textContent).not.toContain("waiting for review");
    await click(button("Sync now"));
    expect(called("obsidian.startSync")).toHaveLength(1);
  });

  it("changes the sync mode through the two stored values", async () => {
    await mount();
    const paused = [...row("obsidianSync").querySelectorAll("[aria-pressed]")][2] as HTMLElement;
    await click(paused);
    expect(called("settings.update")).toEqual([
      { obsidianSyncEnabled: true, obsidianSyncPaused: true }
    ]);
  });

  it("says a failed read of the storage in the row, with a retry, and the rest of the section stays", async () => {
    storage = () => Promise.reject(new Error("closed"));
    await mount();
    expect(row("obsidianVaultPath").textContent).toContain("Could not read the vault folder.");
    expect(row("bookLookup")).toBeTruthy();
    storage = () => Promise.resolve(vaultSettings);
    await click(button("Retry", row("obsidianVaultPath")));
    await settle();
    expect(row("obsidianVaultPath").textContent).toContain("~/Vault");
  });

  it("shows one failure and one retry for each failed read, and leaves no row loading", async () => {
    storage = () => Promise.reject(new Error("closed"));
    wikiRead = () => Promise.reject(new Error("down"));
    await mount();
    const alerts = [...dom.document.querySelectorAll("[role=alert]")].map(
      (element) => element.textContent ?? ""
    );
    // The storage read speaks on the vault row only; the wiki read on the sources row only.
    expect(alerts.filter((text) => text.includes("Could not read the vault folder."))).toHaveLength(
      1
    );
    expect(
      alerts.filter((text) => text.includes("Could not read the vault’s sources."))
    ).toHaveLength(1);
    expect(row("obsidianSync").querySelector("[role=alert]")).toBeNull();
    expect(dom.document.body.textContent).not.toContain("Could not load the projection");
    for (const alert of dom.document.querySelectorAll("[role=alert]"))
      expect(alert.querySelectorAll("button")).toHaveLength(1);
    // The chapters switch is drawn, out of reach, instead of staying a skeleton.
    const chapters = row("obsidian.wiki.includeDescendants").querySelector(
      "[role=switch]"
    ) as HTMLButtonElement;
    expect(chapters.disabled).toBe(true);
  });

  it("keeps the sources, the chapters switch and the review out of reach until a vault is chosen", async () => {
    storage = () =>
      Promise.resolve({ ...vaultSettings, obsidianVaultPath: null, obsidianSyncEnabled: false });
    await mount();
    const choose = button("Choose sources…", row("obsidian.wiki.scope")) as HTMLButtonElement;
    expect(choose.disabled).toBe(true);
    expect(
      (row("obsidian.wiki.includeDescendants").querySelector("[role=switch]") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(row("obsidian.wiki.scope").textContent).toContain(
      "Choose the vault folder above to choose what becomes pages."
    );
    expect(dom.document.body.textContent).not.toContain("Vault reviews");
  });

  it("names the two review lists after what they hold, in one heading style", async () => {
    wikiRead = () =>
      Promise.resolve(
        wikiStatusOf([
          {
            id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e91",
            relative_path: "Sources/a.md",
            status: "conflict",
            error: null
          }
        ])
      );
    editorial = [
      {
        id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e77",
        path: "Notes/edited-in-obsidian.md",
        receipt: { status: "conflict", revision: "r1", comparison: null }
      }
    ];
    await mount();
    const headings = [...dom.document.querySelectorAll("h4")].map((h) => h.textContent);
    expect(headings).toEqual(["Pages edited on both sides", "Plugin edits"]);
    expect(dom.document.body.textContent).not.toContain("Sync review");
    expect(dom.document.body.textContent).not.toContain("Pending local edits");
  });

  it("counts what waits for review once: the sync line takes the number of the vault reviews", async () => {
    editorial = [
      {
        id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e77",
        path: "Notes/edited-in-obsidian.md",
        receipt: { status: "conflict", revision: "r1", comparison: null }
      }
    ];
    await mount();
    expect(row("obsidianSync").textContent).toContain("1 waiting for review");
    expect(dom.document.body.textContent).toContain("Vault reviews · 1 waiting");
    expect(dom.document.body.textContent).not.toContain("0 conflicts");
  });

  it("says a failed read of the plugin's edits as a read, with one retry, and never keeps loading", async () => {
    editorialRead = () => Promise.reject(new Error("down"));
    await mount();
    const text = dom.document.body.textContent ?? "";
    expect(text).toContain("Could not read the plugin edits.");
    expect(text).not.toContain("Delivery failed");
    expect(text).not.toContain("Loading projection");
    expect(text).not.toContain("nothing waiting");
    const alert = [...dom.document.querySelectorAll("[role=alert]")].find((element) =>
      element.textContent?.includes("plugin edits")
    ) as HTMLElement;
    expect(alert.querySelectorAll("button")).toHaveLength(1);
    editorialRead = null;
    await click(button("Retry", alert));
    await settle();
    expect(dom.document.body.textContent).not.toContain("Could not read the plugin edits.");
  });

  it("keeps the plugin's waiting edits in view when only the wiki read failed", async () => {
    wikiRead = () => Promise.reject(new Error("down"));
    editorial = [
      {
        id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e77",
        path: "Notes/edited-in-obsidian.md",
        receipt: { status: "conflict", revision: "r1", comparison: null }
      }
    ];
    await mount();
    const text = dom.document.body.textContent ?? "";
    expect(text).toContain("Vault reviews · 1 waiting");
    expect(text).toContain("Notes/edited-in-obsidian.md");
    expect(text).not.toContain("Pages edited on both sides");
    // The Sources row still says its one failure.
    expect(
      [...dom.document.querySelectorAll("[role=alert]")].filter((a) =>
        a.textContent?.includes("Could not read the vault’s sources.")
      )
    ).toHaveLength(1);
  });

  it("shows one failure and one retry for one failed storage read, in the vault row only", async () => {
    storage = () => Promise.reject(new Error("closed"));
    await mount();
    const alerts = [...dom.document.querySelectorAll("[role=alert]")];
    expect(alerts).toHaveLength(1);
    expect(row("obsidianVaultPath").contains(alerts[0]!)).toBe(true);
    expect(row("obsidian.layout.attachments").querySelector("[role=alert]")).toBeNull();
    expect(row("obsidian.layout.attachments").textContent).not.toContain("Choose the vault folder");
    expect(
      (row("obsidian.layout.attachments").querySelector("[role=switch]") as HTMLButtonElement)
        .disabled
    ).toBe(true);
    storage = () => Promise.resolve(vaultSettings);
    const before = reads;
    await click(button("Retry", row("obsidianVaultPath")));
    await settle();
    // The same retry read the layout again too.
    expect(reads).toBeGreaterThan(before);
    expect(dom.document.querySelectorAll("[role=alert]")).toHaveLength(0);
  });

  it("says once, in the sources row, that a vault is needed, and leaves the chapters switch bare", async () => {
    storage = () =>
      Promise.resolve({ ...vaultSettings, obsidianVaultPath: null, obsidianSyncEnabled: false });
    await mount();
    expect(row("obsidian.wiki.scope").textContent).toContain("Choose the vault folder above");
    expect(row("obsidian.wiki.includeDescendants").textContent).not.toContain(
      "Choose the vault folder"
    );
  });

  it("says what to do when the local connection is stopped", async () => {
    gateway = () =>
      Promise.resolve({ state: "stopped", host: "127.0.0.1", port: null, baseUrl: null });
    await mount();
    await click(row("integrations.gateway").querySelector("button[aria-expanded]")!);
    const page = row("integrations.gateway").textContent ?? "";
    expect(page).toContain("It starts when Memora opens");
    expect((button("Pair an app…") as HTMLButtonElement).disabled).toBe(true);
  });

  it("counts the chosen sources, saves the chapters switch at once with the saved sources", async () => {
    await mount();
    expect(row("obsidian.wiki.scope").textContent).toContain("1 source chosen");
    await click(row("obsidian.wiki.includeDescendants").querySelector("[role=switch]")!);
    expect(called("obsidian.saveWikiScope")).toEqual([
      { sourceIds: ["6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e01"], includeDescendants: false }
    ]);
  });

  it("prepares a migration when 'copy the original files' is flipped, never an instant write", async () => {
    await mount();
    await click(row("obsidian.layout.attachments").querySelector("[role=switch]")!);
    expect(called("obsidian.previewLayout")).toEqual([
      { version: 2, language: "pt-BR", attachments: "copy" }
    ]);
    // The switch moved to what was asked, and the review says what is left to do.
    expect(
      row("obsidian.layout.attachments")
        .querySelector("[role=switch]")
        ?.getAttribute("aria-checked")
    ).toBe("true");
    expect(row("obsidian.layout.attachments").textContent).toContain("The change is prepared.");
    const apply = button(/Apply/, row("obsidian.layout.attachments")) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    const editors = [
      ...row("obsidian.layout.attachments").querySelectorAll("input[type=checkbox]")
    ].pop() as HTMLInputElement;
    await prop(editors, "onChange", { target: { checked: true } });
    expect(
      (button(/Apply/, row("obsidian.layout.attachments")) as HTMLButtonElement).disabled
    ).toBe(false);
    await click(button(/Apply/, row("obsidian.layout.attachments")));
    expect(called("obsidian.applyLayout")).toEqual([
      { id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e55", excludeIds: [], editorsClosed: true }
    ]);
  });

  const editorsBox = () =>
    [...row("obsidian.layout.attachments").querySelectorAll("input[type=checkbox]")].pop() as
      HTMLInputElement | undefined;
  const applyButton = () =>
    button(/Apply/, row("obsidian.layout.attachments")) as HTMLButtonElement;
  const rollbackButton = () =>
    button(/Roll back|Rollback/i, row("obsidian.layout.attachments")) as HTMLButtonElement;

  it("asks 'I closed my editors' again for every Apply and Rollback", async () => {
    applied = { ...(layout as object), migrations: [migration("completed")] };
    await mount();
    await click(row("obsidian.layout.attachments").querySelector("[role=switch]")!);
    await prop(editorsBox()!, "onChange", { target: { checked: true } });
    await click(applyButton());
    expect(called("obsidian.applyLayout")).toHaveLength(1);
    // The migration is applied and can be rolled back, but the old confirmation is gone.
    expect(rollbackButton()).toBeTruthy();
    expect(rollbackButton().disabled).toBe(true);
    expect(editorsBox()!.checked).toBe(false);
    await prop(editorsBox()!, "onChange", { target: { checked: true } });
    expect(rollbackButton().disabled).toBe(false);
    await click(rollbackButton());
    expect(called("obsidian.rollbackLayout")).toHaveLength(1);
    expect(editorsBox()!.checked).toBe(false);
  });

  it("counts the plugin's edits that wait for review, and opens the review for them", async () => {
    editorial = [
      {
        id: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e77",
        path: "Notes/edited-in-obsidian.md",
        receipt: {
          operationId: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e78",
          targetId: "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e79",
          status: "conflict",
          revision: "r1",
          syncVersion: 1,
          contentHash: "a".repeat(64),
          projection: "conflict",
          content: "x",
          reason: null,
          comparison: { base: "b", local: "l", app: "a" }
        }
      }
    ];
    await mount();
    const text = dom.document.body.textContent ?? "";
    expect(text).toContain("Vault reviews · 1 waiting");
    expect(text).not.toContain("nothing waiting");
    expect(text).toContain("Notes/edited-in-obsidian.md");
  });

  it("says a failed Sync now by its own sentence, not as a failed change of the mode", async () => {
    startSync = () => Promise.reject(new Error("unbound"));
    await mount();
    await click(button("Sync now"));
    expect(called("obsidian.startSync")).toHaveLength(1);
    expect(row("obsidianSync").textContent).toContain("Could not start the sync.");
    expect(row("obsidianSync").textContent).not.toContain("Could not change the sync");
  });

  it("changes the book lookup through the stored pair, and keeps the Google Books key out of the page after saving it", async () => {
    await mount();
    const select = row("bookLookup").querySelector("select") as HTMLSelectElement;
    await prop(select, "onChange", { target: { value: "off" } });
    expect(called("settings.updateApp")).toEqual([{ metadataEnrichmentEnabled: false }]);
    await click(button(/Save key/, row("metadata:google-books")));
    const input = row("metadata:google-books").querySelector(
      "input[type=password]"
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    await prop(input, "onChange", { target: { value: "AIza-secret" } });
    const form = row("metadata:google-books").querySelector("form") as HTMLFormElement;
    await prop(form, "onSubmit");
    expect(called("settings.updateGoogleBooksKey")).toEqual([{ apiKey: "AIza-secret" }]);
    expect(dom.document.body.innerHTML).not.toContain("AIza-secret");
  });

  it("opens the gateway page with its address and paired apps, asks before revoking, and revokes", async () => {
    await mount();
    expect(row("integrations.gateway").textContent).toContain("1 app · connection ready");
    await click(row("integrations.gateway").querySelector("button[aria-expanded]")!);
    const page = row("integrations.gateway");
    expect(page.textContent).toContain("http://127.0.0.1:47613");
    expect(page.textContent).toContain("My Chrome");
    expect(page.textContent).not.toContain("Old one");
    await click(button(/Revoke: My Chrome/, page));
    expect(called("integrations.revokeClient")).toEqual([]);
    expect(page.textContent).toContain("Revoke the access of My Chrome?");
    await click(button(/Revoke: My Chrome/, page));
    expect(called("integrations.revokeClient")).toEqual(["0b6c9a40-7a41-4f10-8c0b-5a0b7f3a9c11"]);
  });

  it("pairs an app and shows the token once, then forgets it", async () => {
    await mount();
    await click(row("integrations.gateway").querySelector("button[aria-expanded]")!);
    await click(button("Pair an app…"));
    const form = row("integrations.gateway").querySelector("form") as HTMLFormElement;
    await prop(form, "onSubmit");
    expect(called("integrations.createPairing")).toEqual([
      { clientType: "chrome-extension", displayName: "Chrome extension" }
    ]);
    expect(row("integrations.gateway").textContent).toContain("t".repeat(40));
    expect(row("integrations.gateway").textContent).toContain("shows only this once");
    await click(button("I copied it"));
    expect(row("integrations.gateway").textContent).not.toContain("t".repeat(40));
  });

  it("says a gateway that cannot be read in its row, quietly", async () => {
    gateway = () => Promise.reject(new Error("down"));
    await mount();
    // The row opens by itself, so the sentence and its retry are in view.
    expect(row("integrations.gateway").textContent).toContain("Could not be read");
    expect(row("integrations.gateway").textContent).toContain(
      "Could not read the local connection."
    );
    expect(button("Retry", row("integrations.gateway"))).toBeTruthy();
  });

  it("starts no timer and speaks pt-BR without English chrome", async () => {
    await mount(ptBR);
    const before = reads;
    await dom.act(() => void vi.advanceTimersByTime(60_000));
    // Nothing is read again on a timer: the statuses move only with the bus events.
    expect(reads).toBe(before);
    expect(called("obsidian.startSync")).toEqual([]);
    const text = dom.document.body.textContent ?? "";
    expect(text).toContain("Sincronizar agora");
    expect(text).toContain("Escolher fontes…");
    expect(text).not.toContain("Sync now");
  });
});
