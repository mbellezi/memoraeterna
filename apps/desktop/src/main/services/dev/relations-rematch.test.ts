import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PgPool } from "@app/db";

import { contentDigest } from "../golden-runner.js";
import { relationLinkRuntime, resetRelationLinkRuntime } from "../relations/link-runtime.js";
import {
  planRematch,
  prepareRelationsRematch,
  readPartitionMapping,
  readProfileRecord,
  readRematchEnvironment,
  readRootsSelection,
  RematchRefusal,
  rematchConflictingKnobs,
  resolveExpectedDigest,
  verifyPinnedDigest,
  writeRematchSummary,
  type PrepareRematchOptions
} from "./relations-rematch.js";
import { createRematchJobSlot, rematchJobType } from "./relations-rematch-slot.js";
import { contentDigest as rematchDigest } from "./relations-rematch-state.js";

// The queue the started job goes through, standing in for the jobs table.
const queue = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  statuses: [] as string[]
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => ({
    create: async (input: Record<string, unknown>) => {
      queue.created.push(input);
      return { id: "job-1" };
    },
    findById: async () => ({
      id: "job-1",
      status: queue.statuses.shift() ?? "succeeded",
      error: null
    })
  })
}));

let workspace = "";
let userData = "";
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-rematch-"));
  userData = join(workspace, ".cache", "profiles", "env-f-s0");
  await mkdir(join(userData, "database"), { recursive: true });
  await writeFile(
    join(userData, "database", "dev-connection.json"),
    JSON.stringify({ developmentOnly: true })
  );
  await writeFile(
    join(userData, "profile.json"),
    JSON.stringify({ kind: "env-f", name: "env-f-s0" })
  );
  queue.created.length = 0;
  queue.statuses.length = 0;
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  resetRelationLinkRuntime();
});

const base = { isPackaged: false, workspaceRoot: "/repo" };
const knob = { MEMORA_RELATIONS_REMATCH: "arrival:20261031" };

