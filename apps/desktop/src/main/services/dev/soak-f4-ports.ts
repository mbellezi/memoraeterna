import { createJobRepository, type PgPool } from "@app/db";
import { relationsConfig, type BudgetSnapshot } from "@app/domain";

import { GardenerStatusSnapshotSchema } from "../../../shared/app-events.js";
import type { KnowledgeService } from "../knowledge-service.js";
import { SoakActionFailure, type ActionDetail, type SoakPorts } from "./soak-driver.js";
import { readLoad, type LoadReaderOptions } from "./soak-load.js";
import { withWaveMarker } from "./soak-e1.js";
import {
  pickEditableNoteInRoot,
  pickNotesForEditWave,
  pickNotesToReembed,
  pickTopicToOpen,
  readE1Extras,
  readFinishedJobs,
  readLockWaits,
  readOutcomeChanges,
  relationSourceNotes
} from "./soak-queries.js";
import type { SoakSample } from "./soak-records.js";
import type { CapSnapshot } from "./soak-token-cap.js";
import { deriveWorkerStates } from "./soak-workers.js";

/**
 * The F4 part of the soak driver's ports (T89): the actions the 7-day profile adds (a topic page
 * opened, a contention burst with its six edits, the Note page an explanation is opened from) and
 * what the collector reads beside F3's sample
 * (the status sentence, each worker's state, the harness cap, the budget's meters, the controls,
 * the power reading, locks being waited on, the machine's load), and the job and outcome ledgers
 * E2 and E3 are computed from. Nothing here reaches around a service: a topic is opened through the
 * topic overview service, a note edited through the knowledge service, the audit requested through
 * the topic triggers, a re-embedding queued as the product queues one.
 */

export interface SoakF4PortsDeps {
  pool: PgPool;
  seed: number;
  knowledge: Pick<KnowledgeService, "reviewNote">;
  /** `topics.overview`: the overview written or patched when the topic page opens (P0). */
  topicOverview(topicId: string): Promise<unknown>;
  /** The view history entry a page open records (`REFRESH` reads the open count). */
  recordTopicView(input: { id: string; title: string }): Promise<unknown>;
  /**
   * The view history entry a Note page records before its relation cards show (T84: the
   * explanation backfill's daily pass reads the notes opened in the last days).
   */
  recordNoteView(input: { id: string; title: string }): Promise<unknown>;
  /** Asks the topic engine for an audit pass of the tree now. */
  requestAudit(treeId: string): Promise<unknown>;
  jobs: { wake(): void };
  /** The Gardener's status sentence (T86); null when the app has none (the run is refused earlier). */
  status: { snapshot(): unknown } | null;
  controls: {
    current(): {
      autonomy: string;
      paused: boolean;
      onlyIdle: boolean;
      onlyOnAc: boolean;
      monthlyCapUsd: number;
    };
  };
  power: { snapshot(): { active: boolean; onBattery: boolean; overridden: boolean } };
  budget: { snapshot(): Promise<BudgetSnapshot> };
  cap: { snapshot(): CapSnapshot };
  /** The dedicated E1 run (D38b): the sample also reads the database size, the D26 counter and the change-sets. */
  e1?: boolean;
  now?: () => number;
  load?: LoadReaderOptions;
}

/** The slots of each job worker: one each, the relations pool aside. */
export const workerCapacity = (): Record<string, number> => ({
  heavy: 1,
  compute: 1,
  model: 1,
  relations: relationsConfig.link.poolSize
});

const failureText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 300);

type F4Ports = Pick<
  SoakPorts,
  "openTopic" | "contentionBurst" | "editBurstNote" | "editWave" | "finishedJobs" | "outcomeChanges"
> & {
  /** What the sample holds beyond F3's, from the jobs and lanes it already read. */
  sampleDetail(base: Pick<SoakSample, "jobs" | "lanes">): Promise<Partial<SoakSample>>;
  /**
   * The Note pages an explanation open starts from: each relation's source note recorded once in
   * the view history, as the page records it. Returns how many notes were recorded.
   */
  openNotePages(relationIds: readonly string[]): Promise<number>;
};

