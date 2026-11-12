import { createTranslator } from "@app/i18n";
import { describe, expect, it } from "vitest";

import type { ObsidianSyncStatus } from "../../../../shared/ipc";
import {
  attachmentsOn,
  bookModeOfValue,
  formatWhen,
  gatewayMeta,
  layoutSettled,
  layoutStep,
  migrationIsOpen,
  sourcesText,
  syncLine,
  syncModeOfValue,
  type LayoutMigration
} from "./integrations-model";

const en = createTranslator("en");
const now = new Date(2026, 10, 12, 15, 0, 0);
const sync = (patch: Partial<ObsidianSyncStatus>): ObsidianSyncStatus => ({
  state: "completed",
  stage: "completed",
  progress: 1,
  processed: 0,
  total: 0,
  synced: 0,
  conflicts: 0,
  projected: 0,
  startedAt: null,
  finishedAt: new Date(2026, 10, 12, 9, 12).toISOString(),
  error: null,
  ...patch
});

describe("the words of a value", () => {
  it("reads what describe answers, and falls back to the safe choice", () => {
    expect(syncModeOfValue("on")).toBe("on");
    expect(syncModeOfValue("paused")).toBe("paused");
    expect(syncModeOfValue(null)).toBe("off");
    expect(bookModeOfValue("google-books")).toBe("google-books");
    expect(bookModeOfValue(undefined)).toBe("auto");
  });

  it("says how many sources are chosen, and that none chosen means all", () => {
    expect(sourcesText(en, 0)).toBe("All sources");
    expect(sourcesText(en, 1)).toBe("1 source chosen");
    expect(sourcesText(en, 2)).toBe("2 sources chosen");
  });

  it("says when: today, yesterday, or the date", () => {
    expect(formatWhen(en, "en", new Date(2026, 10, 12, 9, 12).toISOString(), now)).toMatch(
      /^today, 09:12/
    );
    expect(formatWhen(en, "en", new Date(2026, 10, 11, 22, 14).toISOString(), now)).toMatch(
      /^yesterday, 10:14/
    );
    expect(formatWhen(en, "en", new Date(2026, 10, 3, 8, 0).toISOString(), now)).toMatch(
      /^Nov 3, 08:00/
    );
  });
});

describe("the line under the sync", () => {
  it("is nothing while the sync is off and a note while it is paused", () => {
    expect(syncLine(en, "off", sync({}), now)).toBeNull();
    expect(syncLine(en, "paused", sync({}), now)).toMatchObject({ tone: "idle", canRun: false });
  });

  it("shows the progress of a run, and no way to start another", () => {
    expect(
      syncLine(en, "on", sync({ state: "running", stage: "projecting", progress: 0.5 }), now)
    ).toMatchObject({
      tone: "working",
      canRun: false,
      progress: 0.5
    });
  });

  it("says when it last finished with the conflicts, warns on conflicts or a failure", () => {
    const done = syncLine(en, "on", sync({}), now);
    expect(done).toMatchObject({ tone: "ok", canRun: true });
    expect(done?.text).toContain("Synced today, 09:12");
    expect(done?.text).toContain("0 conflicts");
    expect(syncLine(en, "on", sync({ conflicts: 2 }), now)?.tone).toBe("warn");
    expect(syncLine(en, "on", sync({ state: "failed" }), now)).toMatchObject({
      tone: "warn",
      canRun: true
    });
    expect(syncLine(en, "on", sync({ state: "idle", finishedAt: null }), now)?.text).toBe(
      "It has not synced yet."
    );
  });
});

const migration = (
  status: string,
  attachments: "omit" | "copy",
  targets: LayoutMigration["targets"] = []
) =>
  ({
    id: "m",
    status,
    createdAt: "",
    config: { version: 2, language: "en", attachments },
    targets
  }) as LayoutMigration;

describe("the layout migration behind 'copy the original files'", () => {
  const status = (latest?: LayoutMigration, applied: "omit" | "copy" = "omit") =>
    ({
      config: { version: 2, language: "en", attachments: applied },
      migrations: latest ? [latest] : []
    }) as never;

  it("reads the switch as what was asked while a change waits, and as what is applied after", () => {
    expect(attachmentsOn(status(), false)).toBe(false);
    expect(attachmentsOn(status(migration("preview", "copy")), false)).toBe(true);
    expect(attachmentsOn(status(migration("completed", "copy"), "copy"), false)).toBe(true);
    expect(attachmentsOn(status(migration("rolling_back", "copy"), "copy"), false)).toBe(true);
    expect(attachmentsOn(null, true)).toBe(true);
  });

  it("knows which migrations still need a step, and names the step", () => {
    expect(migrationIsOpen(migration("preview", "copy"))).toBe(true);
    expect(migrationIsOpen(migration("completed", "copy"))).toBe(false);
    expect(migrationIsOpen(undefined)).toBe(false);
    expect(layoutStep(migration("preview", "copy"))).toBe("review");
    expect(layoutStep(migration("quiescing", "copy"))).toBe("waiting");
    expect(layoutStep(migration("partial", "copy"))).toBe("partial");
    expect(layoutStep(migration("rolled_back", "omit"))).toBe("rolledBack");
  });

  it("counts the files that are done, or rolled back during a rollback, and the excluded ones", () => {
    const row = (status: string) => ({ status }) as LayoutMigration["targets"][number];
    expect(
      layoutSettled(migration("applying", "copy", [row("done"), row("planned"), row("excluded")]))
    ).toBe(2);
    expect(
      layoutSettled(migration("rolling_back", "copy", [row("done"), row("rolled_back")]))
    ).toBe(1);
  });
});

describe("the gateway's summary", () => {
  const gateway = {
    state: "ready",
    host: "127.0.0.1",
    port: 1,
    baseUrl: "http://127.0.0.1:1"
  } as const;
  const client = (status: string) => ({ status }) as never;
  it("counts the paired apps and says the state, and is nothing until both are read", () => {
    expect(gatewayMeta(en, null, [])).toBeNull();
    expect(gatewayMeta(en, gateway, null)).toBeNull();
    expect(gatewayMeta(en, gateway, [client("paired"), client("revoked")])).toBe("1 app · ready");
    expect(gatewayMeta(en, gateway, [client("paired"), client("paired")])).toBe("2 apps · ready");
    expect(gatewayMeta(en, gateway, [])).toBe("0 apps · ready");
  });
});
