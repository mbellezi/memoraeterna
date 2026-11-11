import {
  AskScopeSchema,
  formatObjectAddress,
  objectAnchorKeys,
  QuestionAnchorSchema,
  QuestionAnswerInputSchema,
  QuestionCreateSchema,
  questionCitationKinds,
  sanitizeStoredValue,
  type AskScope,
  type ObjectAnchor,
  type QuestionAnswerInput,
  type QuestionAnswerStatus,
  type QuestionCitation,
  type QuestionCitationKind,
  type QuestionCreate,
  type QuestionMode,
  type QuestionParagraph,
  type QuestionPrivacy,
  type QuestionProvenance,
  type AskQuestionStatus
} from "@app/domain";
import type { QueryResultRow } from "pg";

import { withTransaction, type PgPool } from "../client.js";
import { questionCitationCurrentHashSql } from "./questionCitationHashSql.js";
import { mapNullableTimestamp, mapTimestamp } from "./sql.js";

/** Read bounds of a page of questions. */
export const questionListLimits = { default: 25, max: 50 } as const;

/** The message a page asked with a cursor this repository did not issue carries. */
export const questionCursorMessage = "errors.questions.cursor";

export interface QuestionAnswerRecord {
  id: string;
  /** 1 for the first answer; "Ask again" adds one. */
  version: number;
  paragraphs: QuestionParagraph[];
  provenance: QuestionProvenance;
  status: QuestionAnswerStatus;
  startedAt: Date;
  completedAt: Date | null;
  /** Some citation's target changed since the answer was stored, or no longer exists. */
  stale: boolean;
  citations: QuestionCitation[];
}

export interface QuestionRecord {
  id: string;
  text: string;
  language: string;
  scope: AskScope;
  privacy: QuestionPrivacy;
  mode: QuestionMode;
  status: AskQuestionStatus;
  errorKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** In version order, oldest first. */
  answers: QuestionAnswerRecord[];
}

/** A question as a list shows it: no answer text, no staleness (a read of one question has both). */
export interface QuestionListItem {
  id: string;
  text: string;
  language: string;
  scope: AskScope;
  status: AskQuestionStatus;
  createdAt: Date;
  updatedAt: Date;
  answerCount: number;
}

export interface QuestionPage {
  items: QuestionListItem[];
  /** Pass it back to read the page after this one; null on the last page. */
  nextCursor: string | null;
}

export interface ListQuestionsInput {
  cursor?: string | undefined;
  limit?: number | undefined;
  /** The question's own words, accents and case folded (full text or similar words). */
  query?: string | undefined;
}

export interface AppendedAnswer {
  answerId: string;
  version: number;
  /** Citations whose target did not exist when saved: stored with no hash, they read unavailable. */
  missingTargets: number;
}

interface QuestionRow extends QueryResultRow {
  id: string;
  text: string;
  language: string;
  scope: unknown;
  privacy: QuestionPrivacy;
  mode: QuestionMode;
  status: AskQuestionStatus;
  errorKey: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface AnswerRow extends QueryResultRow {
  id: string;
  version: number;
  paragraphs: QuestionParagraph[];
  provenance: QuestionProvenance;
  status: QuestionAnswerStatus;
  startedAt: Date | string;
  completedAt: Date | string | null;
}

interface CitationRow extends QueryResultRow {
  answerId: string;
  ordinal: number;
  kind: QuestionCitationKind;
  targetId: string;
  anchor: unknown;
  storedHash: string;
  currentHash: string | null;
  chunkSourceId: string | null;
}

/**
 * The words of a question matched against a query: full text over `search_tsv` or similar words
 * over the trigram index of `f_unaccent(text)` (F5 D12, D27). The expression matches both GIN
 * indexes, so one statement is the one the lists and the verify script run.
 */
export function questionSearchCondition(alias: string, queryParameter: string): string {
  return `(${alias}.search_tsv @@ plainto_tsquery('simple', f_unaccent(${queryParameter}))
            or f_unaccent(${queryParameter}) <% f_unaccent(${alias}.text))`;
}

/** The keyset order of a list: newest first, the ID breaking ties (matches `questions_created_at_idx`). */
export const questionListOrder = "q.created_at desc nulls last, q.id desc nulls last";

const questionColumns = `q.id, q.text, q.language, q.scope, q.privacy, q.mode, q.status,
  q.error_key as "errorKey", q.created_at as "createdAt", q.updated_at as "updatedAt"`;

/** The current hash of each citation's target: the one expression per kind, never a copy of it. */
const currentHash = `case c.target_kind
${questionCitationKinds
  .map((kind) => `  when '${kind}' then ${questionCitationCurrentHashSql(kind, "c.target_id")}`)
  .join("\n")}
end`;

function toScope(value: unknown): AskScope {
  return AskScopeSchema.parse(value);
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(parsed) &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string" &&
      !Number.isNaN(Date.parse(parsed[0])) &&
      /^[0-9a-f-]{36}$/i.test(parsed[1])
    )
      return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    // Falls through to the refusal below.
  }
  throw new Error(questionCursorMessage);
}

