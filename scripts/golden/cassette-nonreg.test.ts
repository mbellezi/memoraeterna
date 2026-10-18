import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiCassette,
  AiCassetteMissError,
  type AiModelAdapter,
  type AiModelDescriptor
} from "@app/ai";
import type { AiTaskRequest, AiTaskResult } from "@app/ai";
import { promptDefinition, promptDefinitions } from "@app/domain";

import {
  MATCHING_RULES,
  NonRegressionError,
  classifyCassetteEntry,
  createNonRegressionCassette,
  nonRegressionFileName,
  nonRegressionRuleVersion,
  promptBody,
  rankInstruction,
  renderNonRegressionReport,
  runCassetteNonRegression
} from "./cassette-nonreg.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const preamble =
  "Produce all natural-language response text in Brazilian Portuguese. Preserve required JSON keys and schemas exactly. All internal identifiers, enum values and relation predicates must remain in English; translate only user-visible natural-language content.";

const generative = (body: string) => `${preamble}\n\n${body}`;
const rankRequest = (instruction: string) =>
  JSON.stringify({ instruction, query: "Title: A\nIdea: B", documents: ["Topic: T"] });

interface SyntheticEntry {
  label: string;
  taskType: string;
  input: unknown;
  runtime?: "remote" | "local";
  providerId?: string;
}

function entryFile(entry: SyntheticEntry) {
  const runtime = entry.runtime ?? "remote";
  const providerId = entry.providerId ?? (runtime === "remote" ? "openai-codex" : "local-mlx");
  return {
    format: "memora-ai-cassette-entry",
    version: 1,
    key: sha(entry.label),
    taskType: entry.taskType,
    request: {
      input: entry.input,
      instruction: null,
      model: { providerId, modelId: "m", runtime },
      parameters: {},
      schema: null,
      taskType: entry.taskType,
      version: 1
    },
    responses: [
      {
        output: "ok",
        providerId,
        modelId: "m",
        runtime,
        durationMs: 1,
        recordedAt: "2026-10-16T00:00:00.000Z"
      }
    ]
  };
}

const manifest = {
  format: "memora-ai-cassette",
  version: 1,
  createdAt: "2026-10-16T00:00:00.000Z"
};

