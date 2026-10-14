import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { processingPresetStages } from "@app/domain";
import type { AiCassetteStats } from "@app/ai";

import {
  classifyGoldenLibrary,
  mergeGoldenManifests,
  contentDigest,
  distribution,
  goldenManifestFiles,
  goldenManifestSchema,
  goldenRunStages,
  goldenSourcePath,
  goldenUserAgent,
  importSources,
  prepareGoldenRun,
  readGoldenRunEnvironment,
  readLimitedBody,
  selectGoldenSources,
  stableUuid,
  summarizeStages,
  trimGoldenText,
  verifyGoldenFile,
  waitForBatch,
  type GoldenLibrarySource,
  type GoldenManifest,
  type GoldenRunOptions
} from "./golden-runner.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const bytes = (text: string) => Buffer.byteLength(text);

const files = {
  web: "<html><body><p>Forgetting curve text.</p></body></html>",
  paper: "%PDF-1.7 fake paper",
  chapter: "<p>Capítulo I.</p>"
};

function testManifest(pinned = true): GoldenManifest {
  const pin = (text: string) => (pinned ? { sha256: sha(text), bytes: bytes(text) } : {});
  return goldenManifestSchema.parse({
    format: "memora-golden-manifest",
    version: 1,
    name: "test",
    description: "Test library",
    capturedAt: "2026-10-14T00:00:00.000Z",
    sources: [
      {
        key: "web",
        kind: "document",
        import: "webCapture",
        title: "Forgetting curve",
        language: "en",
        license: "CC-BY-SA-4.0",
        attribution: "Wikipedia",
        format: "html",
        url: "https://example.org/render",
        pageUrl: "https://example.org/page",
        sha256: null,
        bytes: null,
        ...pin(files.web)
      },
      {
        key: "paper",
        kind: "document",
        import: "file",
        title: "A paper",
        language: "en",
        license: "CC-BY-4.0",
        attribution: "Authors",
        format: "pdf",
        url: "https://example.org/paper.pdf",
        sha256: null,
        bytes: null,
        ...pin(files.paper),
        descriptor: { type: "AcademicPaper", doi: "10.1371/journal.pone.0120644" }
      },
      {
        key: "book",
        kind: "container",
        title: "O Alienista",
        language: "pt-BR",
        license: "public-domain",
        attribution: "Machado de Assis",
        descriptor: { type: "Book", creators: [{ name: "Machado de Assis", role: "author" }] },
        children: [
          {
            key: "book-01",
            kind: "document",
            import: "file",
            title: "I. Capítulo",
            language: "pt-BR",
            license: "public-domain",
            attribution: "Machado de Assis",
            format: "html",
            url: "https://example.org/1",
            sha256: null,
            bytes: null,
            ...pin(files.chapter),
            descriptor: { type: "BookChapter", chapterNumber: "I" }
          }
        ]
      }
    ]
  });
}

let workspace: string;
let userData: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-golden-"));
  userData = join(workspace, "userData");
  await mkdir(join(userData, "database"), { recursive: true });
  await writeFile(
    join(userData, "database", "dev-connection.json"),
    JSON.stringify({ developmentOnly: true })
  );
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function writeSources(manifest: GoldenManifest) {
  const content: Record<string, string> = {
    web: files.web,
    paper: files.paper,
    "book-01": files.chapter
  };
  for (const file of goldenManifestFiles(manifest)) {
    const path = goldenSourcePath(workspace, file);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, content[file.key]!);
  }
  const manifestPath = join(workspace, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

function stats(mode: "record" | "replay", misses = 0, liveTokens = 0): AiCassetteStats {
  return {
    mode,
    directory: "/cassette",
    served: 0,
    recorded: 0,
    misses,
    liveTokens,
    maxLiveTokens: null,
    byTask: {},
    missDetails: misses
      ? [{ key: "k", taskType: "summarization", occurrence: 0, requestPath: "/m" }]
      : []
  };
}

function fakeServices(
  input: {
    sources?: number;
    /** The sources the reset guard reads; when set they also make up the library count. */
    librarySources?: GoldenLibrarySource[];
    policyStates?: string[];
    scheduleEnabled?: boolean[];
    pendingJobs?: Array<{ type: string; count: number }>;
    dump?: boolean;
    /** What the reset does: empty the library (default), throw, or leave the rows behind. */
    reset?: "empties" | "fails" | "keeps";
  } = {}
) {
  const calls: Array<[string, unknown]> = [];
  const policies = (input.policyStates ?? ["enabled", "paused"]).map((state, index) => ({
    id: `policy-${index}`,
    state
  }));
  const schedules = (input.scheduleEnabled ?? [true, false]).map((enabled, index) => ({
    id: `schedule-${index}`,
    revision: index + 3,
    policy: { enabled }
  }));
  const library = {
    rows: input.librarySources ?? [],
    sources: input.sources ?? input.librarySources?.length ?? 0,
    pendingJobs: input.pendingJobs ?? []
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("as sources")) return { rows: [{ sources: library.sources, notes: 0 }] };
      if (sql.includes("from jobs")) return { rows: library.pendingJobs };
      if (sql.includes("originalSha256")) return { rows: library.rows };
      return { rows: [] };
    }
  };
  const libraryReset = {
    reset: async () => {
      calls.push(["reset", null]);
      if (input.reset === "fails") throw new Error("errors.common.permissionDenied");
      const deletedSources = library.sources;
      if (input.reset !== "keeps") {
        library.rows = [];
        library.sources = 0;
        library.pendingJobs = [];
      }
      return { deletedSources, deletedAtomicNotes: 0, deletedFiles: 0, failedFiles: 0 };
    }
  };
  const backup = {
    create: async (root: string) => {
      calls.push(["backup", root]);
      const path = join(root, "memora-backup-test");
      await mkdir(path, { recursive: true });
      if (input.dump !== false) await writeFile(join(path, "database.dump"), "PGDMP");
      return {
        path,
        createdAt: "2026-10-14T00:00:00.000Z",
        included: ["database"] as Array<"database">
      };
    }
  };
  const limits: Array<number | null> = [];
  const cassette = {
    stats: () => stats("record"),
    limitLiveTokens: (max: number | null) => {
      calls.push(["limitLiveTokens", max]);
      limits.push(max);
    }
  };
  const organization = {
    automaticCommand: async (command: { command: string; policyId?: string }) => {
      calls.push(["organization", command]);
      if (command.command === "pause") {
        const policy = policies.find((item) => item.id === command.policyId)!;
        policy.state = "paused";
        return policy;
      }
      return policies;
    }
  };
  const maintenance = {
    command: async (command: { command: string }) => {
      calls.push(["maintenance", command]);
      return command.command === "dashboard" ? { schedules, runs: [] } : {};
    }
  };
  return { calls, pool, organization, maintenance, backup, cassette, limits, libraryReset };
}

