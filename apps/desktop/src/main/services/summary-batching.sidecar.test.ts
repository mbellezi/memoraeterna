import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  createSourceItemRepository,
  createSourceSummaryRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";

// Plan decision 28 on a real database: a book whose chapters' summaries exceed the active writer's
// window is summarized in batches, every call is on the summary's record, and a book that fits keeps
// the summary and the metadata it always had.

const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!sidecarInstalled)(
  "a book's summary sized by the writer's window (plan decision 28)",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager | undefined;
    let pool: PgPool | undefined;
    const db = () => pool!;

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-summary-batching-"));
      let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
      for (let attempt = 1; !connection; attempt += 1) {
        manager = new PostgresSidecarManager({
          binDir: sidecar.binDir,
          dataDir: join(workDir, `data-${attempt}`),
          database: "memora_summary_batching_test",
          user: "memora_summary_batching_test",
          password: `summary-batching-${randomUUID()}`,
          startupTimeoutMs: 30_000,
          shutdownTimeoutMs: 10_000
        });
        try {
          connection = await manager.start();
        } catch (error) {
          await manager.stop().catch(() => undefined);
          if (attempt >= 3) throw error;
        }
      }
      pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
      await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
        seedFolder: join(workspace, "packages/db/seed")
      });
    }, 120_000);

    afterAll(async () => {
      if (pool) await closePgPool(pool);
      await manager?.stop().catch(() => undefined);
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    /** A book with chapters whose summaries are `size` bytes, as an import leaves them. */
    const book = async (title: string, chapters: number, size: number) => {
      const root = await createSourceItemRepository(db()).create({ type: "Book", title });
      await db().query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, $4, $5)`,
        [randomUUID(), root.id, title, title, sha(title)]
      );
      for (let index = 1; index <= chapters; index += 1) {
        const chapter = await createSourceItemRepository(db()).create({
          type: "BookChapter",
          title: `Chapter ${index}`,
          parentSourceItemId: root.id
        });
        const summary = `Chapter ${index} argues point ${index}. ${"It builds on the chapters before. ".repeat(Math.ceil(size / 34))}`;
        await createSourceSummaryRepository(db()).create({
          sourceItemId: chapter.id,
          summary,
          provider: "test",
          model: "writer",
          runtime: "remote",
          promptVersion: "test",
          inputHash: sha(`in-${chapter.id}`),
          outputHash: sha(summary)
        });
      }
      return root;
    };

    /** A writer that answers each call with a short summary, on the record of its own AI run. */
    const writer = (capacity: {
      contextWindow: number | null;
      source: string;
      maxOutputTokens: number;
      local: boolean;
    }) => {
      const prompts: string[] = [];
      const runs: string[] = [];
      const runDefaultTask = vi.fn(async (_task: string, prompt: string) => {
        prompts.push(prompt);
        const id = randomUUID();
        await db().query(
          `insert into ai_task_runs (id, task_type, provider, model_id, runtime, duration_ms, status)
         values ($1, 'summarization', 'test', 'writer', 'remote', 1, 'succeeded')`,
          [id]
        );
        runs.push(id);
        return {
          output: `Summary ${prompts.length} of the book.`,
          providerId: "test",
          modelId: "writer",
          runtime: "remote",
          profileId: null,
          aiTaskRunId: id,
          outputLanguage: "en"
        };
      });
      const service = new KnowledgeService({
        getPool: () => db(),
        aiService: {
          taskRouteCapacity: async () => capacity,
          runDefaultTask
        } as unknown as AiService,
        userDataPath: "/tmp/memora-test",
        getStorageSettings: async () => ({}) as never,
        getUploadedFilesBasePath: async () => null
      });
      return { service, prompts, runs, runDefaultTask };
    };

    const current = async (rootId: string) =>
      (await createSourceSummaryRepository(db()).listBySourceItem(rootId)).find(
        (summary) => summary.isCurrent
      );

    it("summarizes a book larger than a small window in batches and records every call", async () => {
      const root = await book("Learning mechanisms", 6, 700);
      const small = {
        contextWindow: 4_096,
        source: "profile",
        maxOutputTokens: 1_024,
        local: true
      };
      const { service, prompts, runs } = writer(small);

      const result = await service.summarizeHierarchiesForBatch(null, undefined, {}, root.id, true);

      // Three pairs of chapters, then the one call over their three summaries.
      expect(prompts).toHaveLength(4);
      expect(prompts[3]).toContain("[Subpart 1: Chapter 1 – Chapter 2]");
      expect(prompts[3]).toContain("[Subpart 3: Chapter 5 – Chapter 6]");
      expect(result).toMatchObject({ generatedCount: 1, changedRootIds: [root.id] });
      const summary = await current(root.id);
      expect(summary?.summary).toBe("Summary 4 of the book.");
      expect(summary?.metadata).toMatchObject({
        aggregate: true,
        batched: { levels: 1, calls: 4, contextWindow: 4_096, windowSource: "profile" },
        aiTaskRunIds: runs
      });
      // The book's summary is the answer of the last call.
      expect(summary?.aiTaskRunId).toBe(runs[3]);
      expect((await createSourceItemRepository(db()).findById(root.id))?.summary).toBe(
        "Summary 4 of the book."
      );
    });

    it("keeps the summary and the metadata a book that fits one call always had", async () => {
      const root = await book("A short book", 3, 300);
      const codex = {
        contextWindow: 128_000,
        source: "planning",
        maxOutputTokens: 16_384,
        local: false
      };
      const { service, prompts, runs } = writer(codex);

      const result = await service.summarizeHierarchiesForBatch(null, undefined, {}, root.id, true);

      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("[Subpart 3: Chapter 3]");
      expect(result).toMatchObject({ generatedCount: 1, changedRootIds: [root.id] });
      const summary = await current(root.id);
      expect(summary?.aiTaskRunId).toBe(runs[0]);
      expect(Object.keys(summary!.metadata).toSorted()).toEqual(
        ["aggregate", "batchId", "childSummaryIds", "skippedSubpartCount"].toSorted()
      );
    });

    it("reuses a summary whose subparts did not change, and names no root changed", async () => {
      const root = await book("A reused book", 3, 300);
      const codex = {
        contextWindow: 128_000,
        source: "planning",
        maxOutputTokens: 16_384,
        local: false
      };
      const first = writer(codex);
      await first.service.summarizeHierarchiesForBatch(null, undefined, {}, root.id, false);
      const second = writer(codex);
      const result = await second.service.summarizeHierarchiesForBatch(
        null,
        undefined,
        {},
        root.id,
        false
      );
      expect(second.runDefaultTask).not.toHaveBeenCalled();
      expect(result).toMatchObject({ generatedCount: 0, reusedCount: 1, changedRootIds: [] });
    });
  }
);
