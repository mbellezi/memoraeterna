import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertScratchProfilePath,
  copyMigrationsToTag,
  profilePaths,
  startProfileServer,
  truncateJournal,
  writeProfileConnectionFile
} from "./profile-server.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "profile-server-"));
  await mkdir(join(repo, ".cache", "f5", "scratch"), { recursive: true });
  await mkdir(join(repo, ".cache", "profiles", "env-c"), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("assertScratchProfilePath", () => {
  it("accepts existing and not-yet-existing folders under .cache/f<N>/scratch", async () => {
    await mkdir(join(repo, ".cache", "f5", "scratch", "seed30k"));
    await expect(
      assertScratchProfilePath(join(repo, ".cache", "f5", "scratch", "seed30k"), repo)
    ).resolves.toContain("seed30k");
    await expect(
      assertScratchProfilePath(join(repo, ".cache", "f12", "scratch", "gate-m", "env-c"), repo)
    ).resolves.toContain("env-c");
  });

  it("refuses .cache/profiles, the default userData and the scratch root itself", async () => {
    for (const path of [
      join(repo, ".cache", "profiles", "env-c"),
      join(homedir(), "Library", "Application Support", "Memora"),
      join(repo, ".cache", "f5", "scratch"),
      join(repo, ".cache", "f5"),
      join(repo, ".cache", "fx", "scratch", "a"),
      join(repo, "scratch", "a")
    ])
      await expect(assertScratchProfilePath(path, repo)).rejects.toThrow(/Refusing/u);
  });

  it("refuses relative paths and paths that escape with ..", async () => {
    await expect(assertScratchProfilePath(".cache/f5/scratch/a", repo)).rejects.toThrow(
      /Refusing/u
    );
    await expect(
      assertScratchProfilePath(
        join(repo, ".cache", "f5", "scratch", "..", "..", "profiles", "env-c"),
        repo
      )
    ).rejects.toThrow(/Refusing/u);
  });

  it("refuses a symlink inside the scratch root that points at a real profile", async () => {
    const link = join(repo, ".cache", "f5", "scratch", "sneaky");
    await symlink(join(repo, ".cache", "profiles", "env-c"), link);
    await expect(assertScratchProfilePath(link, repo)).rejects.toThrow(/Refusing/u);
  });

  it("startProfileServer refuses a refused path before starting anything", async () => {
    await expect(
      startProfileServer(join(repo, ".cache", "profiles", "env-c"), { repoRoot: repo })
    ).rejects.toThrow(/Refusing/u);
    await expect(
      startProfileServer(join(repo, ".cache", "f5", "scratch", "empty"), { repoRoot: repo })
    ).rejects.toThrow(/no readable database\/dev-connection\.json/u);
  });
});

describe("profile layout", () => {
  it("writes the descriptor with mode 0600 in database/dev-connection.json", async () => {
    const dir = join(repo, ".cache", "f5", "scratch", "p");
    await writeProfileConnectionFile(dir, {
      host: "127.0.0.1",
      port: 5432,
      database: "memora_app",
      user: "memora_app",
      password: "p@ss/word"
    });
    const { connectionFile } = profilePaths(dir);
    expect((await stat(connectionFile)).mode & 0o777).toBe(0o600);
    const body = JSON.parse(await readFile(connectionFile, "utf8")) as { connectionString: string };
    expect(body.connectionString).toContain("p%40ss%2Fword");
  });
});

describe("journal truncation", () => {
  const journal = {
    version: "7",
    entries: [{ tag: "0000_a" }, { tag: "0001_b" }, { tag: "0002_c" }]
  };

  it("keeps entries up to and including the tag", () => {
    expect(truncateJournal(journal, "0001_b").entries.map((entry) => entry.tag)).toEqual([
      "0000_a",
      "0001_b"
    ]);
    expect(truncateJournal(journal, "0002_c").entries).toHaveLength(3);
  });

  it("rejects an unknown tag", () => {
    expect(() => truncateJournal(journal, "0009_x")).toThrow(/Unknown migration tag/u);
  });

  it("copies a drizzle folder with the journal cut and leaves the source alone", async () => {
    const source = join(repo, "drizzle");
    await mkdir(join(source, "meta"), { recursive: true });
    await writeFile(join(source, "0000_a.sql"), "select 1;");
    await writeFile(join(source, "meta", "_journal.json"), JSON.stringify(journal));
    const destination = join(repo, "copy");
    expect(await copyMigrationsToTag(source, destination, "0000_a")).toBe(1);
    const cut = JSON.parse(await readFile(join(destination, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    };
    expect(cut.entries).toHaveLength(1);
    expect(await readFile(join(destination, "0000_a.sql"), "utf8")).toBe("select 1;");
    const original = JSON.parse(await readFile(join(source, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    };
    expect(original.entries).toHaveLength(3);
  });
});