function prepareInput(
  manifestPath: string,
  services: ReturnType<typeof fakeServices>,
  overrides: Partial<Parameters<typeof prepareGoldenRun>[0]> = {}
): Parameters<typeof prepareGoldenRun>[0] {
  return {
    env: { MEMORA_GOLDEN_RUN: manifestPath, MEMORA_GOLDEN_MAX_TOKENS: "1000000" },
    isPackaged: false,
    userDataPath: userData,
    workspaceRoot: workspace,
    pool: services.pool as unknown as GoldenRunOptions["pool"],
    cassette: services.cassette,
    backup: services.backup,
    libraryReset: services.libraryReset,
    ingestion: {} as GoldenRunOptions["ingestion"],
    hierarchy: {} as GoldenRunOptions["hierarchy"],
    jobs: {} as GoldenRunOptions["jobs"],
    organization: services.organization as unknown as GoldenRunOptions["organization"],
    maintenance: services.maintenance as unknown as GoldenRunOptions["maintenance"],
    settings: { getApp: async () => ({}) as never },
    quit: () => undefined,
    log: () => undefined,
    readRoutes: async () => [{ task: "embedding" }],
    ...overrides
  };
}

describe("golden run environment", () => {
  it("is off without MEMORA_GOLDEN_RUN and refused in packaged builds", () => {
    const options = { isPackaged: false, workspaceRoot: "/repo" };
    expect(readGoldenRunEnvironment({}, options)).toBeNull();
    expect(readGoldenRunEnvironment({ MEMORA_GOLDEN_RUN: "  " }, options)).toBeNull();
    expect(() =>
      readGoldenRunEnvironment(
        { MEMORA_GOLDEN_RUN: "scripts/golden/manifest.json" },
        { ...options, isPackaged: true }
      )
    ).toThrow("packaged");
  });

  it("reads MEMORA_GOLDEN_RESET strictly: only 1 turns the destructive reset on", () => {
    const options = { isPackaged: false, workspaceRoot: "/repo" };
    const read = (reset: string | undefined, extra: Record<string, string> = {}) =>
      readGoldenRunEnvironment(
        {
          MEMORA_GOLDEN_RUN: "m.json",
          ...(reset === undefined ? {} : { MEMORA_GOLDEN_RESET: reset }),
          ...extra
        },
        options
      );
    expect(read(undefined)).toMatchObject({ resetLibrary: false });
    expect(read("")).toMatchObject({ resetLibrary: false });
    expect(read("0")).toMatchObject({ resetLibrary: false });
    expect(read("1")).toMatchObject({ resetLibrary: true });
    expect(() => read("true")).toThrow("MEMORA_GOLDEN_RESET must be 1");
    expect(() => read("1", { MEMORA_GOLDEN_ALLOW_NONEMPTY: "1" })).toThrow("contradict");
    expect(read("1", { MEMORA_GOLDEN_RESET_ALSO: " a.json, ,b/c.json" })).toMatchObject({
      resetAlsoManifestPaths: ["/repo/a.json", "/repo/b/c.json"]
    });
    expect(() => read(undefined, { MEMORA_GOLDEN_RESET_ALSO: "a.json" })).toThrow(
      "MEMORA_GOLDEN_RESET_ALSO only applies"
    );
    // Not requested without a golden run, but never honored in a packaged build either.
    expect(readGoldenRunEnvironment({ MEMORA_GOLDEN_RESET: "1" }, options)).toBeNull();
    expect(() =>
      readGoldenRunEnvironment({ MEMORA_GOLDEN_RESET: "1" }, { ...options, isPackaged: true })
    ).toThrow("MEMORA_GOLDEN_RESET is refused in packaged builds");
    expect(() =>
      readGoldenRunEnvironment(
        { MEMORA_GOLDEN_RUN: "m.json", MEMORA_GOLDEN_RESET: "1" },
        { ...options, isPackaged: true }
      )
    ).toThrow("packaged");
  });

  it("resolves the manifest against the repository and reads the flags", () => {
    expect(
      readGoldenRunEnvironment(
        {
          MEMORA_GOLDEN_RUN: "scripts/golden/manifest.json",
          MEMORA_GOLDEN_ALLOW_NONEMPTY: "1",
          MEMORA_GOLDEN_EXIT: "1",
          MEMORA_GOLDEN_MAX_TOKENS: "500000"
        },
        { isPackaged: false, workspaceRoot: "/repo" }
      )
    ).toEqual({
      manifestPath: "/repo/scripts/golden/manifest.json",
      allowNonEmpty: true,
      resetLibrary: false,
      resetAlsoManifestPaths: [],
      exitWhenDone: true,
      maxLiveTokens: 500000,
      only: null
    });
    expect(
      readGoldenRunEnvironment(
        { MEMORA_GOLDEN_RUN: "m.json", MEMORA_GOLDEN_ONLY: " a-b, c ,," },
        { isPackaged: false, workspaceRoot: "/repo" }
      )
    ).toMatchObject({ only: ["a-b", "c"] });
    expect(() =>
      readGoldenRunEnvironment(
        { MEMORA_GOLDEN_RUN: "m.json", MEMORA_GOLDEN_ONLY: "Not A Key" },
        { isPackaged: false, workspaceRoot: "/repo" }
      )
    ).toThrow("MEMORA_GOLDEN_ONLY");
    expect(() =>
      readGoldenRunEnvironment(
        { MEMORA_GOLDEN_RUN: "m.json", MEMORA_GOLDEN_MAX_TOKENS: "-1" },
        { isPackaged: false, workspaceRoot: "/repo" }
      )
    ).toThrow("MEMORA_GOLDEN_MAX_TOKENS");
  });
});