export function createF4Ports(deps: SoakF4PortsDeps): F4Ports {
  const now = deps.now ?? Date.now;
  const { pool, seed } = deps;
  return {
    async openTopic(index): Promise<ActionDetail> {
      const topic = await pickTopicToOpen(pool, seed, index);
      if (!topic) return { outcome: "no_topic" };
      const began = now();
      try {
        // The page records the open in the view history, then asks for the overview.
        await deps.recordTopicView({ id: topic.id, title: topic.title.slice(0, 300) });
        const state = (await deps.topicOverview(topic.id)) as { status?: unknown } | null;
        return {
          outcome: "opened",
          hadOverview: topic.hasOverview,
          status: typeof state?.status === "string" ? state.status : null,
          ms: now() - began
        };
      } catch (error) {
        throw new SoakActionFailure(
          failureText(error),
          { hadOverview: topic.hasOverview, ms: now() - began },
          { cause: error }
        );
      }
    },

    async openNotePages(relationIds) {
      const notes = await relationSourceNotes(pool, relationIds);
      for (const note of notes)
        await deps.recordNoteView({ id: note.id, title: note.title.slice(0, 300) });
      return notes.length;
    },

    async contentionBurst(index, reembeds): Promise<ActionDetail> {
      const tree = await pool.query<{ id: string }>(
        "select id::text as id from topic_trees where status = 'active' limit 1"
      );
      const treeId = tree.rows[0]?.id;
      let auditRequested = false;
      if (treeId) {
        await deps.requestAudit(treeId);
        auditRequested = true;
      }
      // Notes embedded again, as a stale-embedding repair queues them (AUDIT, D19).
      const notes = await pickNotesToReembed(pool, seed, index, reembeds);
      const jobs = createJobRepository(pool);
      let queued = 0;
      for (const note of notes) if (await jobs.enqueueNoteEmbedding(note)) queued += 1;
      deps.jobs.wake();
      return { auditRequested, reembedsPicked: notes.length, reembedsQueued: queued };
    },

    async editWave(index, spec): Promise<ActionDetail> {
      const began = now();
      const notes = await pickNotesForEditWave(pool, seed, index, spec.notes, spec.order);
      const tally = { edited: 0, conflicts: 0, gone: 0, errors: 0 };
      let firstError: string | null = null;
      for (const [position, note] of notes.entries()) {
        try {
          const edited = await deps.knowledge.reviewNote({
            id: note.id,
            action: "edit",
            expectedUpdatedAt: note.updatedAt,
            bodyMarkdown: withWaveMarker(note.bodyMarkdown, index)
          });
          if (edited) tally.edited += 1;
          else tally.gone += 1;
        } catch (error) {
          // A note a person (or the product) changed since the pick: the edit is refused, counted.
          if (error instanceof Error && error.message === "sourceWorkspace.conflict")
            tally.conflicts += 1;
          else {
            tally.errors += 1;
            firstError ??= failureText(error);
          }
        }
        // The supervisor hears of the new embedding jobs as the wave goes.
        if ((position + 1) % 50 === 0) deps.jobs.wake();
      }
      deps.jobs.wake();
      const detail: ActionDetail = {
        picked: notes.length,
        ...tally,
        roots: new Set(notes.map((note) => note.rootId)).size,
        order: spec.order,
        issueMs: now() - began
      };
      if (tally.errors > 0) throw new SoakActionFailure(firstError ?? "edit failed", detail);
      return detail;
    },

    async editBurstNote(index, rootIndex): Promise<ActionDetail> {
      const note = await pickEditableNoteInRoot(pool, seed, index, rootIndex);
      if (!note) return { outcome: "no_note", rootIndex };
      const edited = await deps.knowledge.reviewNote({
        id: note.id,
        action: "edit",
        expectedUpdatedAt: note.updatedAt,
        bodyMarkdown: `${note.bodyMarkdown.trimEnd()}\n\nReviewed by hand in a burst.`
      });
      deps.jobs.wake();
      return { outcome: edited ? "edited" : "gone", rootIndex };
    },

    finishedJobs: (sinceMs) => readFinishedJobs(pool, sinceMs),
    outcomeChanges: (sinceMs) => readOutcomeChanges(pool, sinceMs),

    async sampleDetail(base): Promise<Partial<SoakSample>> {
      const at = now();
      const settle = async <T>(work: () => Promise<T> | T): Promise<T | null> => {
        try {
          return await work();
        } catch {
          return null;
        }
      };
      const [status, budget, lockWaits, load, extras] = await Promise.all([
        settle(() => deps.status?.snapshot() ?? null),
        settle(() => deps.budget.snapshot()),
        settle(() => readLockWaits(pool)),
        settle(() => readLoad(deps.load)),
        // The dedicated E1 run's ledger (D38b): database size, the D26 counter, change-sets.
        deps.e1 ? settle(() => readE1Extras(pool)) : Promise.resolve(null)
      ]);
      const parsed = status === null ? null : GardenerStatusSnapshotSchema.safeParse(status);
      const controls = deps.controls.current();
      const power = deps.power.snapshot();
      const cap = deps.cap.snapshot();
      return {
        status:
          parsed?.success === true
            ? {
                state: parsed.data.state,
                ...(parsed.data.class ? { class: parsed.data.class } : {}),
                ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
                params: parsed.data.params,
                coverage: parsed.data.coverage,
                ...(parsed.data.eta ? { eta: parsed.data.eta } : {}),
                ...(parsed.data.action ? { action: parsed.data.action } : {})
              }
            : // A snapshot the contract does not accept is itself a finding: kept as a fallback.
              status === null
              ? null
              : { state: "invalid", fallback: true },
        workers: deriveWorkerStates(base, at, workerCapacity()),
        cap: {
          capTokens: cap.capTokens,
          spentTokens: cap.spentTokens,
          reservedTokens: cap.reservedTokens,
          calls: cap.calls,
          refusals: cap.refusals,
          largestCallTokens: cap.largestCallTokens
        },
        budget: budget
          ? {
              moneyState: budget.money.state,
              spentUsd: budget.money.spentUsd,
              reservedUsd: budget.money.reservedUsd,
              capUsd: budget.money.capUsd,
              callsState: budget.calls.state,
              usedCalls: budget.calls.usedCalls,
              reservedCalls: budget.calls.reservedCalls,
              capCalls: budget.calls.capCalls
            }
          : null,
        controls: {
          autonomy: controls.autonomy,
          paused: controls.paused,
          onlyIdle: controls.onlyIdle,
          onlyOnAc: controls.onlyOnAc,
          monthlyCapUsd: controls.monthlyCapUsd
        },
        power,
        lockWaits,
        load,
        ...(deps.e1
          ? {
              dbBytes: extras?.dbBytes ?? null,
              relationCalls: extras?.relationCalls ?? null,
              changeSets: extras?.changeSets ?? null
            }
          : {})
      };
    }
  };
}
