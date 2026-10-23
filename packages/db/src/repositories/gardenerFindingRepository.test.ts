import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createGardenerFindingRepository } from "./gardenerFindingRepository.js";

/**
 * The findings AUDIT leaves for the owner (F4 T85, D19, D29) on a real PostgreSQL: one row per kind
 * and fingerprint, a finding found again updates its row or reopens a resolved one, and a
 * dismissal persists. The Inbox pages them by risk and age.
 */
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const note = (n: number): string =>
  `memora://note/00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const duplicate = (a: number, b: number, extra: Record<string, unknown> = {}) => ({
  kind: "duplicate" as const,
  fingerprint: `dup:${a}:${b}`,
  objectRefs: [note(a), note(b)],
  params: { reason: "vector", cosine: 0.98, ...extra },
  risk: "low" as const
});

describe.skipIf(!sidecarInstalled)("gardener findings on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const findings = () => createGardenerFindingRepository(pool!);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-gardener-findings-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_gardener_findings",
      user: "memora_gardener_findings",
      password: `gardener-findings-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await pool!.query("delete from gardener_findings");
  });

  it("creates findings, leaves an unchanged one alone and updates a changed one", async () => {
    const first = await findings().record([duplicate(1, 2), duplicate(3, 4)]);
    expect(first).toEqual({ created: 2, reopened: 0, updated: 0, unchanged: 0, dismissed: 0 });
    const before = await pool!.query<{ updated_at: Date }>(
      "select updated_at from gardener_findings where fingerprint = 'dup:1:2'"
    );
    const again = await findings().record([duplicate(1, 2), duplicate(3, 4, { cosine: 0.99 })]);
    expect(again).toEqual({ created: 0, reopened: 0, updated: 1, unchanged: 1, dismissed: 0 });
    const after = await pool!.query<{ fingerprint: string; updated_at: Date; params: unknown }>(
      "select fingerprint, updated_at, params from gardener_findings order by fingerprint"
    );
    // The unchanged finding was not written; the changed one has its new parameters.
    expect(after.rows[0]?.updated_at).toEqual(before.rows[0]?.updated_at);
    expect(after.rows[1]?.params).toMatchObject({ cosine: 0.99 });
  });

  it("counts a finding given twice once, the last one winning, and refuses invalid findings", async () => {
    const result = await findings().record([duplicate(1, 2), duplicate(1, 2, { cosine: 0.97 })]);
    expect(result.created).toBe(1);
    const row = await pool!.query<{ params: { cosine: number } }>(
      "select params from gardener_findings"
    );
    expect(row.rows[0]?.params.cosine).toBe(0.97);
    await expect(
      findings().record([{ ...duplicate(5, 6), kind: "guess" as never }])
    ).rejects.toThrow();
    await expect(
      findings().record([{ ...duplicate(5, 6), params: { nested: { no: true } } as never }])
    ).rejects.toThrow();
    await expect(findings().record([{ ...duplicate(5, 6), fingerprint: "" }])).rejects.toThrow();
    expect(await findings().record([])).toEqual({
      created: 0,
      reopened: 0,
      updated: 0,
      unchanged: 0,
      dismissed: 0
    });
  });

  it("keeps a dismissal when the finding is found again, and reopens a resolved one", async () => {
    await findings().record([duplicate(1, 2), duplicate(3, 4)]);
    const first = (await findings().list()).findings.find(
      (finding) => finding.fingerprint === "dup:1:2"
    );
    const dismissed = await findings().dismiss(first!.id);
    expect(dismissed).toMatchObject({ status: "dismissed" });
    expect(dismissed?.closedAt).toBeInstanceOf(Date);
    expect(await findings().dismiss(first!.id)).toBeNull();
    expect(await findings().resolve("duplicate", ["dup:3:4"])).toBe(1);
    const again = await findings().record([duplicate(1, 2, { cosine: 0.999 }), duplicate(3, 4)]);
    expect(again).toEqual({ created: 0, reopened: 1, updated: 0, unchanged: 0, dismissed: 1 });
    const rows = await pool!.query<{ fingerprint: string; status: string; closed_at: Date | null }>(
      "select fingerprint, status, closed_at from gardener_findings order by fingerprint"
    );
    expect(rows.rows.map((row) => [row.fingerprint, row.status, row.closed_at === null])).toEqual([
      ["dup:1:2", "dismissed", false],
      ["dup:3:4", "open", true]
    ]);
    // The owner can take the dismissal back.
    expect(await findings().reopen(first!.id)).toMatchObject({ status: "open", closedAt: null });
    expect(await findings().reopen(first!.id)).toBeNull();
  });

  it("resolves the open findings a full scan did not find again", async () => {
    await findings().record([
      { ...duplicate(1, 2), kind: "broken_link", fingerprint: "link:a" },
      { ...duplicate(1, 2), kind: "broken_link", fingerprint: "link:b" },
      { ...duplicate(1, 2), kind: "broken_link", fingerprint: "other:c" },
      duplicate(7, 8)
    ]);
    expect(await findings().resolveMissing("broken_link", ["link:a"], { prefix: "link:" })).toBe(1);
    const statuses = await pool!.query<{ fingerprint: string; status: string }>(
      "select fingerprint, status from gardener_findings order by fingerprint"
    );
    expect(statuses.rows).toEqual([
      { fingerprint: "dup:7:8", status: "open" },
      { fingerprint: "link:a", status: "open" },
      { fingerprint: "link:b", status: "resolved" },
      { fingerprint: "other:c", status: "open" }
    ]);
    // Nothing found: everything of the kind is resolved, other kinds are left alone.
    expect(await findings().resolveMissing("broken_link", [])).toBe(2);
    expect(await findings().resolve("duplicate", [])).toBe(0);
    expect((await findings().counts()).duplicate).toBe(1);
  });

  it("pages open findings by risk, then age, and counts them by kind", async () => {
    const make = (n: number, risk: "low" | "medium" | "high") => ({
      ...duplicate(n, n + 1),
      fingerprint: `dup:${n}`,
      risk
    });
    for (const finding of [
      make(1, "low"),
      make(2, "high"),
      make(3, "medium"),
      make(4, "high"),
      make(5, "low")
    ]) {
      await findings().record([finding]);
      await new Promise((done) => setTimeout(done, 5));
    }
    await findings().record([
      { kind: "budget", fingerprint: "month", objectRefs: [], params: { used: 80 }, risk: "medium" }
    ]);
    const all: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page = await findings().list({ after, limit: 2 });
      all.push(...page.findings.map((finding) => finding.fingerprint));
      after = page.next;
      pages += 1;
    } while (after !== null && pages < 10);
    expect(all).toEqual(["dup:2", "dup:4", "dup:3", "month", "dup:1", "dup:5"]);
    expect(pages).toBe(3);
    expect(
      (await findings().list({ kinds: ["budget"] })).findings.map((finding) => finding.fingerprint)
    ).toEqual(["month"]);
    expect(await findings().counts()).toEqual({ duplicate: 5, budget: 1 });
    expect(await findings().counts("dismissed")).toEqual({});
    expect((await findings().list({ limit: 500 })).findings).toHaveLength(6);
    const one = (await findings().list({ limit: 1 })).findings[0];
    expect(await findings().get(one!.id)).toEqual(one);
    expect(await findings().get(randomUUID())).toBeNull();
  });

  it("hands the findings that waited longest to the next check, and touching moves them back", async () => {
    for (const n of [1, 2, 3]) {
      await findings().record([duplicate(n, n + 1)]);
      await new Promise((done) => setTimeout(done, 5));
    }
    const due = await findings().dueForCheck("duplicate", 2);
    expect(due.map((finding) => finding.fingerprint)).toEqual(["dup:1:2", "dup:2:3"]);
    for (const finding of due) {
      expect(await findings().touch([finding.id])).toBe(1);
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(
      (await findings().dueForCheck("duplicate", 3)).map((finding) => finding.fingerprint)
    ).toEqual(["dup:3:4", "dup:1:2", "dup:2:3"]);
    expect(await findings().touch([])).toBe(0);
  });

  it("holds the table's own checks", async () => {
    await expect(
      pool!.query("insert into gardener_findings (kind, fingerprint) values ('guess', 'x')")
    ).rejects.toThrow();
    await expect(
      pool!.query(
        "insert into gardener_findings (kind, fingerprint, status) values ('duplicate', 'x', 'dismissed')"
      )
    ).rejects.toThrow();
  });
});