describe("golden manifest", () => {
  it("accepts the repository manifest: small, mixed and licensed for local copies", async () => {
    const manifest = goldenManifestSchema.parse(
      JSON.parse(await readFile(join(process.cwd(), "scripts/golden/manifest.json"), "utf8"))
    );
    const all = goldenManifestFiles(manifest);
    expect(manifest.sources.length).toBeGreaterThanOrEqual(10);
    expect(manifest.sources.length).toBeLessThanOrEqual(12);
    expect(new Set(all.map((file) => file.format))).toEqual(
      new Set(["pdf", "html", "markdown", "text"])
    );
    expect(new Set(manifest.sources.map((source) => source.language.slice(0, 2)))).toEqual(
      new Set(["en", "pt"])
    );
    expect(manifest.sources.some((source) => source.kind === "container")).toBe(true);
    expect(all.filter((file) => file.url.includes("wikipedia.org"))).toHaveLength(2);
    for (const file of all)
      expect(file.license).toMatch(/^(CC-BY-4\.0|CC-BY-SA-4\.0|public-domain)$/);
    // Every Portuguese source uses one locale, and plain-text sources drop their boilerplate.
    expect(
      new Set(
        manifest.sources.filter((source) => source.language.startsWith("pt")).map((s) => s.language)
      )
    ).toEqual(new Set(["pt-BR"]));
    expect(all.filter((file) => file.format === "text").every((file) => "trim" in file)).toBe(true);
  });

  it("accepts a trim only on text files", () => {
    const base = testManifest(false);
    const paper = { ...base.sources[1], trim: { start: "a", end: "b" } };
    expect(goldenManifestSchema.safeParse({ ...base, sources: [paper] }).success).toBe(false);
    const text = { ...paper, format: "text", url: "https://example.org/a.txt" };
    expect(goldenManifestSchema.safeParse({ ...base, sources: [text] }).success).toBe(true);
  });

  it("rejects duplicate keys, plain HTTP, invalid descriptors and non-container roots", () => {
    const base = testManifest(false);
    const variants: unknown[] = [
      { ...base, sources: [...base.sources, base.sources[0]] },
      { ...base, sources: [{ ...base.sources[1], url: "http://example.org/paper.pdf" }] },
      {
        ...base,
        sources: [{ ...base.sources[1], descriptor: { type: "AcademicPaper", title: "x" } }]
      },
      { ...base, sources: [{ ...base.sources[1], descriptor: { type: "Nope" } }] },
      { ...base, sources: [{ ...base.sources[0], format: "pdf" }] },
      {
        ...base,
        sources: [{ ...base.sources[2], descriptor: { type: "WebArticle" } }]
      }
    ];
    for (const variant of variants)
      expect(goldenManifestSchema.safeParse(variant).success, JSON.stringify(variant)).toBe(false);
  });

  it("processes the full knowledge plan without organizeKnowledge", () => {
    expect(goldenRunStages).toEqual(
      processingPresetStages.full_knowledge.filter((stage) => stage !== "organizeKnowledge")
    );
    expect(goldenRunStages).toEqual(
      expect.arrayContaining(["embedding", "summarization", "atomicNoteMatching", "sourceMatching"])
    );
  });
});