async function writeCassette(
  directory: string,
  entries: readonly SyntheticEntry[],
  extras: Record<string, string> = {}
) {
  await mkdir(join(directory, "entries"), { recursive: true });
  await writeFile(join(directory, "cassette.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, content] of Object.entries(extras)) {
    await mkdir(join(directory, name, ".."), { recursive: true });
    await writeFile(join(directory, name), content);
  }
  for (const entry of entries) {
    const file = entryFile(entry);
    await mkdir(join(directory, "entries", file.key.slice(0, 2)), { recursive: true });
    await writeFile(
      join(directory, "entries", file.key.slice(0, 2), `${file.key}.json`),
      `${JSON.stringify(file)}\n`
    );
  }
}

/** Every file below a folder with its bytes: a snapshot to prove a base was not touched. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (current: string) => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const path = join(current, item.name);
      if (item.isDirectory()) await walk(path);
      else result[path.slice(directory.length)] = sha(await readFile(path, "utf8"));
    }
  };
  await walk(directory);
  return result;
}

const noteDecide = (label = "decide") => ({
  label,
  taskType: "reranking",
  input: generative(
    "Decide whether the source atomic note has a meaningful knowledge relationship with each candidate.\nSource note: x"
  )
});

/** One entry of every kind a golden or E6 cassette holds. */
const library: SyntheticEntry[] = [
  noteDecide("note-decide-codex"),
  { ...noteDecide("note-decide-local"), runtime: "local", providerId: "local-mlx" },
  {
    label: "note-decide-old-wording",
    taskType: "reranking",
    input: generative(
      "Evaluate whether the source atomic note has a meaningful knowledge relationship"
    )
  },
  {
    label: "note-decide-ranker",
    taskType: "reranking",
    runtime: "local",
    input: rankRequest(
      "Given a note (Query), decide whether the Document note makes a claim about the same underlying mechanism."
    )
  },
  {
    label: "source-judge",
    taskType: "reranking",
    input: generative("Decide which durable, important conceptual relationships connect ideas.")
  },
  {
    label: "source-judge-old-wording",
    taskType: "reranking",
    input: generative("Identify durable, important conceptual relationships between ideas.")
  },
  {
    label: "relation-typing",
    taskType: "structured-output",
    input: generative(
      "Classify how each pair of atomic notes is related, using only the two notes."
    )
  },
  {
    label: "relation-typing-repair",
    taskType: "structured-output",
    input: generative(
      "Classify how each pair of atomic notes is related, using only the two notes.\n\nThe previous answer was missing or invalid for some of the pairs listed above."
    )
  },
  { label: "embedding", taskType: "embedding", input: "Concept: AIC", runtime: "local" },
  { label: "summary", taskType: "summarization", input: generative("Summarize this source.") },
  {
    label: "notes",
    taskType: "atomic-note-generation",
    input: generative("Generate independent atomic knowledge notes from the source below.")
  },
  {
    label: "graph",
    taskType: "knowledge-graph-generation",
    input: generative(
      "Match directed relation types only when their FULL meanings are interchangeable."
    )
  },
  {
    label: "topic-name",
    taskType: "structured-output",
    input: generative(
      'Name the numbered topics of a personal knowledge library. Everything under "Topics"'
    )
  },
  {
    label: "topic-gate",
    taskType: "reranking",
    runtime: "local",
    input: rankRequest("Given a note, retrieve the topic it belongs to: the topic whose subject.")
  },
  {
    label: "topic-support",
    taskType: "reranking",
    runtime: "local",
    input: rankRequest("Given a sentence from a summary, retrieve the passage that states it.")
  }
];

let workspace = "";
let base = "";
let out = "";

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-nonreg-"));
  base = join(workspace, ".cache", "cassettes", "base");
  out = join(workspace, ".cache", "cassettes", "base-nonreg-R");
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("the non-regression rule", () => {
  it("reads the prompt after the output-language paragraph, and a ranker's instruction", () => {
    expect(promptBody(generative("Decide whether x"))).toBe("Decide whether x");
    expect(promptBody("Decide whether x")).toBe("Decide whether x");
    expect(promptBody(`  ${preamble}`)).toBe("");
    expect(rankInstruction(rankRequest("Given a note"))).toBe("Given a note");
    expect(rankInstruction("Decide whether x")).toBeNull();
    expect(rankInstruction('{"instruction":"x"}')).toBeNull();
    expect(rankInstruction("{broken")).toBeNull();
    expect(rankInstruction("[1]")).toBeNull();
  });

  it("strips every matching prompt wherever it was recorded, and keeps everything else", () => {
    const kinds = Object.fromEntries(
      library.map((entry) => {
        const { kind, matching, recognized } = classifyCassetteEntry({
          taskType: entry.taskType,
          request: { input: entry.input }
        });
        return [entry.label, `${matching ? "strip" : "keep"} ${kind}${recognized ? "" : " ?"}`];
      })
    );
    expect(kinds).toEqual({
      "note-decide-codex": "strip note-decide",
      "note-decide-local": "strip note-decide",
      "note-decide-old-wording": "strip note-decide",
      "note-decide-ranker": "strip note-decide-ranker",
      "source-judge": "strip source-judge",
      "source-judge-old-wording": "strip source-judge",
      "relation-typing": "strip relation-typing",
      "relation-typing-repair": "strip relation-typing",
      embedding: "keep embedding",
      summary: "keep summarization",
      notes: "keep atomic-note-generation",
      graph: "keep knowledge-graph-generation",
      "topic-name": "keep topic-name",
      "topic-gate": "keep topic-gate-rank",
      "topic-support": "keep topic-support-rank"
    });
  });

  it("keeps an entry it cannot name and says so", () => {
    expect(
      classifyCassetteEntry({
        taskType: "reranking",
        request: { input: generative("Rank these.") }
      })
    ).toEqual({ kind: "other:reranking", matching: false, recognized: false });
    expect(classifyCassetteEntry({ taskType: "text-generation", request: { input: 42 } })).toEqual({
      kind: "other:text-generation",
      matching: false,
      recognized: false
    });
  });

  it("is pinned to the shipped prompt catalog: a rewrite of a matching prompt fails here first", () => {
    const body = (id: string) =>
      promptDefinition(id).fields.find((field) => field.id === "body")!.template;
    const rankerIds = new Set([
      "relations.decide.instruction",
      "topic.gate.instruction",
      "topic.overview.support"
    ]);
    const classified = (id: string) => {
      const input = rankerIds.has(id) ? rankRequest(body(id)) : generative(body(id));
      return classifyCassetteEntry({
        taskType: promptDefinition(id).task,
        request: { input }
      });
    };
    expect(
      promptDefinitions
        .filter((definition) => classified(definition.id).matching)
        .map((definition) => `${definition.id} ${classified(definition.id).kind}`)
        .sort()
    ).toEqual([
      "notes.match note-decide",
      "relations.decide.instruction note-decide-ranker",
      "relations.type relation-typing",
      "sources.decide source-judge"
    ]);
    // A repair prompt is appended to the prompt it repairs, so it leaves with it.
    for (const [id, repair] of [
      ["relations.type", "relations.type.repair"],
      ["sources.decide", "sources.decide.repair"]
    ] as const)
      expect(
        classifyCassetteEntry({
          taskType: promptDefinition(id).task,
          request: { input: generative(`${body(id)}${body(repair)}`) }
        }).matching,
        repair
      ).toBe(true);
    // The topic and explanation prompts are never taken for matching ones.
    expect(
      Object.fromEntries(
        [
          "topic.name",
          "topic.areas",
          "topic.overview",
          "topic.gate.instruction",
          "topic.overview.support",
          "relations.explain",
          "relations.sources.explain"
        ].map((id) => [id, classified(id).kind])
      )
    ).toEqual({
      "topic.name": "topic-name",
      "topic.areas": "topic-areas",
      "topic.overview": "topic-overview",
      "topic.gate.instruction": "topic-gate-rank",
      "topic.overview.support": "topic-support-rank",
      "relations.explain": "explanation",
      "relations.sources.explain": "explanation"
    });
    // Extraction is kept by its task type.
    for (const id of [
      "summary.short",
      "notes.extract",
      "graph.atomic_notes",
      "graph.entity_identity"
    ])
      expect(classified(id), id).toMatchObject({ matching: false, recognized: true });
    expect(MATCHING_RULES.map((rule) => rule.kind)).toEqual([
      "note-decide",
      "note-decide-ranker",
      "source-judge",
      "relation-typing"
    ]);
  });
});

describe("the non-regression copy", () => {
  it("copies the kept entries and the base's files, drops the matching ones and records the counts", async () => {
    await writeCassette(base, library, {
      "e2e-route.json": '{"format":"memora-topics-e2e-route"}\n',
      "misses/abc.json": "{}"
    });
    const before = await snapshot(base);
    const report = await createNonRegressionCassette({
      base,
      out,
      workspaceRoot: workspace,
      strict: true,
      now: () => new Date("2026-10-18T10:00:00.000Z")
    });
    expect(report).toMatchObject({
      format: "memora-cassette-nonreg",
      rule: nonRegressionRuleVersion,
      createdAt: "2026-10-18T10:00:00.000Z",
      base,
      baseCreatedAt: manifest.createdAt,
      entries: { base: 15, kept: 7, stripped: 8 },
      stripped: {
        "note-decide": 3,
        "note-decide-ranker": 1,
        "relation-typing": 2,
        "source-judge": 2
      },
      unrecognized: {},
      carried: ["cassette.json", "e2e-route.json"]
    });
    expect(report.kept).toEqual({
      "atomic-note-generation": 1,
      embedding: 1,
      "knowledge-graph-generation": 1,
      summarization: 1,
      "topic-gate-rank": 1,
      "topic-name": 1,
      "topic-support-rank": 1
    });

    // The copy: kept entries byte for byte, nothing stripped, the route and manifest, no misses folder.
    const copy = await snapshot(out);
    const kept = Object.entries(before).filter(([path]) => {
      if (!path.startsWith("/entries/"))
        return path === "/cassette.json" || path === "/e2e-route.json";
      return library.some(
        (entry) =>
          sha(entry.label) === path.slice(-69, -5) &&
          !classifyCassetteEntry({ taskType: entry.taskType, request: { input: entry.input } })
            .matching
      );
    });
    expect({ ...copy, [`/${nonRegressionFileName}`]: undefined }).toEqual({
      ...Object.fromEntries(kept),
      [`/${nonRegressionFileName}`]: undefined
    });
    expect(Object.keys(copy).filter((path) => path.startsWith("/entries/"))).toHaveLength(7);
    expect(existsSync(join(out, "misses"))).toBe(false);

    // The provenance in the copy is the report.
    expect(JSON.parse(await readFile(join(out, nonRegressionFileName), "utf8"))).toEqual(report);
    // The base is untouched, and no partial copy is left beside the copy.
    expect(await snapshot(base)).toEqual(before);
    expect((await readdir(join(workspace, ".cache", "cassettes"))).sort()).toEqual([
      "base",
      "base-nonreg-R"
    ]);
    const text = renderNonRegressionReport(report, out);
    expect(text).toContain("rule matching-strip-v1");
    expect(text).toMatch(/note-decide\s+0\s+3/u);
    expect(text).toMatch(/total\s+7\s+8/u);
  });

  it("counts without writing under --dry-run", async () => {
    await writeCassette(base, library);
    const report = await createNonRegressionCassette({
      base,
      out,
      workspaceRoot: workspace,
      dryRun: true
    });
    expect(report.entries).toEqual({ base: 15, kept: 7, stripped: 8 });
    expect(existsSync(out)).toBe(false);
  });

  it("runs from the command line and prints the table, or the report as JSON", async () => {
    await writeCassette(base, library);
    const printed = await runCassetteNonRegression([
      "--base",
      base,
      "--out",
      out,
      "--workspace-root",
      workspace,
      "--strict"
    ]);
    expect(printed).toContain(`copy: ${out}`);
    expect(existsSync(join(out, nonRegressionFileName))).toBe(true);
    const json = await runCassetteNonRegression([
      "--base",
      base,
      "--out",
      `${out}-2`,
      "--workspace-root",
      workspace,
      "--json"
    ]);
    expect(JSON.parse(json)).toMatchObject({
      rule: nonRegressionRuleVersion,
      entries: { stripped: 8 }
    });
    await expect(runCassetteNonRegression(["--base", base])).rejects.toThrow(/required/u);
    expect(await runCassetteNonRegression(["--help"])).toContain("--strict");
  });

  it("refuses a target that exists, the base itself, and a target inside the base", async () => {
    await writeCassette(base, library);
    const run = (target: string, source = base) =>
      createNonRegressionCassette({ base: source, out: target, workspaceRoot: workspace });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "keep.txt"), "mine");
    await expect(run(out)).rejects.toBeInstanceOf(NonRegressionError);
    await expect(run(out)).rejects.toThrow(/already exists/u);
    expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("mine");
    await expect(run(base)).rejects.toThrow(/already exists/u);
    // A base reached through a symlink is still the base.
    const alias = join(workspace, ".cache", "cassettes", "alias");
    await symlink(base, alias);
    await expect(run(join(alias, "inner"))).rejects.toThrow(/same folder or one holds the other/u);
    await expect(run(join(base, "inner"))).rejects.toThrow(/same folder or one holds the other/u);
    await expect(run(join(workspace, ".cache", "cassettes"), alias)).rejects.toThrow(
      /already exists/u
    );
    await expect(run(join(workspace, ".cache", "x"), join(workspace, ".cache"))).rejects.toThrow(
      /inside .*\.cache/u
    );
  });

  it("keeps both folders inside the workspace .cache", async () => {
    await writeCassette(base, library);
    const elsewhere = join(workspace, "elsewhere");
    await expect(
      createNonRegressionCassette({ base, out: elsewhere, workspaceRoot: workspace })
    ).rejects.toThrow(/--out must be a folder inside/u);
    await writeCassette(join(workspace, "other-base"), library);
    await expect(
      createNonRegressionCassette({
        base: join(workspace, "other-base"),
        out,
        workspaceRoot: workspace
      })
    ).rejects.toThrow(/--base must be a folder inside/u);
    expect(existsSync(elsewhere)).toBe(false);
  });

  it("leaves nothing behind for a base it cannot read as a cassette", async () => {
    const refused = async (message: RegExp) => {
      await expect(
        createNonRegressionCassette({ base, out, workspaceRoot: workspace })
      ).rejects.toThrow(message);
      expect(existsSync(out)).toBe(false);
      expect(
        (await readdir(join(workspace, ".cache", "cassettes"))).filter((name) => name !== "base")
      ).toEqual([]);
    };
    await mkdir(base, { recursive: true });
    await refused(/not an AI cassette/u);
    await writeCassette(base, library);
    // An entry that is not valid JSON.
    const victim = join(base, "entries", sha("embedding").slice(0, 2), `${sha("embedding")}.json`);
    await writeFile(victim, "{not json");
    await refused(/not a valid cassette entry/u);
    // An entry that holds another key than its name.
    await writeFile(
      victim,
      `${JSON.stringify({ ...entryFile({ label: "x", taskType: "embedding", input: "t" }) })}\n`
    );
    await refused(/not the one it is named by/u);
    // A stray file among the entries, and a folder the rule does not know.
    await writeCassette(base, library);
    await writeFile(join(base, "entries", sha("embedding").slice(0, 2), "stray.tmp"), "x");
    await refused(/not an entry file/u);
    await rm(join(base, "entries", sha("embedding").slice(0, 2), "stray.tmp"));
    await mkdir(join(base, "backup"));
    await refused(/neither a file, entries\/ nor misses\//u);
  });

  it("refuses under --strict when an entry fits no known kind, before it writes anything", async () => {
    await writeCassette(base, [
      ...library,
      { label: "unknown", taskType: "reranking", input: generative("Rank these.") }
    ]);
    await expect(
      createNonRegressionCassette({ base, out, workspaceRoot: workspace, strict: true })
    ).rejects.toThrow(/1 other:reranking fit no rule/u);
    expect(existsSync(out)).toBe(false);
    const report = await createNonRegressionCassette({ base, out, workspaceRoot: workspace });
    expect(report.unrecognized).toEqual({ "other:reranking": 1 });
    expect(report.entries).toEqual({ base: 16, kept: 8, stripped: 8 });
  });
});

