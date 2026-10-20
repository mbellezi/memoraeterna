import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { PgPool } from "@app/db";
import {
  ConsultationInputSchema,
  SourceDescriptorSchema,
  isRelationUnrelated,
  isRelationVeto
} from "@app/domain";
import { z } from "zod";

import { fileImportInputSchema } from "../../../shared/ipc.js";
import type { AiService } from "../ai-service.js";
import type { ConsultationService } from "../consultation-service.js";
import type { IngestionService } from "../ingestion-service.js";
import type { KnowledgeService } from "../knowledge-service.js";
import type { RelationExplanationService } from "../relation-explanation-service.js";
import { SoakActionFailure, type ActionDetail, type SoakPorts } from "./soak-driver.js";
import type { LocalFaultController } from "./soak-local-faults.js";
import type { SoakProfile } from "./soak-plan.js";
import {
  countAnswerCalls,
  forgetExplanations,
  pickEditableNote,
  pickQuestionTitle,
  pickRelationsToExplain,
  readFailedJobs,
  readJobs,
  readTaskRuns
} from "./soak-queries.js";
import { NdjsonFile, soakFiles } from "./soak-records.js";

/**
 * The soak driver's ports on the app's real services (F3 T62): a public corpus article through the
 * ingestion service, an Ask through the consultation service, an explanation through the
 * relation-explanation service, a human note edit and a source deletion through the knowledge
 * service. Nothing here is a shortcut around a service; the driver sees only what a person's clicks
 * would reach. The SQL lives in `soak-queries.ts`.
 */

const run = promisify(execFile);

/** One article of the public Wikipedia corpus (`.cache/corpus/wikipedia/*.jsonl`). */
const corpusArticleSchema = z
  .object({
    lang: z.enum(["en", "pt"]),
    title: z.string().min(1),
    pageId: z.number().int(),
    revisionId: z.number().int(),
    revisionTimestamp: z.string(),
    url: z.string().url(),
    extract: z.string().min(1)
  })
  .passthrough();
export type CorpusArticle = z.infer<typeof corpusArticleSchema>;

/** Articles long enough to hold several notes and short enough to ingest in minutes. */
const articleLength = { min: 2_500, max: 40_000 };

/** The corpus in an order that depends on the seed only (a hash of the seed and the page). */
export function readCorpus(workspaceRoot: string, seed: number): CorpusArticle[] {
  const articles: CorpusArticle[] = [];
  for (const file of ["en.jsonl", "pt.jsonl"]) {
    const path = resolve(workspaceRoot, ".cache", "corpus", "wikipedia", file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const parsed = corpusArticleSchema.safeParse(JSON.parse(line));
      if (
        parsed.success &&
        parsed.data.extract.length >= articleLength.min &&
        parsed.data.extract.length <= articleLength.max
      )
        articles.push(parsed.data);
    }
  }
  const rank = (article: CorpusArticle) =>
    createHash("sha256").update(`${seed}:${article.lang}:${article.pageId}`).digest("hex");
  return articles.toSorted((a, b) => rank(a).localeCompare(rank(b)));
}