describe("golden source files", () => {
  it("are verified by size and SHA-256", async () => {
    const path = join(workspace, "file.txt");
    expect(await verifyGoldenFile(path, { sha256: null, bytes: null })).toEqual({
      status: "unpinned"
    });
    expect(await verifyGoldenFile(path, { sha256: sha("x"), bytes: 1 })).toEqual({
      status: "missing"
    });
    await writeFile(path, "x");
    expect(await verifyGoldenFile(path, { sha256: sha("x"), bytes: 1 })).toEqual({ status: "ok" });
    await writeFile(path, "y");
    expect(await verifyGoldenFile(path, { sha256: sha("x"), bytes: 1 })).toEqual({
      status: "mismatch",
      sha256: sha("y"),
      bytes: 1
    });
  });

  it("derive stable UUID-shaped capture IDs", () => {
    expect(stableUuid("golden:web")).toBe(stableUuid("golden:web"));
    expect(stableUuid("golden:web")).not.toBe(stableUuid("golden:other"));
    expect(stableUuid("golden:web")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});

describe("golden run preparation", () => {
  it("backs up first, then pauses only enabled legacy policies and schedules", async () => {
    const manifest = testManifest();
    const services = fakeServices({
      policyStates: ["enabled", "paused"],
      scheduleEnabled: [true, false]
    });
    const run = await prepareGoldenRun(prepareInput(await writeSources(manifest), services));
    expect(run.automation).toEqual({
      pausedPolicies: ["policy-0"],
      pausedSchedules: ["schedule-0"]
    });
    expect(run.backup).toEqual({
      path: join(workspace, ".cache", "f0", "backups", "memora-backup-test"),
      createdAt: "2026-10-14T00:00:00.000Z",
      bytes: 5
    });
    expect(services.calls).toContainEqual([
      "organization",
      { command: "pause", policyId: "policy-0" }
    ]);
    expect(services.calls).toContainEqual([
      "maintenance",
      { command: "pause", id: "schedule-0", expectedRevision: 3 }
    ]);
    expect(
      services.calls.filter(([, command]) => JSON.stringify(command).includes("pause"))
    ).toHaveLength(2);
    // The backup is the first change and the live token cap is armed before any pause.
    expect(services.calls.map(([name]) => name).slice(0, 2)).toEqual(["backup", "limitLiveTokens"]);
    expect(services.limits).toEqual([1000000]);
  });

  it("refuses a non-empty library unless explicitly allowed, changing nothing", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({ sources: 3 });
    await expect(prepareGoldenRun(prepareInput(manifestPath, services))).rejects.toThrow(
      "not empty"
    );
    expect(services.calls).toEqual([]);
    const allowed = fakeServices({ sources: 3 });
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, allowed, {
          env: {
            MEMORA_GOLDEN_RUN: manifestPath,
            MEMORA_GOLDEN_ALLOW_NONEMPTY: "1",
            MEMORA_GOLDEN_MAX_TOKENS: "10"
          }
        })
      )
    ).resolves.toMatchObject({ manifest: { name: "test" } });
  });

  it("refuses queued or running jobs, which the supervisor would claim, changing nothing", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({
      pendingJobs: [
        { type: "maintenance", count: 1 },
        { type: "organization", count: 2 }
      ]
    });
    await expect(prepareGoldenRun(prepareInput(manifestPath, services))).rejects.toThrow(
      "3 jobs are queued or running (maintenance 1, organization 2)"
    );
    expect(services.calls).toEqual([]);
  });

  it("needs a cap on live tokens to record, and none to replay", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices();
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, services, { env: { MEMORA_GOLDEN_RUN: manifestPath } })
      )
    ).rejects.toThrow("MEMORA_GOLDEN_MAX_TOKENS");
    expect(services.calls).toEqual([]);

    const replay = fakeServices();
    replay.cassette.stats = () => stats("replay");
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, replay, { env: { MEMORA_GOLDEN_RUN: manifestPath } })
      )
    ).resolves.toMatchObject({ manifest: { name: "test" } });
    expect(replay.limits).toEqual([]);
  });

  it("runs only the requested top-level sources", async () => {
    const manifestPath = await writeSources(testManifest());
    const run = await prepareGoldenRun(
      prepareInput(manifestPath, fakeServices(), {
        env: {
          MEMORA_GOLDEN_RUN: manifestPath,
          MEMORA_GOLDEN_MAX_TOKENS: "10",
          MEMORA_GOLDEN_ONLY: "web,book"
        }
      })
    );
    expect(run.manifest.sources.map((source) => source.key)).toEqual(["web", "book"]);
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, fakeServices(), {
          env: {
            MEMORA_GOLDEN_RUN: manifestPath,
            MEMORA_GOLDEN_MAX_TOKENS: "10",
            MEMORA_GOLDEN_ONLY: "web,nope"
          }
        })
      )
    ).rejects.toThrow("unknown sources: nope");
    const manifest = testManifest();
    expect(selectGoldenSources(manifest, null)).toBe(manifest);
  });

  it("needs a cassette, the DEV database, verified files and a pausable automation", async () => {
    const manifestPath = await writeSources(testManifest());
    await expect(
      prepareGoldenRun(prepareInput(manifestPath, fakeServices(), { cassette: null }))
    ).rejects.toThrow("MEMORA_AI_CASSETTE");
    await expect(
      prepareGoldenRun(prepareInput(manifestPath, fakeServices(), { isPackaged: true }))
    ).rejects.toThrow("packaged");
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, fakeServices(), { userDataPath: join(workspace, "other") })
      )
    ).rejects.toThrow("DEV PostgreSQL");

    const unpinned = await writeSources(testManifest(false));
    const services = fakeServices();
    await expect(prepareGoldenRun(prepareInput(unpinned, services))).rejects.toThrow(
      "web: unpinned"
    );
    expect(services.calls).toEqual([]);

    await writeSources(testManifest());
    const noRoute = fakeServices();
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, noRoute, {
          readRoutes: async () => {
            throw new Error("The golden run needs a configured reranking route");
          }
        })
      )
    ).rejects.toThrow("reranking route");
    expect(noRoute.calls).toEqual([]);

    const stuck = fakeServices();
    stuck.organization.automaticCommand = async () => [{ id: "p", state: "enabled" }];
    await expect(prepareGoldenRun(prepareInput(manifestPath, stuck))).rejects.toThrow(
      "could not be paused"
    );
  });

  it("stops before pausing anything when the backup holds no dump", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({ dump: false });
    await expect(prepareGoldenRun(prepareInput(manifestPath, services))).rejects.toThrow(
      "no database dump"
    );
    expect(services.calls.map(([name]) => name)).toEqual(["backup"]);
    expect(services.limits).toEqual([]);
  });
});

const goldenSource = (
  overrides: Partial<GoldenLibrarySource> & Pick<GoldenLibrarySource, "id">
): GoldenLibrarySource => ({
  parentId: null,
  type: "StandaloneArticle",
  title: "Some source",
  origin: "file_upload",
  captureRequestId: null,
  originalSha256: [],
  // Imported sources hold a document and its original; a bare row is built with `bareLeftover`.
  documents: 1,
  assets: 1,
  ...overrides
});
/** The row a failed import left behind: no document and no asset. */
const bareLeftover = (
  overrides: Partial<GoldenLibrarySource> & Pick<GoldenLibrarySource, "id">
): GoldenLibrarySource => goldenSource({ documents: 0, assets: 0, ...overrides });
const goldenPaper = (id = "paper-1") =>
  goldenSource({ id, type: "AcademicPaper", title: "A paper", originalSha256: [sha(files.paper)] });
const goldenWeb = (id = "web-1") =>
  goldenSource({
    id,
    type: "WebArticle",
    title: "Forgetting curve",
    origin: "web_capture",
    captureRequestId: stableUuid("golden:web")
  });
const goldenBook = (id = "book-1") =>
  goldenSource({ id, type: "Book", title: "O Alienista", origin: "manual" });
const goldenChapter = (id = "chapter-1", parentId = "book-1") =>
  goldenSource({
    id,
    parentId,
    type: "BookChapter",
    title: "I. Capítulo",
    originalSha256: [sha(files.chapter)]
  });
const foreignSource = (id = "mine-1") =>
  goldenSource({
    id,
    title: "My own reading notes",
    originalSha256: [sha("something the owner imported")]
  });

