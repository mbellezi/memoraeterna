import { afterEach, describe, expect, it, vi } from "vitest";

import { AppEventSchema, type AppEvent } from "../../shared/app-events.js";
import { appEventPort } from "./app-events.js";
import { ObsidianEditorialService } from "./obsidian-editorial-service.js";
import { ObsidianLayoutMigration } from "./obsidian-layout-migration.js";
import { trackObsidianProjection } from "./obsidian-projection-events.js";
import { ObsidianSyncService } from "./obsidian-sync-service.js";
import { ObsidianWikiProjection } from "./obsidian-wiki-projection.js";

const settings = {
  obsidianVaultPath: "/tmp/memora-test-vault",
  managedRoot: "Memora",
  obsidianSyncEnabled: true,
  obsidianSyncPaused: false,
  uploadCopiesEnabled: false,
  uploadCopiesFolderPath: null,
  updatedAt: new Date(0).toISOString()
};

function listen(): AppEvent[] {
  const events: AppEvent[] = [];
  appEventPort.attach({ publish: (event) => events.push(event) });
  return events;
}

const projections = (events: AppEvent[]) =>
  events.flatMap((event) =>
    event.type === "obsidian.projection" ? [`${event.kind}:${event.state}`] : []
  );

afterEach(() => appEventPort.detach());

describe("trackObsidianProjection", () => {
  it("publishes running, then completed, and returns the result", async () => {
    const events = listen();

    await expect(trackObsidianProjection("wiki", async () => 7)).resolves.toBe(7);

    expect(projections(events)).toEqual(["wiki:running", "wiki:completed"]);
    for (const event of events) expect(AppEventSchema.safeParse(event).success).toBe(true);
  });

  it("publishes failed and rethrows the same error", async () => {
    const events = listen();
    const failure = new Error("vault gone");

    await expect(
      trackObsidianProjection("layout", async () => {
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(projections(events)).toEqual(["layout:running", "layout:failed"]);
  });

  it("stays running when the result says more is left to deliver", async () => {
    const events = listen();

    await trackObsidianProjection(
      "wiki",
      async () => ({ done: false }),
      (result) => (result.done ? "completed" : "running")
    );

    expect(projections(events)).toEqual(["wiki:running", "wiki:running"]);
  });
});

describe("the four Obsidian services publish on their state changes", () => {
  it("the sync service publishes each status it takes, ending with the one it answers", async () => {
    const events = listen();
    const service = new ObsidianSyncService({
      getPool: () => null,
      getStorageSettings: async () => ({ ...settings, obsidianSyncEnabled: false })
    });

    const started = service.startSynchronization();
    await service.waitForSynchronization();

    const syncs = events.filter((event) => event.type === "obsidian.sync");
    expect(started.state).toBe("running");
    expect(syncs.map((event) => event.state)).toEqual(["running", "failed"]);
    const last: Record<string, unknown> = { ...syncs.at(-1)! };
    delete last.type;
    expect(last).toEqual(service.getSynchronizationStatus());
    expect(last).toMatchObject({ stage: "failed", error: "obsidian_sync_not_configured" });
    for (const event of syncs) expect(AppEventSchema.safeParse(event).success).toBe(true);
  });

  it("the editorial service publishes an edit that failed", async () => {
    const events = listen();
    const service = new ObsidianEditorialService({
      getPool: () => null,
      getStorageSettings: async () => settings,
      wiki: {} as never,
      write: vi.fn()
    });

    await expect(service.apply("client", {})).rejects.toThrow();
    await expect(service.acknowledge("client", "operation", "vault")).rejects.toThrow();

    expect(projections(events)).toEqual([
      "editorial:running",
      "editorial:failed",
      "editorial:running",
      "editorial:failed"
    ]);
  });

  it("the layout migration publishes an apply and a rollback that failed", async () => {
    const events = listen();
    const migration = new ObsidianLayoutMigration({
      getPool: () => null,
      getStorageSettings: async () => settings,
      wiki: {} as never,
      write: vi.fn()
    });

    await expect(migration.apply({})).rejects.toThrow();
    await expect(migration.rollback({})).rejects.toThrow();

    expect(projections(events)).toEqual([
      "layout:running",
      "layout:failed",
      "layout:running",
      "layout:failed"
    ]);
  });

  it("the wiki projection publishes a delivery page that failed", async () => {
    const events = listen();
    const wiki = new ObsidianWikiProjection({
      getPool: () => null,
      getStorageSettings: async () => settings,
      projectSource: vi.fn(),
      write: vi.fn(),
      archive: vi.fn()
    });

    await expect(wiki.execute({ payload: {} } as never)).rejects.toThrow();

    expect(projections(events)).toEqual(["wiki:running", "wiki:failed"]);
  });
});