/** The Markdown file an article is imported from. */
export function articleMarkdown(article: CorpusArticle, revision = 0): string {
  const heading = (text: string) =>
    text.replace(
      /^(={2,6})\s*(.+?)\s*\1\s*$/gmu,
      (_m, marks: string, name: string) => `${"#".repeat(marks.length)} ${name}`
    );
  const body = heading(article.extract);
  return `# ${article.title}\n\n${body}\n${
    revision > 0
      ? `\n## Revision ${revision}\n\nThis section was added by the soak to make a new version of the article.\n`
      : ""
  }`;
}

/** The descriptor of a corpus article: a standalone article by the Wikipedia contributors. */
export function articleDescriptor(article: CorpusArticle) {
  return SourceDescriptorSchema.parse({
    type: "StandaloneArticle",
    title: article.title,
    language: article.lang === "pt" ? "pt-BR" : "en",
    creators: [{ name: "Wikipedia contributors", role: "author" }],
    publicationDate: article.revisionTimestamp.slice(0, 10)
  });
}

interface ImportedArticle {
  sourceItemId: string;
  file: string;
  lang: string;
  pageId: number;
  title: string;
  revision: number;
  deleted: boolean;
}

const pageSize = /page size of (\d+) bytes/u;

async function readVmStat(): Promise<{ pageouts: number; pageSize: number } | null> {
  try {
    const { stdout } = await run("/usr/bin/vm_stat");
    const pageouts = /Pageouts:\s+(\d+)/u.exec(stdout)?.[1];
    const size = pageSize.exec(stdout)?.[1];
    return pageouts && size ? { pageouts: Number(pageouts), pageSize: Number(size) } : null;
  } catch {
    return null;
  }
}

async function readRssMb(pid: number): Promise<number | null> {
  try {
    const { stdout } = await run("/bin/ps", ["-o", "rss=", "-p", String(pid)]);
    const kilobytes = Number(stdout.trim());
    return Number.isFinite(kilobytes) ? Math.round((kilobytes / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

export interface SoakPortsDeps {
  profile: SoakProfile;
  workspaceRoot: string;
  /** The run directory. */
  directory: string;
  pool: PgPool;
  ai: Pick<AiService, "laneSnapshots" | "mlxHelperStats">;
  ingestion: Pick<IngestionService, "importFile">;
  knowledge: Pick<KnowledgeService, "reviewNote" | "deleteSource">;
  consultation: Pick<ConsultationService, "ask">;
  explanations: Pick<RelationExplanationService, "explain">;
  faults: LocalFaultController;
  jobs: { wake(): void };
  logger?: Pick<Console, "info">;
  /** Kills a process; tests inject a recorder. */
  kill?: (pid: number) => void;
}

/** Builds the ports the driver plays on the app's services. */
export async function createSoakPorts(deps: SoakPortsDeps): Promise<SoakPorts> {
  const { profile, directory } = deps;
  const seed = profile.seed;
  const corpus = readCorpus(deps.workspaceRoot, seed);
  if (corpus.length === 0)
    throw new Error("The public corpus is missing: .cache/corpus/wikipedia/{en,pt}.jsonl");
  const articlesDirectory = join(directory, "articles");
  await mkdir(articlesDirectory, { recursive: true });
  const imported: ImportedArticle[] = [];
  const log = new NdjsonFile<ImportedArticle>(join(directory, "articles.ndjson"));
  let nextArticle = 0;
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();

  /** Writes the article's file and imports it as a new source; null when the corpus is used up. */
  async function importNext(
    revision = 0
  ): Promise<{ article: CorpusArticle; sourceItemId: string; duplicates: number } | null> {
    let duplicates = 0;
    while (nextArticle < corpus.length) {
      const article = corpus[nextArticle++]!;
      const file = join(articlesDirectory, `${article.lang}-${article.pageId}.md`);
      await writeFile(file, articleMarkdown(article, revision));
      const result = await deps.ingestion.importFile(
        file,
        fileImportInputSchema.parse({
          descriptor: articleDescriptor(article),
          duplicatePolicy: "ignore"
        })
      );
      if (!result || result.duplicate) {
        duplicates += 1;
        continue;
      }
      const record: ImportedArticle = {
        sourceItemId: result.sourceItemId,
        file,
        lang: article.lang,
        pageId: article.pageId,
        title: article.title,
        revision,
        deleted: false
      };
      imported.push(record);
      log.append(record);
      deps.jobs.wake();
      return { article, sourceItemId: result.sourceItemId, duplicates };
    }
    return null;
  }

  const answerOutcome = (error: unknown): string | null => {
    const text = error instanceof Error ? error.message : String(error);
    return /noRelevantEvidence|noTopicEvidence/u.test(text) ? "no_evidence" : null;
  };

  return {
    async importArticle() {
      const next = await importNext();
      if (!next) return { exhausted: true };
      return {
        title: next.article.title,
        language: next.article.lang,
        sourceItemId: next.sourceItemId,
        duplicatesSkipped: next.duplicates,
        imported: imported.length
      };
    },

    async importTypingFaultSource() {
      const next = await importNext();
      if (!next) return { exhausted: true };
      // Registered before the source's link job can type a pair: the import has only queued work.
      deps.faults.poison(next.sourceItemId);
      return {
        title: next.article.title,
        sourceItemId: next.sourceItemId,
        poisonedSources: deps.faults.poisonedSources.length
      };
    },

    async ask(index) {
      const title = await pickQuestionTitle(deps.pool, seed, index);
      if (title === null) return { outcome: "no_source" };
      const began = Date.now();
      try {
        const result = await deps.consultation.ask(
          ConsultationInputSchema.parse({
            requestId: randomUUID(),
            question: `What does the library say about ${title}?`,
            // Ask may use the remote route: the fake one, which is the answer class's route here.
            privacy: "allow_remote",
            mode: "text"
          })
        );
        return {
          outcome: "answered",
          paragraphs: result.answer.paragraphs.length,
          evidence: result.evidence.length,
          stale: result.coverage.stale
        };
      } catch (error) {
        const outcome = answerOutcome(error);
        if (outcome) return { outcome };
        // How long the Ask ran on the wall clock (the Ask itself counts only the time it works, not
        // the time it waits in the AI queue), and whether it reached its model at all (one that
        // spent its time preparing never calls it); unknown when the audit cannot be read.
        const wallMs = Date.now() - began;
        const calls = await countAnswerCalls(deps.pool, began).catch(() => null);
        throw new SoakActionFailure(
          error instanceof Error ? error.message : String(error),
          { wallMs, remoteCallStarted: calls === null ? null : calls > 0 },
          { cause: error }
        );
      }
    },

    async explain(count) {
      const picked = await pickRelationsToExplain(deps.pool, count, seed);
      const recycled = picked.filter((entry) => entry.explained).map((entry) => entry.id);
      // Fewer fresh relations than opens: forget the oldest answers so each open asks the writer.
      await forgetExplanations(deps.pool, recycled);
      const outcomes = await Promise.all(
        picked.map(async ({ id }) => {
          try {
            const outcome = await deps.explanations.explain(
              { relationId: id, requestId: randomUUID() },
              () => undefined
            );
            if (outcome === null) return "none";
            if (isRelationVeto(outcome)) return "vetoed";
            if (isRelationUnrelated(outcome)) return "unrelated";
            return "explained";
          } catch {
            return "failed";
          }
        })
      );
      const tally = (name: string) => outcomes.filter((outcome) => outcome === name).length;
      return {
        opened: picked.length,
        recycled: recycled.length,
        explained: tally("explained"),
        vetoed: tally("vetoed"),
        unrelated: tally("unrelated"),
        none: tally("none"),
        failed: tally("failed")
      };
    },

    async editNote(index) {
      const note = await pickEditableNote(deps.pool, seed, index);
      if (!note) return { outcome: "no_note" };
      const edited = await deps.knowledge.reviewNote({
        id: note.id,
        action: "edit",
        expectedUpdatedAt: note.updatedAt,
        bodyMarkdown: `${note.bodyMarkdown.trimEnd()}\n\nReviewed by hand.`
      });
      deps.jobs.wake();
      return { outcome: edited ? "edited" : "gone" };
    },

    async reimportSource(index) {
      // A new version of the oldest article still present, then the deletion of the next one.
      const present = imported.filter((entry) => !entry.deleted);
      const target = present[0];
      const doomed = present[1];
      const detail: ActionDetail = { candidates: present.length };
      if (target) {
        const article = corpus.find(
          (entry) => entry.lang === target.lang && entry.pageId === target.pageId
        );
        if (article) {
          target.revision += 1;
          await writeFile(target.file, articleMarkdown(article, target.revision));
          const result = await deps.ingestion.importFile(
            target.file,
            fileImportInputSchema.parse({
              descriptor: articleDescriptor(article),
              duplicatePolicy: "version"
            })
          );
          detail.versioned = result?.sourceItemId ?? null;
          detail.versionDuplicate = result?.duplicate ?? null;
        }
      }
      if (doomed) {
        const removed = await deps.knowledge.deleteSource(doomed.sourceItemId);
        doomed.deleted = true;
        detail.deleted = doomed.sourceItemId;
        detail.deletedOk = removed !== null && removed !== undefined;
      }
      deps.jobs.wake();
      detail.index = index;
      return detail;
    },

    async killMlxHelper() {
      const stats = deps.ai.mlxHelperStats();
      const pid = stats?.pid;
      if (pid === undefined) return { killed: false, detail: { reason: "no helper running" } };
      (deps.kill ?? ((target) => process.kill(target, "SIGKILL")))(pid);
      return { killed: true, detail: { pid, spawnCountBefore: stats!.spawnCount } };
    },

    async armGgufAbort() {
      deps.faults.armGgufAbort();
      return { stage: "armed" };
    },

    async sample() {
      const [jobs, vm] = await Promise.all([readJobs(deps.pool), readVmStat()]);
      const helper = deps.ai.mlxHelperStats();
      const loop = lag.count > 0 ? Math.round((lag.percentile(99) / 1e6) * 10) / 10 : null;
      lag.reset();
      return {
        lanes: deps.ai.laneSnapshots().map((lane) => ({
          lane: lane.lane,
          limit: lane.limit,
          running: lane.running,
          held: lane.held,
          waiting: { ...lane.waiting },
          rateLimits: lane.rateLimits,
          breaker: lane.breaker?.state ?? null
        })),
        jobs: jobs.jobs,
        jobCounts: jobs.counts,
        helper: helper
          ? {
              pid: helper.pid ?? null,
              rssMb: helper.pid === undefined ? null : await readRssMb(helper.pid),
              spawnCount: helper.spawnCount
            }
          : null,
        appRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
        pageouts: vm?.pageouts ?? null,
        pageSizeBytes: vm?.pageSize ?? null,
        eventLoopLagP99Ms: loop,
        dbPool: {
          total: deps.pool.totalCount,
          idle: deps.pool.idleCount,
          waiting: deps.pool.waitingCount
        }
      };
    },

    taskRuns: (sinceMs) => readTaskRuns(deps.pool, sinceMs),

    failedJobs: (sinceMs) => readFailedJobs(deps.pool, sinceMs),

    stopRequested: async () => existsSync(join(directory, soakFiles.stop))
  };
}