describe("golden library classification", () => {
  it("proves file imports by the SHA-256 of their original bytes, whatever their title", () => {
    const result = classifyGoldenLibrary(testManifest(), [
      { ...goldenPaper(), title: "Renamed by the owner afterwards" }
    ]);
    expect(result.golden.map((source) => source.id)).toEqual(["paper-1"]);
    expect(result.foreign).toEqual([]);
  });

  it("treats sources of any merged golden manifest as golden, and nothing else", () => {
    const full = testManifest();
    const withoutWeb = {
      sources: full.sources.filter(
        (source) => !(source.kind === "document" && source.import === "webCapture")
      )
    };
    expect(classifyGoldenLibrary(withoutWeb, [goldenWeb()]).foreign).toHaveLength(1);
    const merged = mergeGoldenManifests([withoutWeb, full]);
    expect(classifyGoldenLibrary(merged, [goldenWeb(), goldenPaper()]).foreign).toEqual([]);
    expect(classifyGoldenLibrary(merged, [foreignSource("mine")]).foreign).toHaveLength(1);
  });

  it("proves web captures by the capture ID derived from the manifest key", () => {
    const manifest = testManifest();
    expect(classifyGoldenLibrary(manifest, [goldenWeb()]).foreign).toEqual([]);
    const lookalikes = [
      { ...goldenWeb("a"), captureRequestId: "11111111-1111-4111-8111-111111111111" },
      { ...goldenWeb("b"), origin: "manual" },
      { ...goldenWeb("c"), captureRequestId: null }
    ];
    expect(classifyGoldenLibrary(manifest, lookalikes).foreign.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c"
    ]);
  });

  it("proves a container by its type and title and by every direct child being its pinned file", () => {
    const manifest = testManifest();
    expect(classifyGoldenLibrary(manifest, [goldenBook(), goldenChapter()]).foreign).toEqual([]);
    // An interrupted import left the container empty: nothing in it can be lost.
    expect(classifyGoldenLibrary(manifest, [goldenBook()]).foreign).toEqual([]);
    const mixed = classifyGoldenLibrary(manifest, [
      goldenBook(),
      goldenChapter(),
      { ...foreignSource("stray"), parentId: "book-1", title: "My chapter" }
    ]);
    expect(mixed.golden).toEqual([]);
    expect(mixed.foreign).toEqual([
      expect.objectContaining({
        id: "book-1",
        reason: expect.stringContaining('its child "My chapter" is not a pinned file')
      })
    ]);
    // The chapter's SHA is pinned, but another container's chapter does not belong to this book.
    const other = classifyGoldenLibrary(manifest, [
      { ...goldenBook(), title: "Another book" },
      goldenChapter()
    ]);
    expect(other.foreign.map((item) => item.id)).toEqual(["book-1"]);
  });

  it("covers what is materialized under a golden root and flags what no root reaches", () => {
    const manifest = testManifest();
    const section = goldenSource({
      id: "section-1",
      parentId: "paper-1",
      type: "DocumentSection",
      title: "Methods"
    });
    expect(classifyGoldenLibrary(manifest, [goldenPaper(), section]).foreign).toEqual([]);
    const cycle = classifyGoldenLibrary(manifest, [
      goldenSource({ id: "x", parentId: "y" }),
      goldenSource({ id: "y", parentId: "x" })
    ]);
    expect(cycle.foreign.map((item) => item.id)).toEqual(["x", "y"]);
  });

  it("never matches an unpinned manifest entry or a source without original bytes", () => {
    const unpinned = testManifest(false);
    expect(classifyGoldenLibrary(unpinned, [goldenPaper()]).foreign).toHaveLength(1);
    expect(
      classifyGoldenLibrary(testManifest(), [goldenSource({ id: "manual-note", origin: "manual" })])
        .foreign
    ).toHaveLength(1);
  });
});

describe("golden library leftovers of a failed import", () => {
  it("treats a root without document, asset or content under it as golden when type and title match", () => {
    const manifest = testManifest();
    const paper = bareLeftover({ id: "paper-1", type: "AcademicPaper", title: "A paper" });
    const web = bareLeftover({
      id: "web-1",
      type: "WebArticle",
      title: "Forgetting curve",
      origin: "web_capture"
    });
    const book = bareLeftover({ id: "book-1", type: "Book", title: "O Alienista" });
    const emptyChild = bareLeftover({
      id: "child-1",
      parentId: "paper-1",
      type: "DocumentSection",
      title: "Methods"
    });
    const result = classifyGoldenLibrary(manifest, [paper, web, book, emptyChild]);
    expect(result.foreign).toEqual([]);
    expect(result.golden.map((source) => source.id)).toEqual(["paper-1", "web-1", "book-1"]);
  });

  it("still refuses a content-less root whose title or type is not in the manifest", () => {
    const manifest = testManifest();
    const result = classifyGoldenLibrary(manifest, [
      bareLeftover({ id: "other-title", type: "AcademicPaper", title: "Another paper" }),
      bareLeftover({ id: "other-type", type: "StandaloneArticle", title: "A paper" }),
      bareLeftover({ id: "case", type: "AcademicPaper", title: "a paper" }),
      bareLeftover({ id: "spaces", type: "AcademicPaper", title: "A paper " })
    ]);
    expect(result.golden).toEqual([]);
    expect(result.foreign.map((item) => item.id)).toEqual([
      "other-title",
      "other-type",
      "case",
      "spaces"
    ]);
  });

  it("still refuses a matching root that has a document, an asset or content under it", () => {
    const manifest = testManifest();
    const paper = { id: "paper-1", type: "AcademicPaper", title: "A paper", originalSha256: [] };
    const withDocument = bareLeftover({ ...paper, id: "with-document", documents: 1 });
    const withAsset = bareLeftover({ ...paper, id: "with-asset", assets: 1 });
    const parent = bareLeftover({ ...paper, id: "parent" });
    const contentChild = bareLeftover({
      id: "child",
      parentId: "parent",
      type: "DocumentSection",
      title: "Methods"
    });
    const grandchild = goldenSource({
      id: "grandchild",
      parentId: "child",
      type: "DocumentSection",
      title: "Deep"
    });
    const result = classifyGoldenLibrary(manifest, [
      withDocument,
      withAsset,
      parent,
      contentChild,
      grandchild
    ]);
    expect(result.golden).toEqual([]);
    expect(result.foreign.map((item) => item.id).sort()).toEqual(
      ["parent", "with-asset", "with-document"].sort()
    );
  });
});