describe("the re-match knobs", () => {
  it("do nothing unless MEMORA_RELATIONS_REMATCH is set", () => {
    expect(readRematchEnvironment({}, base)).toBeNull();
    expect(readRematchEnvironment({ MEMORA_RELATIONS_REMATCH: "  " }, base)).toBeNull();
    // An unrelated variable of the same family does not start a run.
    expect(
      readRematchEnvironment({ MEMORA_RELATIONS_REMATCH_BACKGROUND: "matched" }, base)
    ).toBeNull();
  });

  it("are refused in a packaged build", () => {
    expect(() => readRematchEnvironment(knob, { ...base, isPackaged: true })).toThrow(
      expect.objectContaining({ code: "packaged" })
    );
  });

  it("are refused beside MEMORA_GOLDEN_RUN and every other DEV measurement knob", () => {
    expect(rematchConflictingKnobs).toContain("MEMORA_GOLDEN_RUN");
    for (const name of rematchConflictingKnobs)
      expect(() => readRematchEnvironment({ ...knob, [name]: "1" }, base), name).toThrow(
        expect.objectContaining({ code: "conflictingKnob", message: expect.stringContaining(name) })
      );
    expect(() => readRematchEnvironment({ ...knob, MEMORA_GOLDEN_RUN: " " }, base)).not.toThrow();
  });

  it("read the mode, the files, the background, the digest and the caps", () => {
    const environment = readRematchEnvironment(
      {
        MEMORA_RELATIONS_REMATCH: "burst",
        MEMORA_RELATIONS_REMATCH_MAPPING: ".cache/golden/matching-fixture/mapping.json",
        MEMORA_RELATIONS_REMATCH_ROOTS: ".cache/f3/roots.json",
        MEMORA_RELATIONS_REMATCH_BACKGROUND: "matched",
        MEMORA_RELATIONS_REMATCH_DIGEST: `${"b".repeat(64)}:138`,
        MEMORA_RELATIONS_REMATCH_OUT: ".cache/f3/rematch/x",
        MEMORA_RELATIONS_REMATCH_DRAIN_MS: "60000",
        MEMORA_GOLDEN_MAX_TOKENS: "50000"
      },
      base
    );
    expect(environment).toEqual({
      mode: { kind: "burst" },
      mappingPath: "/repo/.cache/golden/matching-fixture/mapping.json",
      rootsPath: "/repo/.cache/f3/roots.json",
      background: "matched",
      discovery: "on",
      candidates: "off",
      digestOverride: { sha256: "b".repeat(64), notes: 138 },
      outDirectory: "/repo/.cache/f3/rematch/x",
      drainTimeoutMs: 60_000,
      maxLiveTokens: 50_000
    });
    expect(readRematchEnvironment(knob, base)).toMatchObject({
      mode: { kind: "arrival", order: { kind: "seeded", seed: 20261031 } },
      background: "none",
      digestOverride: null,
      outDirectory: null,
      maxLiveTokens: null
    });
  });

  it("read the discovery and candidate-list knobs of T57's M1", () => {
    expect(readRematchEnvironment(knob, base)).toMatchObject({
      discovery: "on",
      candidates: "off"
    });
    expect(
      readRematchEnvironment(
        {
          ...knob,
          MEMORA_RELATIONS_REMATCH_DISCOVERY: "off",
          MEMORA_RELATIONS_REMATCH_CANDIDATES: "record"
        },
        base
      )
    ).toMatchObject({ discovery: "off", candidates: "record" });
  });

  it("refuse a value they cannot read", () => {
    for (const extra of [
      { MEMORA_RELATIONS_REMATCH_DISCOVERY: "maybe" },
      { MEMORA_RELATIONS_REMATCH_CANDIDATES: "all" },
      { MEMORA_RELATIONS_REMATCH: "arrival:soon" },
      { MEMORA_RELATIONS_REMATCH_BACKGROUND: "some" },
      { MEMORA_RELATIONS_REMATCH_DIGEST: "abc:12" },
      { MEMORA_RELATIONS_REMATCH_OUT: "/tmp/elsewhere" },
      { MEMORA_RELATIONS_REMATCH_OUT: "src/out" },
      { MEMORA_RELATIONS_REMATCH_DRAIN_MS: "0" },
      { MEMORA_GOLDEN_MAX_TOKENS: "many" }
    ])
      expect(
        () => readRematchEnvironment({ ...knob, ...extra }, base),
        JSON.stringify(extra)
      ).toThrow(expect.objectContaining({ code: "invalidValue" }));
  });
});

describe("the pinned notes digest", () => {
  const lines = ["Book / Chapter|Note|abc|active", "Paper|Other|def|active"];
  const digest = rematchDigest(lines);

  it("is the golden runner's digest of the same lines", () => {
    expect(digest.notes).toBe(2);
    expect(digest.sha256).toBe(contentDigest(lines).sha256);
    expect(rematchDigest([...lines].reverse())).toEqual(digest);
    expect(rematchDigest([...lines, "Third|Note|ghi|active"]).sha256).not.toBe(digest.sha256);
  });

  it("is checked against the profile kind's entry, or the override", async () => {
    await mkdir(join(workspace, ".cache", "f3", "m0"), { recursive: true });
    await writeFile(
      join(workspace, ".cache", "f3", "m0", "digests.json"),
      JSON.stringify({
        format: "t44-profile-digests",
        "env-f": { notes: 138, sha256: "c".repeat(64) }
      })
    );
    const from = (input: { override?: typeof digest | null; kind: string | null }) =>
      resolveExpectedDigest({ override: null, workspaceRoot: workspace, ...input });
    await expect(from({ kind: "env-f" })).resolves.toEqual({ notes: 138, sha256: "c".repeat(64) });
    await expect(from({ kind: "env-f", override: digest })).resolves.toEqual(digest);
    await expect(from({ kind: "env-g" })).rejects.toThrow(
      expect.objectContaining({ code: "digestUnknown" })
    );
    await expect(from({ kind: null })).rejects.toThrow(
      expect.objectContaining({ code: "digestUnknown" })
    );
  });

  it("fails on a different note set", () => {
    expect(() => verifyPinnedDigest(digest, digest)).not.toThrow();
    expect(() => verifyPinnedDigest({ ...digest, notes: 3 }, digest)).toThrow(
      expect.objectContaining({
        code: "digestMismatch",
        message: expect.stringContaining("3 notes")
      })
    );
    expect(() => verifyPinnedDigest({ ...digest, sha256: "d".repeat(64) }, digest)).toThrow(
      expect.objectContaining({ code: "digestMismatch" })
    );
  });
});