describe("a replay on the copy", () => {
  const descriptor = (runtime: "remote" | "local"): AiModelDescriptor => ({
    providerId: runtime === "remote" ? "openai-codex" : "local-mlx",
    modelId: "m",
    runtime,
    capabilities: ["reranking", "embedding"],
    parameterCapabilities: {},
    limits: {},
    requirements: {}
  });
  class Fake implements AiModelAdapter {
    public calls = 0;
    public constructor(private readonly runtime: "remote" | "local") {}
    public describe() {
      return descriptor(this.runtime);
    }
    public canHandle() {
      return true;
    }
    public async run(request: AiTaskRequest): Promise<AiTaskResult> {
      this.calls += 1;
      return {
        taskType: request.taskType,
        output: request.taskType === "embedding" ? [0.5, 0.25] : "live answer",
        providerId: this.describe().providerId,
        modelId: "m",
        runtime: this.runtime,
        durationMs: 3
      };
    }
  }
  const embed = (text: string): AiTaskRequest => ({
    taskType: "embedding",
    input: text,
    modelId: "m",
    requiredCapabilities: [],
    parameters: {},
    metadata: {}
  });
  const decide = (text: string): AiTaskRequest => ({
    taskType: "reranking",
    input: generative(
      `Decide whether the source atomic note has a meaningful knowledge relationship with each candidate.\n${text}`
    ),
    modelId: "m",
    requiredCapabilities: [],
    parameters: {},
    metadata: {}
  });

  it("serves what was kept, fails a remote decide and runs a local one live, counted by task", async () => {
    for (const runtime of ["remote", "local"] as const) {
      const recorded = join(workspace, ".cache", "cassettes", `recorded-${runtime}`);
      const recording = new AiCassette({ mode: "record", directory: recorded });
      const adapter = recording.wrap(new Fake(runtime));
      await adapter.run(embed("Concept: AIC"));
      await adapter.run(decide("Source note: x"));
      const copy = join(workspace, ".cache", "cassettes", `copy-${runtime}`);
      const report = await createNonRegressionCassette({
        base: recorded,
        out: copy,
        workspaceRoot: workspace,
        strict: true
      });
      expect(report.entries).toEqual({ base: 2, kept: 1, stripped: 1 });

      const replay = new AiCassette({
        mode: "replay",
        directory: copy,
        ...(runtime === "local" ? { localMisses: "live" as const } : {})
      });
      const live = new Fake(runtime);
      const wrapped = replay.wrap(live);
      expect((await wrapped.run(embed("Concept: AIC"))).output).toEqual([0.5, 0.25]);
      if (runtime === "remote") {
        await expect(wrapped.run(decide("Source note: x"))).rejects.toBeInstanceOf(
          AiCassetteMissError
        );
        expect(live.calls).toBe(0);
        expect(replay.stats()).toMatchObject({ served: 1, misses: 1, liveLocalMisses: 0 });
        expect(replay.stats().byTask.reranking).toMatchObject({ misses: 1 });
      } else {
        expect((await wrapped.run(decide("Source note: x"))).output).toBe("live answer");
        expect(live.calls).toBe(1);
        expect(replay.stats()).toMatchObject({ served: 1, misses: 0, liveLocalMisses: 1 });
        expect(replay.stats().byTask.reranking).toMatchObject({ liveLocalMisses: 1, misses: 0 });
      }
      // The base cassette never learned what the copy's replay did.
      expect(existsSync(join(recorded, "misses"))).toBe(false);
    }
  });
});
