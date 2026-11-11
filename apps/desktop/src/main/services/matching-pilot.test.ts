import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMatchingPilotComplete, runMatchingPilot } from "./matching-pilot.js";

describe("DEV pilot completion", () => {
  it("waits for deferred matching even after ingestion jobs succeed", () => {
    expect(
      isMatchingPilotComplete([
        {
          status: "succeeded",
          stages_checkpoint: { sourceMatching: { status: "waiting_for_batch" } }
        }
      ])
    ).toBe(false);
    expect(
      isMatchingPilotComplete([
        { status: "succeeded", stages_checkpoint: { atomicNoteMatching: { status: "running" } } }
      ])
    ).toBe(false);
  });
  it("recognizes terminal stages and failures without treating an empty batch as complete", () => {
    expect(isMatchingPilotComplete([])).toBe(false);
    expect(isMatchingPilotComplete([{ status: "failed", job_status: "queued" }])).toBe(false);
    expect(
      isMatchingPilotComplete([
        {
          status: "succeeded",
          stages_checkpoint: {
            atomicNoteMatching: { status: "completed" },
            sourceMatching: { status: "completed" }
          }
        }
      ])
    ).toBe(true);
    expect(isMatchingPilotComplete([{ status: "failed" }, { status: "running" }])).toBe(false);
    expect(isMatchingPilotComplete([{ status: "failed" }, { status: "canceled" }])).toBe(true);
  });
});

describe("pilot scratch-profile mode", () => {
  let workspace: string;
  let outside: string;
  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "memora-pilot-workspace-"));
    outside = await mkdtemp(join(tmpdir(), "memora-pilot-outside-"));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const run = (userDataPath: string, mode: string, pool: unknown) =>
    runMatchingPilot({
      mode,
      isPackaged: false,
      userDataPath,
      workspaceRoot: workspace,
      pool: pool as never,
      ingestion: {} as never,
      hierarchy: {} as never,
      settings: {} as never,
      jobs: {} as never,
      backup: {} as never
    });

  it("refuses a non-scratch userData before any read or write", async () => {
    // A pool that fails the test on any use: the refusal comes before the database is touched.
    const untouched = {
      query: () => {
        throw new Error("the pool must not be used");
      }
    };
    const owner = join(outside, "@app", "desktop");
    await mkdir(join(owner, "database"), { recursive: true });
    await writeFile(
      join(owner, "database", "dev-connection.json"),
      JSON.stringify({ developmentOnly: true })
    );
    const sibling = join(workspace, ".cache", "other");
    await mkdir(sibling, { recursive: true });
    const scratchRoot = join(workspace, ".cache", "f5", "scratch");
    await mkdir(scratchRoot, { recursive: true });
    for (const path of [owner, sibling, "relative/path", scratchRoot])
      for (const mode of ["inspect", "prepare", "run", "report", "rematch"])
        await expect(run(path, mode, untouched)).rejects.toThrow(
          "matching.errors.notScratchProfile"
        );
    expect(await readdir(owner)).toEqual(["database"]);
    expect(await readdir(sibling)).toEqual([]);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it("inspect on a scratch profile writes preflight.json and nothing else", async () => {
    const profile = join(workspace, ".cache", "f5", "scratch", "pilot");
    await mkdir(join(profile, "database"), { recursive: true });
    await writeFile(
      join(profile, "database", "dev-connection.json"),
      JSON.stringify({
        developmentOnly: true,
        connectionString: "postgresql://u:hidden-pw@127.0.0.1/x"
      })
    );
    const counts = { database: "memora", sources: 0, notes: 0, source_relations: 0, profiles: 1 };
    const pool = { query: async () => ({ rows: [counts] }) };
    const logged: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    try {
      await run(profile, "inspect", pool);
    } finally {
      log.mockRestore();
    }
    expect(await readdir(join(profile, "matching-pilot"))).toEqual(["preflight.json"]);
    const written = JSON.parse(
      await readFile(join(profile, "matching-pilot", "preflight.json"), "utf8")
    );
    expect(written).toMatchObject(counts);
    expect(logged.join("\n")).toContain('"event":"preflight"');
    // The connection descriptor is never printed or copied.
    expect(logged.join("\n")).not.toContain("hidden-pw");
    expect(JSON.stringify(written)).not.toContain("hidden-pw");
    // The repository's own .cache/matching-pilot is not created.
    expect(await readdir(join(workspace, ".cache"))).toEqual(["f5"]);
  });
});