/** A citation as a reader sees it, from its stored row and the target's current state. */
function toCitation(row: CitationRow): QuestionCitation {
  const unavailable = row.currentHash === null;
  const stored = QuestionAnchorSchema.safeParse(row.anchor ?? undefined);
  const anchor: ObjectAnchor = {};
  if (stored.success)
    for (const key of objectAnchorKeys) {
      const value = stored.data[key];
      if (value !== undefined) anchor[key] = value;
    }
  let address: string | null;
  let resolvedAnchor = anchor;
  if (row.kind === "chunk") {
    // A passage has no address of its own: it is read inside its source.
    address =
      row.chunkSourceId === null
        ? null
        : formatObjectAddress({ kind: "source", id: row.chunkSourceId });
    resolvedAnchor = { ...anchor, passage: anchor.passage ?? row.targetId };
  } else {
    address = formatObjectAddress({ kind: row.kind, id: row.targetId });
  }
  return {
    ordinal: row.ordinal,
    address,
    ...(Object.keys(resolvedAnchor).length > 0 ? { anchor: resolvedAnchor } : {}),
    unavailable,
    stale: unavailable || row.currentHash !== row.storedHash
  };
}

/**
 * The questions Ask stores (F5 D14): one row per question from its first token, and one answer
 * version per attempt with its citations and their hashes. The repository only writes the rows; the
 * service that owns the Ask publishes `object.changed` after each commit.
 */