describe("golden library reset (MEMORA_GOLDEN_RESET=1)", () => {
  const resetEnvironment = (manifestPath: string) => ({
    MEMORA_GOLDEN_RUN: manifestPath,
    MEMORA_GOLDEN_MAX_TOKENS: "1000000",
    MEMORA_GOLDEN_RESET: "1"
  });
  const names = (services: ReturnType<typeof fakeServices>) => services.calls.map(([name]) => name);

  it("resets a library of golden sources after the backup, then continues as on an empty library", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({
      librarySources: [goldenWeb(), goldenPaper(), goldenBook(), goldenChapter()],
      pendingJobs: [{ type: "ingestion", count: 2 }]
    });
    const events: Array<[string, Record<string, unknown> | undefined]> = [];
    const run = await prepareGoldenRun(
      prepareInput(manifestPath, services, {
        env: resetEnvironment(manifestPath),
        log: (event, data) => events.push([event, data])
      })
    );
    const backupPath = join(workspace, ".cache", "f0", "backups", "memora-backup-test");
    expect(run.reset).toEqual({ performed: true, removedSources: 4, backupPath });
    // One backup, taken before the reset; then the cap and the pauses as in any other run.
    expect(names(services).slice(0, 4)).toEqual([
      "backup",
      "reset",
      "limitLiveTokens",
      "organization"
    ]);
    expect(names(services).filter((name) => name === "backup")).toHaveLength(1);
    expect(run.backup.path).toBe(backupPath);
    // The automation is paused after the reset (the real reset restores its defaults first).
    expect(run.automation.pausedPolicies).toEqual(["policy-0"]);
    expect(events.find(([event]) => event === "reset")?.[1]).toEqual({
      performed: true,
      removedSources: 4,
      backupPath,
      roots: 3,
      droppedPendingJobs: 2
    });
    expect(events.find(([event]) => event === "prepared")?.[1]).toMatchObject({
      library: { sources: 0, notes: 0 },
      pendingJobs: [],
      reset: { performed: true }
    });
  });

  it("refuses a library with a non-golden source, changing nothing", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({
      librarySources: [goldenPaper(), foreignSource("mine-1"), foreignSource("mine-2")]
    });
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, services, { env: resetEnvironment(manifestPath) })
      )
    ).rejects.toThrow("library holds non-golden sources (2)");
    expect(services.calls).toEqual([]);
    // The refusal names the sources so the owner can see what blocked it.
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, services, { env: resetEnvironment(manifestPath) })
      )
    ).rejects.toThrow('mine-1 StandaloneArticle "My own reading notes"');
  });

  it("resets a library whose only trace of a failed golden import is the bare source row", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({
      librarySources: [
        bareLeftover({ id: "paper-1", type: "AcademicPaper", title: "A paper" }),
        goldenWeb()
      ]
    });
    const run = await prepareGoldenRun(
      prepareInput(manifestPath, services, { env: resetEnvironment(manifestPath) })
    );
    expect(run.reset).toMatchObject({ performed: true, removedSources: 2 });
    expect(names(services).slice(0, 2)).toEqual(["backup", "reset"]);
  });

  it("refuses a content-less source whose title is not in the manifest, changing nothing", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({
      librarySources: [
        bareLeftover({ id: "paper-1", type: "AcademicPaper", title: "A paper" }),
        bareLeftover({ id: "mine-1", type: "AcademicPaper", title: "My unfinished import" })
      ]
    });
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, services, { env: resetEnvironment(manifestPath) })
      )
    ).rejects.toThrow('library holds non-golden sources (1): mine-1 AcademicPaper "My unfinished');
    expect(services.calls).toEqual([]);
  });

  it("refuses a golden container that holds a foreign chapter", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({
      librarySources: [
        goldenBook(),
        goldenChapter(),
        { ...foreignSource("stray"), parentId: "book-1" }
      ]
    });
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, services, { env: resetEnvironment(manifestPath) })
      )
    ).rejects.toThrow("library holds non-golden sources (1)");
    expect(services.calls).toEqual([]);
  });

  it("does nothing to an empty library and takes the run's single backup as usual", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices();
    const events: string[] = [];
    const run = await prepareGoldenRun(
      prepareInput(manifestPath, services, {
        env: resetEnvironment(manifestPath),
        log: (event) => events.push(event)
      })
    );
    expect(run.reset).toEqual({ performed: false, removedSources: 0, backupPath: null });
    expect(names(services)).not.toContain("reset");
    expect(names(services).filter((name) => name === "backup")).toHaveLength(1);
    expect(events).toContain("reset");
  });

  it("does not touch a library without the flag: a golden library is still refused as not empty", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({ librarySources: [goldenPaper()] });
    await expect(prepareGoldenRun(prepareInput(manifestPath, services))).rejects.toThrow(
      "not empty"
    );
    expect(services.calls).toEqual([]);
    const run = await prepareGoldenRun(
      prepareInput(await writeSources(testManifest()), fakeServices())
    );
    expect(run.reset).toBeUndefined();
  });

  it("guards against the whole manifest, not only the MEMORA_GOLDEN_ONLY subset", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({ librarySources: [goldenPaper(), goldenWeb()] });
    const run = await prepareGoldenRun(
      prepareInput(manifestPath, services, {
        env: { ...resetEnvironment(manifestPath), MEMORA_GOLDEN_ONLY: "web" }
      })
    );
    expect(run.reset).toMatchObject({ performed: true, removedSources: 2 });
  });

  it("checks the routes and the files before it touches anything", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({ librarySources: [goldenPaper()] });
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, services, {
          env: resetEnvironment(manifestPath),
          readRoutes: async () => {
            throw new Error("The golden run needs a configured reranking route");
          }
        })
      )
    ).rejects.toThrow("reranking route");
    expect(services.calls).toEqual([]);
    await expect(
      prepareGoldenRun(
        prepareInput(await writeSources(testManifest(false)), services, {
          env: resetEnvironment(manifestPath)
        })
      )
    ).rejects.toThrow("web: unpinned");
    expect(services.calls).toEqual([]);
  });

  it("does not reset when the backup holds no dump", async () => {
    const manifestPath = await writeSources(testManifest());
    const services = fakeServices({ librarySources: [goldenPaper()], dump: false });
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, services, { env: resetEnvironment(manifestPath) })
      )
    ).rejects.toThrow("no database dump");
    expect(names(services)).toEqual(["backup"]);
  });

  it("stops with the backup path when the reset fails or leaves sources behind", async () => {
    const manifestPath = await writeSources(testManifest());
    const failing = fakeServices({ librarySources: [goldenPaper()], reset: "fails" });
    await expect(
      prepareGoldenRun(prepareInput(manifestPath, failing, { env: resetEnvironment(manifestPath) }))
    ).rejects.toThrow(/reset failed \(errors\.common\.permissionDenied\).*memora-backup-test/);
    expect(names(failing)).toEqual(["backup", "reset"]);
    const keeping = fakeServices({ librarySources: [goldenPaper()], reset: "keeps" });
    await expect(
      prepareGoldenRun(prepareInput(manifestPath, keeping, { env: resetEnvironment(manifestPath) }))
    ).rejects.toThrow(/not empty after the reset \(1 sources, 0 notes\).*memora-backup-test/);
    expect(names(keeping)).toEqual(["backup", "reset"]);
  });

  it("needs the library reset service, and with nothing to reset still refuses queued jobs", async () => {
    const manifestPath = await writeSources(testManifest());
    await expect(
      prepareGoldenRun(
        prepareInput(manifestPath, fakeServices(), {
          env: resetEnvironment(manifestPath),
          libraryReset: undefined as never
        })
      )
    ).rejects.toThrow("needs the library reset service");
    // No source to reset: queued jobs are still refused exactly as without the flag.
    const queued = fakeServices({ pendingJobs: [{ type: "maintenance", count: 1 }] });
    await expect(
      prepareGoldenRun(prepareInput(manifestPath, queued, { env: resetEnvironment(manifestPath) }))
    ).rejects.toThrow("1 jobs are queued or running");
    expect(queued.calls).toEqual([]);
  });
});

