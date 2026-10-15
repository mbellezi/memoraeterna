import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  legacyWipeTables,
  type LegacyKeyCounts,
  type LegacyWipeResult,
  type LegacyWipeRun,
  type LegacyWipeState,
  type PgPool
} from "@app/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupVerificationError, backupKeyTables } from "./backup-verifier.js";
import {
  detectLegacyRecreated,
  legacyWipeBackupKeyTables,
  legacyWipeConflictingKnobs,
  LegacyWipeRefusal,
  LegacyWipeService,
  legacyWipeToken,
  readLegacyWipeKnob,
  runLegacyWipeStartup,
  type LegacyWipeBackup,
  type LegacyWipePhase,
  type LegacyWipeServiceOptions
} from "./legacy-wipe-service.js";

const zeroTables = Object.fromEntries(
  legacyWipeTables.map((table) => [table, 0])
) as LegacyWipeState["tables"];

const noKeys: LegacyKeyCounts = {
  settings: {
    "knowledge.automation.policy.v1": 0,
    "knowledge.wiki-areas.v1": 0,
    "organization.active": 0
  },
  scopePageIds: 0,
  jobs: {},
  pagesByManagement: {},
  vaultFiles: {}
};

const legacyKeys: LegacyKeyCounts = {
  settings: {
    "knowledge.automation.policy.v1": 1,
    "knowledge.wiki-areas.v1": 1,
    "organization.active": 1
  },
  scopePageIds: 2,
  jobs: { "maintenance:queued": 1, "organization:succeeded": 4 },
  pagesByManagement: { ai_managed: 9, human_managed: 1 },
  vaultFiles: { "wiki_page:synced": 10 }
};

const library = Object.fromEntries(
  backupKeyTables.filter((table) => table !== "wiki_pages").map((table) => [table, 7])
);

function snapshotCounts(tables: LegacyWipeState["tables"]) {
  return { ...library, ...tables };
}

const legacyTables = { ...zeroTables, wiki_pages: 10, organization_runs: 4, wiki_evidence: 30 };

/** A service whose database, backup and disk are fakes that record every call. */
function harness(options: {
  tables?: LegacyWipeState["tables"];
  keys?: LegacyKeyCounts;
  blockers?: Array<{ fromTable: string; constraint: string; toTable: string }>;
  verifyFails?: boolean;
  wipeResult?: LegacyWipeResult;
  freeBytes?: number;
  afterPhase?: (phase: LegacyWipePhase) => void | Promise<void>;
  backupRoot: string;
}) {
  const events: string[] = [];
  const release = vi.fn(async () => {
    events.push("release");
  });
  const backup: LegacyWipeBackup = {
    openSnapshot: vi.fn(async () => {
      events.push("snapshot");
      return {
        snapshotId: "00000003-0000001B-1",
        counts: snapshotCounts(options.tables ?? legacyTables),
        release
      };
    }),
    createVerified: vi.fn(async (root: string, _snapshot, onDumped: () => Promise<void>) => {
      events.push("dump");
      await onDumped();
      events.push("verify");
      if (options.verifyFails)
        throw new BackupVerificationError("countMismatch", "wiki_pages: snapshot 10, restored 9");
      return { path: join(root, "memora-backup-1"), verifiedAt: "2026-10-15T12:00:05.000Z" };
    })
  };
  const wipe = vi.fn<
    (
      expected: LegacyWipeState,
      run: LegacyWipeRun,
      options: { lockTimeoutMs: number }
    ) => Promise<LegacyWipeResult>
  >(async () => {
    events.push("wipe");
    return options.wipeResult ?? { outcome: "wiped", lockMs: 3, wipeMs: 40 };
  });
  const repository = {
    countKeys: vi.fn(async (snapshotId?: string) => {
      events.push(`keys ${snapshotId}`);
      return { keys: options.keys ?? legacyKeys, databaseBytes: 1_000 };
    }),
    foreignKeysIntoLegacy: vi.fn(async () => options.blockers ?? []),
    wipe
  };
  const logged: string[] = [];
  let tick = Date.parse("2026-10-15T12:00:00.000Z");
  const serviceOptions: LegacyWipeServiceOptions = {
    pool: {} as PgPool,
    backup,
    backupRoot: options.backupRoot,
    logger: { info: (line: string) => logged.push(line) },
    now: () => new Date((tick += 10)),
    freeBytes: async () => options.freeBytes ?? 1_000_000,
    repository,
    afterPhase: async (phase) => {
      events.push(`phase ${phase}`);
      await options.afterPhase?.(phase);
    }
  };
  return {
    service: new LegacyWipeService(serviceOptions),
    backup,
    repository,
    wipe,
    release,
    events,
    logged
  };
}