export function createQuestionRepository(pool: PgPool) {
  return {
    /** Inserts the question (status `running`) before retrieval starts, so its address is valid. */
    async create(input: QuestionCreate): Promise<QuestionRecord> {
      const question = QuestionCreateSchema.parse(sanitizeStoredValue(input));
      const result = await pool.query<QuestionRow>(
        `insert into questions as q (id, text, language, scope, privacy, mode, status)
         values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5, $6, 'running')
         returning ${questionColumns}`,
        [
          question.id ?? null,
          question.text,
          question.language,
          JSON.stringify(question.scope),
          question.privacy,
          question.mode
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Insert into questions did not return a row.");
      return { ...toQuestion(row), answers: [] };
    },

    /**
     * Stores one answer version and its citations in one transaction: the version is the highest
     * plus one, each citation takes the hash of its target from the one SQL expression of its kind
     * (`INSERT ... SELECT`), and the question's status follows the answer's. Returns null when the
     * question no longer exists (the owner deleted it while it ran): nothing is stored.
     */
    async appendAnswer(
      questionId: string,
      input: QuestionAnswerInput
    ): Promise<AppendedAnswer | null> {
      const answer = QuestionAnswerInputSchema.parse(sanitizeStoredValue(input));
      return withTransaction(pool, async (client) => {
        // The row lock serializes two answers of one question, so versions never collide.
        const locked = await client.query("select 1 from questions where id = $1 for update", [
          questionId
        ]);
        if (!locked.rowCount) return null;
        const inserted = await client.query<{ id: string; version: number }>(
          `insert into question_answers (question_id, version, paragraphs, provenance, status, started_at, completed_at)
           select $1::uuid, coalesce(max(version), 0) + 1, $2::jsonb, $3::jsonb, $4, $5, $6
             from question_answers where question_id = $1::uuid
           returning id, version`,
          [
            questionId,
            JSON.stringify(answer.paragraphs),
            JSON.stringify(answer.provenance),
            answer.status,
            answer.startedAt,
            answer.completedAt ?? null
          ]
        );
        const stored = inserted.rows[0];
        if (!stored) throw new Error("Insert into question_answers did not return a row.");
        for (const kind of questionCitationKinds) {
          const cited = answer.citations
            .filter((citation) => citation.kind === kind)
            .map((citation) => ({
              ordinal: citation.ordinal,
              target_id: citation.targetId,
              anchor: citation.anchor ?? null
            }));
          if (!cited.length) continue;
          await client.query(
            `insert into question_citations (answer_id, ordinal, target_kind, target_id, anchor, content_hash)
             select $1::uuid, v.ordinal, $2, v.target_id, nullif(v.anchor, 'null'::jsonb),
                    coalesce(${questionCitationCurrentHashSql(kind, "v.target_id")}, '')
               from jsonb_to_recordset($3::jsonb) as v(ordinal int, target_id uuid, anchor jsonb)`,
            [stored.id, kind, JSON.stringify(cited)]
          );
        }
        const missing = await client.query<{ count: number }>(
          "select count(*)::int as count from question_citations where answer_id = $1 and content_hash = ''",
          [stored.id]
        );
        await client.query(
          `update questions set status = $2, error_key = $3, updated_at = now() where id = $1`,
          [questionId, answer.status, answer.status === "failed" ? (answer.errorKey ?? null) : null]
        );
        return {
          answerId: stored.id,
          version: stored.version,
          missingTargets: missing.rows[0]?.count ?? 0
        };
      });
    },

    /** Moves the question to a status (`running` again for "Ask again"); false when it is gone. */
    async setStatus(
      questionId: string,
      status: AskQuestionStatus,
      errorKey?: string | null
    ): Promise<boolean> {
      const result = await pool.query(
        `update questions set status = $2, error_key = $3, updated_at = now() where id = $1`,
        [questionId, status, status === "failed" ? (errorKey ?? null) : null]
      );
      return (result.rowCount ?? 0) > 0;
    },

    /**
     * One question with its answer versions. An answer is `stale` when some citation's current hash
     * differs from the one stored with it or its target no longer exists; each citation says which.
     * One snapshot reads all of it.
     */
    async get(questionId: string): Promise<QuestionRecord | null> {
      const client = await pool.connect();
      try {
        await client.query("begin transaction isolation level repeatable read, read only");
        const questions = await client.query<QuestionRow>(
          `select ${questionColumns} from questions q where q.id = $1`,
          [questionId]
        );
        const question = questions.rows[0];
        if (!question) {
          await client.query("commit");
          return null;
        }
        const answers = await client.query<AnswerRow>(
          `select id, version, paragraphs, provenance, status,
                  started_at as "startedAt", completed_at as "completedAt"
             from question_answers where question_id = $1 order by version`,
          [questionId]
        );
        const citations = await client.query<CitationRow>(
          `select c.answer_id as "answerId", c.ordinal, c.target_kind as kind, c.target_id as "targetId",
                  c.anchor, c.content_hash as "storedHash", ${currentHash} as "currentHash",
                  case when c.target_kind = 'chunk'
                       then (select k.source_item_id from chunks k where k.id = c.target_id) end as "chunkSourceId"
             from question_citations c join question_answers a on a.id = c.answer_id
            where a.question_id = $1 order by a.version, c.ordinal`,
          [questionId]
        );
        await client.query("commit");
        const byAnswer = new Map<string, QuestionCitation[]>();
        for (const row of citations.rows) {
          const list = byAnswer.get(row.answerId) ?? [];
          list.push(toCitation(row));
          byAnswer.set(row.answerId, list);
        }
        return {
          ...toQuestion(question),
          answers: answers.rows.map((row) => {
            const cited = byAnswer.get(row.id) ?? [];
            return {
              id: row.id,
              version: row.version,
              paragraphs: row.paragraphs,
              provenance: row.provenance,
              status: row.status,
              startedAt: mapTimestamp(row.startedAt),
              completedAt: mapNullableTimestamp(row.completedAt),
              stale: cited.some((citation) => citation.stale),
              citations: cited
            };
          })
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** Newest first, by keyset on (created_at, id): a new question never shifts a page. */
    async list(input: ListQuestionsInput = {}): Promise<QuestionPage> {
      const limit = Math.min(
        Math.max(Math.trunc(input.limit ?? questionListLimits.default), 1),
        questionListLimits.max
      );
      const values: unknown[] = [];
      const conditions: string[] = [];
      if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        values.push(cursor.createdAt, cursor.id);
        conditions.push(
          `(q.created_at, q.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`
        );
      }
      const query = input.query?.trim();
      if (query) {
        values.push(query);
        conditions.push(questionSearchCondition("q", `$${values.length}`));
      }
      values.push(limit + 1);
      const result = await pool.query<QuestionRow & { cursorAt: string; answerCount: number }>(
        `select ${questionColumns}, q.created_at::text as "cursorAt",
                (select count(*)::int from question_answers a where a.question_id = q.id) as "answerCount"
           from questions q
          ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
          order by ${questionListOrder}
          limit $${values.length}`,
        values
      );
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          id: row.id,
          text: row.text,
          language: row.language,
          scope: toScope(row.scope),
          status: row.status,
          createdAt: mapTimestamp(row.createdAt),
          updatedAt: mapTimestamp(row.updatedAt),
          answerCount: row.answerCount
        })),
        nextCursor: result.rows.length > limit && last ? encodeCursor(last.cursorAt, last.id) : null
      };
    },

    /** Deletes one question with its answers and citations; false when it was already gone. */
    async delete(questionId: string): Promise<boolean> {
      const result = await pool.query("delete from questions where id = $1", [questionId]);
      return (result.rowCount ?? 0) > 0;
    },

    /** Deletes every question (one statement, so one transaction); returns how many. */
    async clear(): Promise<number> {
      const result = await pool.query("delete from questions");
      return result.rowCount ?? 0;
    }
  };
}

export type QuestionRepository = ReturnType<typeof createQuestionRepository>;

function toQuestion(row: QuestionRow): Omit<QuestionRecord, "answers"> {
  return {
    id: row.id,
    text: row.text,
    language: row.language,
    scope: toScope(row.scope),
    privacy: row.privacy,
    mode: row.mode,
    status: row.status,
    errorKey: row.errorKey,
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}