describe("golden imports", () => {
  it("imports in manifest order through the normal ingestion services", async () => {
    const manifest = testManifest();
    await writeSources(manifest);
    const calls: Array<[string, unknown]> = [];
    let next = 0;
    const result = (extra: Record<string, unknown> = {}) => ({
      sourceItemId: `00000000-0000-4000-8000-00000000000${++next}`,
      documentId: null,
      ingestionRunId: null,
      jobId: null,
      batchId: null,
      structureId: null,
      requiresStructureReview: false,
      duplicate: false,
      ...extra
    });
    const division = {
      id: "10000000-0000-4000-8000-000000000001",
      parentId: null,
      kind: "section",
      title: "Introduction",
      level: 1,
      position: 0,
      startSelector: {},
      endSelector: {},
      markdownStart: 0,
      markdownEnd: 10,
      confidence: 0.9,
      evidence: [],
      reviewStatus: "proposed",
      isProcessable: true,
      metadata: {},
      rowId: "row",
      structureId: "20000000-0000-4000-8000-000000000001",
      childSourceItemId: null,
      childDocumentId: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    const imported = await importSources(
      {
        workspaceRoot: workspace,
        log: () => undefined,
        ingestion: {
          captureWebPage: async (input: unknown) => {
            calls.push(["captureWebPage", input]);
            return result();
          },
          importFile: async (path: string, input: unknown) => {
            calls.push(["importFile", { path, input }]);
            return path.endsWith(".pdf")
              ? result({
                  requiresStructureReview: true,
                  structureId: "20000000-0000-4000-8000-000000000001"
                })
              : result();
          },
          createContainerSource: async (input: unknown) => {
            calls.push(["createContainerSource", input]);
            return result();
          }
        } as unknown as GoldenRunOptions["ingestion"],
        hierarchy: {
          getStructure: async () => ({ divisions: [division] }),
          confirmStructure: async (input: unknown) => {
            calls.push(["confirmStructure", input]);
            return {};
          }
        } as unknown as GoldenRunOptions["hierarchy"]
      },
      manifest
    );
    expect(calls.map(([name]) => name)).toEqual([
      "captureWebPage",
      "importFile",
      "confirmStructure",
      "createContainerSource",
      "importFile"
    ]);
    expect(calls[0]![1]).toMatchObject({
      requestId: stableUuid("golden:web"),
      url: "https://example.org/page",
      title: "Forgetting curve",
      capturedAt: "2026-10-14T00:00:00.000Z",
      metadata: { language: "en" },
      html: files.web
    });
    expect(calls[1]![1]).toMatchObject({
      path: goldenSourcePath(workspace, { key: "paper", format: "pdf" }),
      input: {
        descriptor: { type: "AcademicPaper", title: "A paper", language: "en" },
        duplicatePolicy: "ignore",
        processingPlan: { preset: "import_only", requestedStages: [] }
      }
    });
    const confirmed = calls[2]![1] as { divisions: Array<Record<string, unknown>> };
    expect(confirmed.divisions).toEqual([
      expect.objectContaining({ id: division.id, title: "Introduction", kind: "section" })
    ]);
    expect(confirmed.divisions[0]).not.toHaveProperty("rowId");
    expect(calls[4]![1]).toMatchObject({
      input: {
        descriptor: {
          type: "BookChapter",
          title: "I. Capítulo",
          parentSourceItemId: imported[2]!.sourceItemId
        }
      }
    });
    expect(imported.map((source) => [source.key, source.kind])).toEqual([
      ["web", "document"],
      ["paper", "document"],
      ["book", "container"]
    ]);
    expect(imported[1]!.structure).toEqual({
      id: "20000000-0000-4000-8000-000000000001",
      divisions: 1
    });
  });
});

describe("golden duplicate imports", () => {
  function duplicateServices(duplicateAt: "container" | "capture" | "file") {
    const answer = (name: string, extra: Record<string, unknown> = {}) => ({
      sourceItemId: `00000000-0000-4000-8000-${name.padEnd(12, "0")}`,
      documentId: null,
      ingestionRunId: null,
      jobId: null,
      batchId: null,
      structureId: null,
      requiresStructureReview: false,
      duplicate: false,
      ...extra
    });
    return {
      workspaceRoot: workspace,
      log: () => undefined,
      ingestion: {
        captureWebPage: async () => answer("1", { duplicate: duplicateAt === "capture" }),
        importFile: async () => answer("2", { duplicate: duplicateAt === "file" }),
        createContainerSource: async () => answer("3", { duplicate: duplicateAt === "container" })
      } as unknown as GoldenRunOptions["ingestion"],
      hierarchy: {} as GoldenRunOptions["hierarchy"]
    };
  }

  it.each([
    ["capture", "web"],
    ["file", "paper"],
    ["container", "book"]
  ] as const)("fail when the %s is already in the library", async (kind, key) => {
    const manifest = testManifest();
    await writeSources(manifest);
    await expect(importSources(duplicateServices(kind), manifest)).rejects.toThrow(
      `${key} is already in the library`
    );
  });

  it("fail for a child file of a container too", async () => {
    const manifest = testManifest();
    await writeSources(manifest);
    const services = duplicateServices("file");
    // The paper fails first; keep only the book to reach its child.
    const book = {
      ...manifest,
      sources: manifest.sources.filter((source) => source.key === "book")
    };
    await expect(importSources(services, book)).rejects.toThrow(
      "book-01 is already in the library"
    );
  });
});

describe("golden source helpers", () => {
  const gutenberg = [
    "\uFEFFThe Project Gutenberg eBook of A Story\r\n",
    "\r\n*** START OF THE PROJECT GUTENBERG EBOOK A STORY ***\r\n",
    "\r\nProduced by Someone\r\n\r\nOne dollar.\r\n\r\nThe end.\r\n\r\n",
    "*** END OF THE PROJECT GUTENBERG EBOOK A STORY ***\r\n",
    "\r\nLicense text ... *** START: FULL LICENSE ***\r\n"
  ].join("");

  it("trim a text to the lines between the markers, with LF line ends", () => {
    expect(trimGoldenText(gutenberg, { start: "*** START OF", end: "*** END OF" })).toBe(
      "Produced by Someone\n\nOne dollar.\n\nThe end.\n"
    );
  });

  it("refuse a text whose markers are missing or empty instead of keeping boilerplate", () => {
    const markers = { start: "*** START OF", end: "*** END OF" };
    expect(() => trimGoldenText("no markers", markers)).toThrow("start marker");
    expect(() => trimGoldenText("*** START OF X ***\nbody", markers)).toThrow("end marker");
    expect(() => trimGoldenText("*** END OF X ***\n*** START OF Y ***\nbody", markers)).toThrow(
      "end marker"
    );
    expect(() => trimGoldenText("*** START OF X ***\n*** END OF X ***\n", markers)).toThrow(
      "empty"
    );
  });

  it("read a response body but stop the transfer past the byte limit", async () => {
    expect((await readLimitedBody(new Response("hello"), 10)).toString("utf8")).toBe("hello");
    await expect(
      readLimitedBody(new Response("x", { headers: { "content-length": "999" } }), 10)
    ).rejects.toThrow("too large (999 bytes)");
    // No content-length: an endless body must be cut off, not buffered.
    let pulled = 0;
    const endless = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(new Uint8Array(4));
        }
      })
    );
    await expect(readLimitedBody(endless, 10)).rejects.toThrow("too large");
    expect(pulled).toBeLessThan(10);
  });

  it("build a User-Agent that names a contact", () => {
    expect(goldenUserAgent(" https://example.org/contact ")).toBe(
      "MemoraEterna-golden/0.1 (https://example.org/contact; local reference library, no redistribution)"
    );
    expect(() => goldenUserAgent(undefined)).toThrow("MEMORA_GOLDEN_CONTACT");
    expect(() => goldenUserAgent("  ")).toThrow("MEMORA_GOLDEN_CONTACT");
    expect(() => goldenUserAgent("a@b.c)\r\nX: y")).toThrow("line breaks");
  });
});