const stateOf = (tables: LegacyWipeState["tables"], keys: LegacyKeyCounts): LegacyWipeState => ({
  tables,
  keys
});

describe("legacy wipe service", () => {
  let backupRoot = "";
  beforeEach(async () => {
    backupRoot = join(await mkdtemp(join(tmpdir(), "memora-legacy-wipe-")), "backups");
  });
  afterEach(async () => {
    await rm(join(backupRoot, ".."), { recursive: true, force: true });
  });

  it("verifies the backup against the key tables plus every legacy table", () => {
    for (const table of [...backupKeyTables, ...legacyWipeTables])
      expect(legacyWipeBackupKeyTables).toContain(table);
    expect(new Set(legacyWipeBackupKeyTables).size).toBe(legacyWipeBackupKeyTables.length);
  });

  it("derives a short token from every count it guards, independent of key order", () => {
    const state = stateOf(legacyTables, legacyKeys);
    const token = legacyWipeToken(state);
    expect(token).toMatch(/^[0-9a-f]{12}$/);
    const reordered = stateOf(
      Object.fromEntries(Object.entries(legacyTables).reverse()) as LegacyWipeState["tables"],
      { ...legacyKeys, jobs: { "organization:succeeded": 4, "maintenance:queued": 1 } }
    );
    expect(legacyWipeToken(reordered)).toBe(token);
    const variants: LegacyWipeState[] = [
      stateOf({ ...legacyTables, knowledge_impact_events: 1 }, legacyKeys),
      stateOf(legacyTables, {
        ...legacyKeys,
        settings: { ...legacyKeys.settings, "organization.active": 0 }
      }),
      stateOf(legacyTables, { ...legacyKeys, scopePageIds: 1 }),
      stateOf(legacyTables, { ...legacyKeys, jobs: { "organization:succeeded": 4 } }),
      stateOf(legacyTables, { ...legacyKeys, pagesByManagement: { ai_managed: 10 } }),
      stateOf(legacyTables, { ...legacyKeys, vaultFiles: { "wiki_page:retired": 10 } })
    ];
    for (const variant of variants) expect(legacyWipeToken(variant)).not.toBe(token);
  });

  it("previews with a verified backup and the token, and never wipes", async () => {
    const { service, events, wipe, logged } = harness({ backupRoot });
    const report = await service.run({ mode: "preview" });
    expect(report.outcome).toBe("previewed");
    expect(report.token).toBe(legacyWipeToken(stateOf(legacyTables, legacyKeys)));
    expect(report.counts).toEqual(legacyTables);
    expect(report.keyCounts).toEqual(legacyKeys);
    expect(report.library).toEqual(library);
    expect(report.backupPath).toBe(join(backupRoot, "memora-backup-1"));
    expect(report.verifiedAt).toBe("2026-10-15T12:00:05.000Z");
    expect(report.freeBytes).toBe(1_000_000);
    expect(wipe).not.toHaveBeenCalled();
    expect(events).toEqual([
      "snapshot",
      "keys 00000003-0000001B-1",
      "phase counted",
      "dump",
      "release",
      "phase backed_up",
      "verify",
      "phase verified",
      "release"
    ]);
    expect(logged.map((line) => JSON.parse(line.replace("LEGACY_WIPE_PHASE ", "")).phase)).toEqual([
      "counted",
      "backed_up",
      "verified"
    ]);
  });

  it("creates the backup root with owner-only access", async () => {
    const { service } = harness({ backupRoot });
    await service.run({ mode: "preview" });
    expect(await readdir(join(backupRoot, ".."))).toEqual(["backups"]);
  });

  it("wipes with the matching token after the verified backup and records the run", async () => {
    const token = legacyWipeToken(stateOf(legacyTables, legacyKeys));
    const { service, events, wipe } = harness({ backupRoot });
    const report = await service.run({ mode: "wipe", token });
    expect(report.outcome).toBe("wiped");
    expect(report.wipedAt).not.toBeNull();
    expect(report.timings.lockMs).toBe(3);
    expect(report.timings.wipeMs).toBe(40);
    expect(report.timings.totalMs).toBeGreaterThan(0);
    expect(events.slice(-4)).toEqual(["phase verified", "wipe", "phase wiped", "release"]);
    const [expected, run, options] = wipe.mock.calls[0]!;
    expect(expected).toEqual(stateOf(legacyTables, legacyKeys));
    expect(run).toEqual({
      reason: "wiped",
      at: report.wipedAt,
      backupPath: join(backupRoot, "memora-backup-1"),
      verifiedAt: "2026-10-15T12:00:05.000Z",
      counts: stateOf(legacyTables, legacyKeys),
      token
    });
    expect(options.lockTimeoutMs).toBeGreaterThan(0);
  });

  it("aborts before any wipe when the verifier fails", async () => {
    const token = legacyWipeToken(stateOf(legacyTables, legacyKeys));
    const { service, wipe, release } = harness({ backupRoot, verifyFails: true });
    await expect(service.run({ mode: "wipe", token })).rejects.toBeInstanceOf(
      BackupVerificationError
    );
    expect(wipe).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("refuses a token that does not match, before any backup", async () => {
    const { service, backup, wipe, release } = harness({ backupRoot });
    const refusal = await service.run({ mode: "wipe", token: "0123456789ab" }).catch((e) => e);
    expect(refusal).toBeInstanceOf(LegacyWipeRefusal);
    expect(refusal.reason).toBe("tokenMismatch");
    expect(backup.createVerified).not.toHaveBeenCalled();
    expect(wipe).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it("needs no backup and writes nothing when the database has no legacy content", async () => {
    for (const mode of [
      { mode: "preview" } as const,
      { mode: "wipe", token: "0123456789ab" } as const
    ]) {
      const { service, backup, wipe } = harness({
        backupRoot,
        tables: zeroTables,
        keys: { ...noKeys, vaultFiles: { "wiki_page:synced": 4 } }
      });
      const report = await service.run(mode);
      expect(report.outcome).toBe("nothing");
      expect(report.backupPath).toBeNull();
      expect(backup.createVerified).not.toHaveBeenCalled();
      expect(wipe).not.toHaveBeenCalled();
    }
    await expect(readdir(backupRoot)).rejects.toThrow();
  });

  it("refuses to wipe while a foreign key points into a legacy table, but still previews it", async () => {
    const blockers = [
      {
        fromTable: "atomic_note_evolution",
        constraint: "atomic_note_evolution_run_id_organization_runs_id_fk",
        toTable: "organization_runs"
      }
    ];
    const token = legacyWipeToken(stateOf(legacyTables, legacyKeys));
    const blocked = harness({ backupRoot, blockers });
    const refusal = await blocked.service.run({ mode: "wipe", token }).catch((e) => e);
    expect(refusal.reason).toBe("foreignKey");
    expect(refusal.detail).toContain("atomic_note_evolution");
    expect(blocked.backup.createVerified).not.toHaveBeenCalled();
    const preview = await harness({ backupRoot, blockers }).service.run({ mode: "preview" });
    expect(preview.blockers).toEqual([
      "atomic_note_evolution.atomic_note_evolution_run_id_organization_runs_id_fk -> organization_runs"
    ]);
    expect(preview.backupPath).not.toBeNull();
  });

  it("refuses before the backup when the disk has less than three times the database free", async () => {
    const { service, backup } = harness({ backupRoot, freeBytes: 2_999 });
    const refusal = await service.run({ mode: "preview" }).catch((e) => e);
    expect(refusal.reason).toBe("insufficientDisk");
    expect(backup.createVerified).not.toHaveBeenCalled();
  });

  it("refuses when the recount under the locks differs from the snapshot", async () => {
    const token = legacyWipeToken(stateOf(legacyTables, legacyKeys));
    const { service } = harness({
      backupRoot,
      wipeResult: { outcome: "changed", differences: ["wiki_pages: expected 10, found 11"] }
    });
    const refusal = await service.run({ mode: "wipe", token }).catch((e) => e);
    expect(refusal).toBeInstanceOf(LegacyWipeRefusal);
    expect(refusal.reason).toBe("countsChanged");
    expect(refusal.detail).toContain("wiki_pages: expected 10, found 11");
  });

  it("never reaches the wipe when the run dies after counted, backed_up or verified", async () => {
    const token = legacyWipeToken(stateOf(legacyTables, legacyKeys));
    for (const killAfter of ["counted", "backed_up", "verified"] as const) {
      const { service, wipe, release } = harness({
        backupRoot,
        afterPhase: (phase) => {
          if (phase === killAfter) throw new Error(`killed after ${phase}`);
        }
      });
      await expect(service.run({ mode: "wipe", token })).rejects.toThrow(
        `killed after ${killAfter}`
      );
      expect(wipe).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
    }
  });
});

describe("MEMORA_LEGACY_WIPE", () => {
  const dev = { isPackaged: false };

  it("is off when unset or blank", () => {
    expect(readLegacyWipeKnob({}, dev)).toBeNull();
    expect(readLegacyWipeKnob({ MEMORA_LEGACY_WIPE: "  " }, dev)).toBeNull();
  });

  it("takes preview or a 12-character token", () => {
    expect(readLegacyWipeKnob({ MEMORA_LEGACY_WIPE: "preview" }, dev)).toEqual({ mode: "preview" });
    expect(readLegacyWipeKnob({ MEMORA_LEGACY_WIPE: " 0123456789ab " }, dev)).toEqual({
      mode: "wipe",
      token: "0123456789ab"
    });
    for (const value of ["yes", "10", "0123456789AB", "0123456789abc"])
      expect(() => readLegacyWipeKnob({ MEMORA_LEGACY_WIPE: value }, dev)).toThrow("invalidValue");
  });

  it("is refused in packaged builds", () => {
    expect(() =>
      readLegacyWipeKnob({ MEMORA_LEGACY_WIPE: "preview" }, { isPackaged: true })
    ).toThrow("packaged");
  });

  it("is refused beside any other DEV knob", () => {
    expect(legacyWipeConflictingKnobs).toEqual(
      expect.arrayContaining([
        "MEMORA_GOLDEN_RUN",
        "MEMORA_GOLDEN_SOURCE_PAIRS",
        "MEMORA_GOLDEN_RESET",
        "MEMORA_MATCHING_PILOT",
        "MEMORA_PROFILE_RESET"
      ])
    );
    for (const knob of legacyWipeConflictingKnobs) {
      const refusal = (() => {
        try {
          return readLegacyWipeKnob({ MEMORA_LEGACY_WIPE: "preview", [knob]: "1" }, dev);
        } catch (error) {
          return error;
        }
      })();
      expect(refusal).toBeInstanceOf(LegacyWipeRefusal);
      expect((refusal as LegacyWipeRefusal).reason).toBe("conflictingKnob");
      expect((refusal as LegacyWipeRefusal).detail).toContain(knob);
    }
  });
});

/** A pool that answers the detector's two reads. */
function detectorPool(record: unknown, wikiPages: number) {
  const query = vi.fn(async (text: string) => {
    if (text.includes("from settings where key = $1"))
      return { rows: record === null ? [] : [{ value: record }] };
    return {
      rows: [
        {
          wiki_pages: wikiPages,
          organization_runs: 0,
          organization_settings_revisions: 0,
          maintenance_runs: 0,
          maintenance_schedules: 0,
          wiki_policy_revisions: 0,
          wiki_investigations: 0
        }
      ]
    };
  });
  return { pool: { query } as unknown as PgPool, query };
}

const wipeRecord = {
  runs: [
    {
      reason: "wiped",
      at: "2026-10-15T12:00:00.000Z",
      backupPath: "/b",
      verifiedAt: "2026-10-15T11:59:00.000Z",
      counts: stateOf(legacyTables, legacyKeys),
      token: "0123456789ab"
    }
  ]
};

describe("legacy wipe startup", () => {
  it("logs LEGACY_RECREATED only when a wiped database holds legacy content again", async () => {
    const warn = vi.fn();
    expect(await detectLegacyRecreated(detectorPool(null, 3).pool, { warn })).toBeNull();
    expect(await detectLegacyRecreated(detectorPool(wipeRecord, 0).pool, { warn })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    const counts = await detectLegacyRecreated(detectorPool(wipeRecord, 9).pool, { warn });
    expect(counts?.wiki_pages).toBe(9);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toMatch(
      /^LEGACY_RECREATED \{"counts":\{.*"wiki_pages":9/
    );
  });

  const startup = (env: NodeJS.ProcessEnv, isPackaged = false) => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { pool } = detectorPool(null, 0);
    return {
      logger,
      result: runLegacyWipeStartup({
        env,
        isPackaged,
        pool,
        workspaceRoot: "/nonexistent",
        getDatabaseContext: () => null,
        getStorageSettings: async () => {
          throw new Error("not used");
        },
        logger
      })
    };
  };

  it("continues a normal start when the knob is unset", async () => {
    const { result, logger } = startup({});
    expect(await result).toBe("continue");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("quits and logs the reason when the knob is refused", async () => {
    for (const [env, isPackaged, reason] of [
      [{ MEMORA_LEGACY_WIPE: "preview" }, true, "packaged"],
      [{ MEMORA_LEGACY_WIPE: "preview", MEMORA_GOLDEN_RUN: "m.json" }, false, "conflictingKnob"],
      [{ MEMORA_LEGACY_WIPE: "10" }, false, "invalidValue"]
    ] as const) {
      const { result, logger } = startup(env, isPackaged);
      expect(await result).toBe("quit");
      expect(String(logger.error.mock.calls[0]![0])).toContain(`LEGACY_WIPE refused: ${reason}`);
    }
  });

  it("quits and logs the reason when the wipe cannot run", async () => {
    const { result, logger } = startup({ MEMORA_LEGACY_WIPE: "preview" });
    expect(await result).toBe("quit");
    expect(String(logger.error.mock.calls[0]![0])).toMatch(/^LEGACY_WIPE refused: /);
  });
});