describe("the files of a run", () => {
  it("reads the profile record, with the folder's name when it has none", async () => {
    await expect(readProfileRecord(userData)).resolves.toEqual({ name: "env-f-s0", kind: "env-f" });
    await expect(readProfileRecord(join(workspace, "nowhere"))).resolves.toEqual({
      name: "nowhere",
      kind: null
    });
  });

  it("reads the partitions of a fixture mapping and a list of roots", async () => {
    const mapping = join(workspace, "mapping.json");
    await writeFile(
      mapping,
      JSON.stringify({
        roots: [
          { id: "P01", title: "Alpha", partition: "tuning", records: [] },
          { id: "P02", title: " Beta ", partition: "holdout" }
        ]
      })
    );
    expect([...(await readPartitionMapping(mapping))]).toEqual([
      ["Alpha", "tuning"],
      ["Beta", "holdout"]
    ]);
    const roots = join(workspace, "roots.json");
    await writeFile(roots, JSON.stringify({ roots: ["Alpha", " Beta"] }));
    await expect(readRootsSelection(roots)).resolves.toEqual(["Alpha", "Beta"]);
    await writeFile(roots, JSON.stringify(["Gamma"]));
    await expect(readRootsSelection(roots)).resolves.toEqual(["Gamma"]);
    await writeFile(roots, JSON.stringify([]));
    await expect(readRootsSelection(roots)).rejects.toThrow();
  });

  it("needs the fixture mapping on an ENV-F profile, so S0 keeps tuning roots first", async () => {
    const environment = readRematchEnvironment(knob, { ...base, workspaceRoot: workspace })!;
    const library = [{ id: "a", title: "Alpha", records: [], notes: 1 }];
    await expect(
      planRematch({ environment, library, profileKind: "env-f", workspaceRoot: workspace })
    ).rejects.toThrow(expect.objectContaining({ code: "mappingRequired" }));
    // Another profile has no partitions.
    const plan = await planRematch({
      environment,
      library,
      profileKind: "env-g",
      workspaceRoot: workspace
    });
    expect(plan.order.map((root) => root.partition)).toEqual([null]);
  });

  it("writes the summary under .cache/f3/rematch/<run>/", async () => {
    const summary = { runId: "2026-10-17T10-00-00-000Z" } as never;
    const path = await writeRematchSummary(workspace, { outDirectory: null }, summary);
    expect(path).toBe(
      join(workspace, ".cache", "f3", "rematch", "2026-10-17T10-00-00-000Z", "summary.json")
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(summary);
    const custom = await writeRematchSummary(
      workspace,
      { outDirectory: join(workspace, ".cache", "x") },
      summary
    );
    expect(custom).toBe(join(workspace, ".cache", "x", "summary.json"));
  });
});

const cassetteStats = (mode: "record" | "replay") => ({
  mode,
  directory: "d",
  served: 0,
  recorded: 0,
  misses: 0,
  liveTokens: 0,
  maxLiveTokens: null,
  byTask: {},
  missDetails: []
});

describe("preparing a run", () => {
  const noteLines = ["Alpha|Note A|aa|active", "Alpha|Note B|bb|active", "Beta|Note C|cc|active"];
  const rootRows = [
    { rootId: "root-a", rootTitle: "Alpha", recordId: "root-a", recordTitle: "Alpha", notes: 2 },
    { rootId: "root-b", rootTitle: "Beta", recordId: "root-b", recordTitle: "Beta", notes: 1 }
  ];

  async function pinFixture(lines: readonly string[] = noteLines) {
    await mkdir(join(workspace, ".cache", "f3", "m0"), { recursive: true });
    const { notes, sha256 } = rematchDigest(lines);
    await writeFile(
      join(workspace, ".cache", "f3", "m0", "digests.json"),
      JSON.stringify({ "env-f": { notes, sha256 } })
    );
    await mkdir(join(workspace, ".cache", "golden", "matching-fixture"), { recursive: true });
    await writeFile(
      join(workspace, ".cache", "golden", "matching-fixture", "mapping.json"),
      JSON.stringify({
        roots: [
          { title: "Alpha", partition: "tuning" },
          { title: "Beta", partition: "holdout" }
        ]
      })
    );
  }

  function options(extra: Partial<PrepareRematchOptions> = {}, libraryLines = noteLines) {
    const statements: string[] = [];
    const pool = {
      query: async (text: string) => {
        statements.push(text.replace(/\s+/gu, " ").trim().slice(0, 40));
        if (text.includes("md5(")) return { rows: libraryLines.map((line) => ({ line })) };
        if (text.includes("with recursive tree(root_id")) return { rows: rootRows };
        throw new Error(`unexpected statement: ${text.slice(0, 60)}`);
      }
    } as unknown as PgPool;
    const slot = createRematchJobSlot();
    const quit = vi.fn();
    const wake = vi.fn();
    const limitLiveTokens = vi.fn();
    const stats = vi.fn(() => cassetteStats("replay"));
    const prepared: PrepareRematchOptions = {
      env: { ...knob },
      isPackaged: false,
      userDataPath: userData,
      workspaceRoot: workspace,
      pool,
      cassette: { stats, limitLiveTokens } as never,
      knowledge: {} as never,
      jobs: { wake },
      slot,
      quit,
      logger: { info: vi.fn(), error: vi.fn() },
      sleep: async () => undefined,
      pollMs: 1,
      ...extra
    };
    return { prepared, statements, slot, quit, wake, limitLiveTokens, stats };
  }

  it("plans the roots of a pinned library without writing anything", async () => {
    await pinFixture();
    const { prepared, statements, slot } = options();
    resetRelationLinkRuntime();
    const run = await prepareRelationsRematch(prepared);
    expect(run.plan.order.map((root) => [root.title, root.partition])).toEqual([
      ["Alpha", "tuning"],
      ["Beta", "holdout"]
    ]);
    // Its link jobs drain one at a time in arrival order, as in a golden run (D24), discovering
    // unless the run says otherwise.
    expect(relationLinkRuntime().drain).toBe(true);
    expect(relationLinkRuntime().discoveryOff).toBe(false);
    expect(
      statements.every(
        (statement) => statement.startsWith("select") || statement.startsWith("with")
      )
    ).toBe(true);
    // The supervisor's registry now reaches the harness: the run starts, and with no decider to
    // ask it ends failed, with a summary, before it cleared anything.
    const result = await slot.registry[rematchJobType]!.execute(
      { id: "job-1" } as never,
      new AbortController().signal
    );
    expect(result).toMatchObject({ outcome: "failed" });
    expect(statements.some((statement) => statement.startsWith("delete"))).toBe(false);
  });

  it("leaves the job unbound when it refuses, so a claim fails", async () => {
    await pinFixture();
    const { prepared, slot } = options({ env: { ...knob, MEMORA_GOLDEN_RUN: "m.json" } });
    await expect(prepareRelationsRematch(prepared)).rejects.toThrow(RematchRefusal);
    await expect(
      slot.registry[rematchJobType]!.execute({ id: "job-1" } as never, new AbortController().signal)
    ).rejects.toThrow("not prepared");
  });

  it("refuses a library whose notes are not the pinned ones, before it plans or writes", async () => {
    await pinFixture();
    const { prepared, statements } = options({}, [
      ...noteLines.slice(0, 2),
      "Beta|Note C|XX|active"
    ]);
    await expect(prepareRelationsRematch(prepared)).rejects.toThrow(
      expect.objectContaining({ code: "digestMismatch" })
    );
    expect(statements).toHaveLength(1);
  });

  it("refuses a profile outside .cache/profiles/", async () => {
    await pinFixture();
    const outside = await mkdtemp(join(tmpdir(), "memora-rematch-outside-"));
    try {
      await mkdir(join(outside, "database"), { recursive: true });
      await writeFile(
        join(outside, "database", "dev-connection.json"),
        JSON.stringify({ developmentOnly: true })
      );
      const { prepared, statements } = options({ userDataPath: outside });
      await expect(prepareRelationsRematch(prepared)).rejects.toThrow(
        expect.objectContaining({ code: "outsideProfiles" })
      );
      expect(statements).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a profile that is not a DEV database, a missing cassette and an unbounded recording", async () => {
    await pinFixture();
    await rm(join(userData, "database", "dev-connection.json"));
    await expect(prepareRelationsRematch(options().prepared)).rejects.toThrow(
      expect.objectContaining({ code: "notDevelopmentDatabase" })
    );
    await writeFile(
      join(userData, "database", "dev-connection.json"),
      JSON.stringify({ developmentOnly: true })
    );
    await expect(prepareRelationsRematch(options({ cassette: null }).prepared)).rejects.toThrow(
      expect.objectContaining({ code: "cassetteRequired" })
    );
    const recording = options({}).prepared;
    (recording.cassette!.stats as ReturnType<typeof vi.fn>).mockReturnValue(
      cassetteStats("record")
    );
    await expect(prepareRelationsRematch(recording)).rejects.toThrow(
      expect.objectContaining({ code: "tokenCapRequired" })
    );
  });

  it("caps the live tokens of a recording", async () => {
    await pinFixture();
    const { prepared, stats, limitLiveTokens } = options({
      env: { ...knob, MEMORA_GOLDEN_MAX_TOKENS: "40000" }
    });
    stats.mockReturnValue(cassetteStats("record") as never);
    await prepareRelationsRematch(prepared);
    expect(limitLiveTokens).toHaveBeenCalledWith(40_000);
  });

  it("is refused beside MEMORA_GOLDEN_RUN, whatever else is right", async () => {
    await pinFixture();
    const { prepared, statements } = options({
      env: { ...knob, MEMORA_GOLDEN_RUN: "manifest.json" }
    });
    await expect(prepareRelationsRematch(prepared)).rejects.toThrow(RematchRefusal);
    expect(statements).toEqual([]);
  });

  it("starts by queueing the DEV heavy job once, waits for it to end and quits", async () => {
    await pinFixture();
    const { prepared, wake, quit } = options();
    queue.statuses.push("queued", "running", "succeeded");
    const run = await prepareRelationsRematch(prepared);
    await run.start();
    expect(queue.created).toEqual([
      expect.objectContaining({ type: rematchJobType, lane: "heavy", maxAttempts: 1 })
    ]);
    expect(wake).toHaveBeenCalledWith("heavy");
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("quits also when the job fails", async () => {
    await pinFixture();
    const { prepared, quit } = options();
    queue.statuses.push("failed");
    await (await prepareRelationsRematch(prepared)).start();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(prepared.logger.error).toHaveBeenCalled();
  });
});