describe("golden batch waiting", () => {
  function waitOptions(input: {
    active: number[];
    mode?: "record" | "replay";
    misses?: number;
    liveTokens?: number;
    maxLiveTokens?: number | null;
  }) {
    const canceled: string[] = [];
    let poll = 0;
    const options = {
      environment: {
        manifestPath: "m",
        allowNonEmpty: false,
        exitWhenDone: false,
        maxLiveTokens: input.maxLiveTokens ?? null
      },
      pool: {
        query: async (sql: string) => {
          if (sql.includes("as active")) return { rows: [{ active: input.active[poll++] ?? 0 }] };
          return { rows: [] };
        }
      },
      cassette: {
        stats: () => stats(input.mode ?? "record", input.misses ?? 0, input.liveTokens ?? 0)
      },
      jobs: {
        wake: () => undefined,
        cancelBatch: async (id: string) => {
          canceled.push(id);
          return null;
        }
      },
      log: () => undefined,
      sleep: async () => undefined
    } as unknown as GoldenRunOptions;
    return { options, canceled, polls: () => poll };
  }

  it("settles after two polls without queued or running jobs", async () => {
    const { options, polls } = waitOptions({ active: [2, 1, 0, 1, 0, 0] });
    await mkdir(join(workspace, "run"));
    expect(await waitForBatch(options, "batch", join(workspace, "run"))).toBe("settled");
    expect(polls()).toBe(6);
  });

  it("stops a replay at its first cassette miss", async () => {
    const { options, canceled } = waitOptions({ active: [1], mode: "replay", misses: 1 });
    await mkdir(join(workspace, "run"));
    expect(await waitForBatch(options, "batch", join(workspace, "run"))).toBe("diverged");
    expect(canceled).toEqual(["batch"]);
  });

  it("ignores the live token limit in a replay, which never calls a provider", async () => {
    const { options, canceled } = waitOptions({
      active: [0, 0],
      mode: "replay",
      liveTokens: 900,
      maxLiveTokens: 500
    });
    await mkdir(join(workspace, "run"));
    expect(await waitForBatch(options, "batch", join(workspace, "run"))).toBe("settled");
    expect(canceled).toEqual([]);
  });

  it("stops at the live token limit", async () => {
    const { options, canceled } = waitOptions({ active: [1], liveTokens: 900, maxLiveTokens: 500 });
    await mkdir(join(workspace, "run"));
    expect(await waitForBatch(options, "batch", join(workspace, "run"))).toBe("token_limit");
    expect(canceled).toEqual(["batch"]);
  });
});

describe("golden summaries", () => {
  it("summarize stage outcomes and executed wall times", () => {
    const row = {
      sourceItemId: "s",
      stage: "summarization",
      status: "completed",
      attempts: 1,
      reused: false,
      wallMs: 1000,
      error: null
    };
    expect(
      summarizeStages([
        row,
        { ...row, wallMs: 3000, attempts: 2 },
        { ...row, reused: true, wallMs: 99 },
        { ...row, status: "failed", wallMs: null },
        { ...row, status: "waiting_for_review", wallMs: null }
      ])
    ).toEqual({
      summarization: {
        statuses: { completed: 3, failed: 1, "stalled:waiting_for_review": 1 },
        reused: 1,
        retried: 1,
        wallMs: { n: 2, p50: 2000, p95: 2900, max: 3000, total: 4000 }
      }
    });
    expect(distribution([])).toBeNull();
  });

  it("digest content independently of row order", () => {
    expect(contentDigest(["b", "a"])).toEqual(contentDigest(["a", "b"]));
    expect(contentDigest(["a"]).sha256).not.toBe(contentDigest(["a", "a"]).sha256);
    expect(contentDigest([])).toMatchObject({ count: 0 });
  });
});
