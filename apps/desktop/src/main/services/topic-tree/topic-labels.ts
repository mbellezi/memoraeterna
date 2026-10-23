// Topic label vectors (F2 T18): the `topic-label-embed` job embeds each named topic's label text
// ("title · aliases · description") in the tree's embedding space, and the topic cache attaches the
// stored vectors to the engine state so PLACE can mix label similarity into child scores
// (`placement.labelWeight`, 0 at first) and the gate can record it. A label whose text changed (a
// rename or a new description) is stale until it is embedded again; a vector made in another space
// is never stored under this tree's strategy. Labels are bookkeeping, not structure: they go to the
// embedding tables, never through a change-set.
import { createHash } from "node:crypto";

import { chunkTexts, embedManyLimits } from "@app/ai";
import { createTopicNamingRepository, createTopicTreeRepository } from "@app/db";
import type { JobRecord, JsonObject, PgPool, TopicLoadSpace } from "@app/db";
import { isBackgroundBlocked } from "@app/domain";
import { isLive, setTopicLabel, topicLabelText } from "@app/domain/topic-tree";
import type { TopicTreeState } from "@app/domain/topic-tree";

import { jobTaskPayload } from "../../job-task-payload.js";
import type { AiService, AiTaskLogContext } from "../ai-service.js";
import type { TopicAiBudget, TopicAiMode } from "./topic-ai.js";
import { TopicTreePayloadSchema, topicJobTypes } from "./topic-jobs.js";
import { topicLabelOperation } from "./topic-prompts.js";
import { treeSpace } from "./topic-space.js";
import type { TopicTriggers } from "./topic-triggers.js";

/** What label embedding needs of the AI service. */
export type LabelAi = Pick<AiService, "embedMany" | "activeEmbeddingSpace">;

export const topicLabelLimits = {
  /** Labels one job embeds; a job with more left asks for another. */
  perJob: 200
} as const;

/** The hash a stored label vector carries: SHA-256 of its label text. */
export function topicLabelHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Attaches the stored label vectors of the tree's space to the state's live topics. A vector whose
 * text hash no longer matches the topic's label text is stale and stays unattached. Labels are
 * optional bookkeeping: a failed read is logged and the state keeps no labels.
 */
export async function attachTopicLabels(
  pool: PgPool,
  space: TopicLoadSpace,
  state: TopicTreeState,
  logger?: Pick<Console, "warn">
): Promise<number> {
  try {
    const texts = new Map<string, string>();
    for (const node of state.topics.values()) {
      const text = isLive(node) ? topicLabelText(node) : null;
      if (text !== null) texts.set(node.id, text);
    }
    if (texts.size === 0) return 0;
    const stored = await createTopicNamingRepository(pool).loadTopicLabels(space, [
      ...texts.keys()
    ]);
    let attached = 0;
    for (const [id, text] of texts) {
      const label = stored.get(id);
      if (!label || label.textHash !== topicLabelHash(text)) continue;
      setTopicLabel(state, id, label);
      attached += 1;
    }
    return attached;
  } catch (error) {
    logger?.warn("Topic labels could not be attached", error);
    return 0;
  }
}

export interface TopicLabelOptions {
  getPool: () => PgPool | null;
  ai: LabelAi;
  budget: TopicAiBudget;
  aiMode: TopicAiMode;
  triggers: TopicTriggers;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/** A readable embedding: a list of finite numbers of the tree's dimension. */
function readVector(output: unknown, dimensions: number): number[] | null {
  if (!Array.isArray(output) || output.length !== dimensions) return null;
  return output.every((value) => typeof value === "number" && Number.isFinite(value))
    ? (output as number[])
    : null;
}

export class TopicLabelService {
  public constructor(private readonly options: TopicLabelOptions) {}

  public async runLabelEmbed(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const { treeId } = TopicTreePayloadSchema.parse(jobTaskPayload(job.payload));
    if (this.options.aiMode !== "full") return { status: "skipped", reason: "deterministic" };
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    const tree = await createTopicTreeRepository(pool).tree(treeId);
    if (!tree || tree.status !== "active") return { status: "tree_inactive", treeId };
    const space = treeSpace(tree);
    const repository = createTopicNamingRepository(pool);
    const { live, retired } = await repository.labelSources(treeId);
    // A retired topic keeps its ID as a redirect but needs no label.
    const removed = await repository.deleteTopicLabels(retired);

    const wanted = live.flatMap((topic) => {
      const text = topicLabelText(topic);
      return text === null ? [] : [{ id: topic.id, text, hash: topicLabelHash(text) }];
    });
    const stored = await repository.topicLabelHashes(
      space,
      wanted.map((entry) => entry.id)
    );
    const todo = wanted
      .filter((entry) => stored.get(entry.id) !== entry.hash)
      .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : a.id < b.id ? -1 : 1));
    const base = { treeId, labels: wanted.length, removed };
    if (todo.length === 0) return { status: "current", ...base };

    const route = await this.options.ai.activeEmbeddingSpace();
    if (!route) return { status: "no_route", pending: todo.length, ...base };
    if (route.spaceKey !== tree.spaceKey) {
      return { status: "space_changed", pending: todo.length, ...base };
    }

    let embedded = 0;
    let capReached = false;
    const context: AiTaskLogContext = {
      jobId: job.id,
      stage: "topic_labels",
      operation: topicLabelOperation,
      origin: "job",
      workloadClass: "embed",
      priority: "P3",
      budgetClass: "background",
      embeddingInputType: "document",
      sourceItemIds: []
    };
    // The labels go out in batches of at most 32 texts, one lane request each (F3 D37).
    batches: for (const group of chunkTexts(
      todo.slice(0, topicLabelLimits.perJob),
      embedManyLimits.perExecution
    )) {
      if (signal.aborted) throw new Error("topics.errors.canceled");
      // D34 bounds background AI that can cost money: a local embedding model costs none. A batch
      // reserves one call per label at once; at the cap, only as many labels as still fit go out.
      let entries = group;
      if (!route.local && !(await this.options.budget.reserve(group.length))) {
        entries = [];
        for (const entry of group) {
          if (!(await this.options.budget.reserve(1))) {
            capReached = true;
            break;
          }
          entries.push(entry);
        }
      }
      if (entries.length === 0) break;
      let result;
      try {
        result = await this.options.ai.embedMany(
          entries.map((entry) => entry.text),
          context,
          signal
        );
      } catch (error) {
        // A background refusal (F4 D7) ends the job; the supervisor sets it aside.
        if (signal.aborted || isBackgroundBlocked(error)) throw error;
        this.options.logger?.warn("Topic labels could not be embedded", error);
        break;
      }
      // A vector from another space is never stored under this tree's strategy.
      if (!result || result.embeddingSpaceKey !== tree.spaceKey) break;
      for (const [index, entry] of entries.entries()) {
        const vector = readVector(result.embeddings[index], tree.dimensions);
        if (!vector) break batches;
        await repository.upsertTopicLabel({
          topicId: entry.id,
          space,
          contentHash: entry.hash,
          embedding: vector
        });
        embedded += 1;
      }
      if (capReached) break;
    }
    const remaining = todo.length - embedded;
    if (remaining > 0 && !capReached && embedded > 0) {
      await this.options.triggers.request(topicJobTypes.labelEmbed, treeId);
    }
    return { status: "embedded", embedded, remaining, capReached, ...base };
  }
}
