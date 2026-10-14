import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  buildConnectionString,
  maskConnectionString,
  parseRestoreArgs,
  parseToc,
  readConnection,
  removeScratch,
  resolveBackupSource,
  restoreBackup,
  stopScratch
} from "./backup-restore.js";
import {
  assertSlug,
  binPath,
  createDatabase,
  execSql,
  generatePassword,
  initCluster,
  loopback,
  run,
  scratchDatabase,
  scratchLayout,
  scratchUser,
  startCluster,
  stopCluster,
  type Endpoint
} from "./scratch-cluster.js";

describe("assertSlug", () => {
  it("accepts lowercase slugs and rejects path-like or oversized names", () => {
    expect(assertSlug("owner")).toBe("owner");
    expect(assertSlug("run-2")).toBe("run-2");
    for (const bad of ["", "-x", "Owner", "a/b", "../x", "a b", "x".repeat(41)]) {
      expect(() => assertSlug(bad)).toThrow(/Invalid --name/);
    }
  });
});

describe("parseRestoreArgs", () => {
  it("parses a restore command with flags", () => {
    expect(
      parseRestoreArgs(["--from", "backup", "--name", "owner", "--keep-running", "--force"])
    ).toEqual({ kind: "restore", slug: "owner", from: "backup", keepRunning: true, force: true });
    expect(parseRestoreArgs(["--from", "d.dump", "--name", "x"])).toEqual({
      kind: "restore",
      slug: "x",
      from: "d.dump",
      keepRunning: false,
      force: false
    });
  });

  it("parses stop, remove and help", () => {
    expect(parseRestoreArgs(["--stop", "--name", "owner"])).toEqual({
      kind: "stop",
      slug: "owner"
    });
    expect(parseRestoreArgs(["--remove", "--name", "owner"])).toEqual({
      kind: "remove",
      slug: "owner"
    });
    expect(parseRestoreArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("rejects incomplete or conflicting arguments", () => {
    expect(() => parseRestoreArgs(["--from", "x"])).toThrow(/--name/);
    expect(() => parseRestoreArgs(["--name", "x"])).toThrow(/--from/);
    expect(() => parseRestoreArgs(["--stop", "--remove", "--name", "x"])).toThrow(/cannot be/);
    expect(() => parseRestoreArgs(["--stop", "--name", "x", "--from", "y"])).toThrow(/only accept/);
    expect(() => parseRestoreArgs(["--name", "Bad Slug", "--from", "x"])).toThrow(/Invalid --name/);
    expect(() => parseRestoreArgs(["--bogus"])).toThrow();
    expect(() => parseRestoreArgs(["stray", "--name", "x", "--from", "y"])).toThrow(/Unexpected/);
  });
});

describe("parseToc", () => {
  const listing = [
    ";",
    "; Archive created at 2026-09-10 00:47:01 BST",
    ";     dbname: memora_app",
    ";     TOC Entries: 673",
    ";     Dumped from database version: 18.4",
    ";     Dumped by pg_dump version: 18.4",
    ";",
    "11; 2615 19067 SCHEMA - ag_catalog memora_app",
    "5; 3079 19068 EXTENSION - age ",
    "2; 3079 16769 EXTENSION - vector ",
    "400; 1259 16500 TABLE public chunks memora_app",
    "401; 1259 16510 TABLE public jobs memora_app",
    "5000; 0 16500 TABLE DATA public chunks memora_app",
    "6000; 2606 16520 CONSTRAINT public chunks chunks_pkey memora_app"
  ].join("\n");

  it("reads the header, tables, extensions and schemas", () => {
    const toc = parseToc(listing);
    expect(toc.header).toEqual({
      dbName: "memora_app",
      archiveCreatedAt: "2026-09-10 00:47:01 BST",
      tocEntries: 673,
      dumpedFromVersion: "18.4",
      dumpedByVersion: "18.4"
    });
    expect(toc.tables).toEqual([
      { schema: "public", name: "chunks", hasData: true },
      { schema: "public", name: "jobs", hasData: false }
    ]);
    expect(toc.extensions).toEqual(["age", "vector"]);
    expect(toc.schemas).toEqual(["ag_catalog"]);
  });
});

describe("connection strings", () => {
  it("encodes credentials and masks the password", () => {
    const connection = buildConnectionString({
      host: "127.0.0.1",
      port: 5432,
      database: "memora_app",
      user: "memora_app",
      password: "p@ss/word"
    });
    expect(connection).toBe("postgresql://memora_app:p%40ss%2Fword@127.0.0.1:5432/memora_app");
    expect(maskConnectionString(connection)).toBe(
      "postgresql://memora_app:***@127.0.0.1:5432/memora_app"
    );
  });
});

describe("resolveBackupSource", () => {
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function temp(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "memora-restore-test-"));
    roots.push(root);
    return root;
  }

  it("resolves a backup directory with a manifest and a bare dump file", async () => {
    const root = await temp();
    await writeFile(join(root, "database.dump"), "PGDMP-fake");
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ version: 1, createdAt: "2026-09-09T23:47:01.638Z", included: ["database"] })
    );
    const fromDirectory = await resolveBackupSource(root);
    expect(fromDirectory.dumpPath).toBe(join(root, "database.dump"));
    expect(fromDirectory.manifestCreatedAt).toBe("2026-09-09T23:47:01.638Z");
    const fromFile = await resolveBackupSource(join(root, "database.dump"));
    expect(fromFile.backupDir).toBeNull();
    expect(fromFile.bytes).toBe(10);
  });

  it("rejects missing paths, non-dump files and live data directories", async () => {
    const root = await temp();
    await expect(resolveBackupSource(join(root, "missing"))).rejects.toThrow(/does not exist/);
    await writeFile(join(root, "notes.txt"), "plain text");
    await expect(resolveBackupSource(join(root, "notes.txt"))).rejects.toThrow(/PGDMP/);
    await expect(resolveBackupSource(root)).rejects.toThrow(/No database.dump/);
    const cluster = join(root, "cluster");
    await mkdir(cluster);
    await writeFile(join(cluster, "PG_VERSION"), "18\n");
    await expect(resolveBackupSource(cluster)).rejects.toThrow(/live PostgreSQL data directory/);
  });
});

const sidecarAvailable = existsSync(binPath("postgres")) && existsSync(binPath("pg_dump"));

describe.skipIf(!sidecarAvailable)("restoreBackup against the vendored PostgreSQL sidecar", () => {
  const suffix = `${process.pid}`;
  const sourceSlug = `test-src-${suffix}`;
  const targetSlug = `test-dst-${suffix}`;
  const roots: string[] = [];

  afterAll(async () => {
    await removeScratch(sourceSlug);
    await removeScratch(targetSlug);
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  /** Builds a minimal library (the tables the verification needs) and dumps it like the app does. */
  async function makeBackup(extraSources: number): Promise<string> {
    const layout = scratchLayout(sourceSlug);
    const password = generatePassword();
    await removeScratch(sourceSlug);
    await initCluster(layout, password);
    const port = await startCluster(layout, password);
    const endpoint: Endpoint = {
      host: loopback,
      port,
      user: scratchUser,
      password,
      database: scratchDatabase
    };
    await createDatabase(endpoint, scratchDatabase);
    await execSql(
      endpoint,
      `create extension vector; create extension unaccent; create extension pg_trgm;
       create schema drizzle;
       create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint);
       insert into drizzle.__drizzle_migrations (hash, created_at) values ('h', 1789416041649);
       create table public.source_items (id serial primary key, title text not null);
       insert into public.source_items (title) select 'Source ' || n from generate_series(1, ${2 + extraSources}) n;`
    );
    const root = await mkdtemp(join(tmpdir(), "memora-restore-backup-"));
    roots.push(root);
    await run(
      binPath("pg_dump"),
      [
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        "-h",
        loopback,
        "-p",
        String(port),
        "-U",
        scratchUser,
        "--file",
        join(root, "database.dump"),
        scratchDatabase
      ],
      { env: { ...process.env, PGPASSWORD: password } }
    );
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify({ version: 1, createdAt: new Date().toISOString(), included: ["database"] })
    );
    await stopCluster(layout);
    return root;
  }

  it("restores, verifies, reuses, stops and removes a scratch cluster", async () => {
    const backup = await makeBackup(0);

    const first = await restoreBackup({
      slug: targetSlug,
      from: backup,
      keepRunning: true,
      force: false
    });
    expect(first.reused).toBe(false);
    expect(first.status).toBe("running");
    expect(first.verification.ok).toBe(true);
    expect(first.verification.counts.source_items).toBe(2);
    expect(first.verification.counts.chunks).toBeNull();
    expect(first.verification.migrations.applied).toBe(1);
    expect(first.verification.extensions.map((extension) => extension.name)).toEqual(
      expect.arrayContaining(["vector", "unaccent", "pg_trgm"])
    );
    expect(first.maskedConnectionString).not.toContain(
      (await readConnection(scratchLayout(targetSlug)))?.password ?? "unreachable"
    );
    const mode = (await stat(first.connectionFile)).mode & 0o777;
    expect(mode).toBe(0o600);

    const second = await restoreBackup({
      slug: targetSlug,
      from: join(backup, "database.dump"),
      keepRunning: true,
      force: false
    });
    expect(second.reused).toBe(true);
    expect(second.port).toBe(first.port);

    const stopped = await stopScratch(targetSlug);
    expect(stopped.wasRunning).toBe(true);
    expect((await readConnection(scratchLayout(targetSlug)))?.status).toBe("stopped");

    const restarted = await restoreBackup({
      slug: targetSlug,
      from: backup,
      keepRunning: false,
      force: false
    });
    expect(restarted.reused).toBe(true);
    expect(restarted.status).toBe("stopped");
    expect((await stopScratch(targetSlug)).wasRunning).toBe(false);

    const changed = await makeBackup(3);
    const rebuilt = await restoreBackup({
      slug: targetSlug,
      from: changed,
      keepRunning: false,
      force: false
    });
    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.verification.counts.source_items).toBe(5);

    expect((await removeScratch(targetSlug)).existed).toBe(true);
    expect(existsSync(scratchLayout(targetSlug).root)).toBe(false);
    expect(await readConnection(scratchLayout(targetSlug))).toBeNull();
  }, 180_000);
});
