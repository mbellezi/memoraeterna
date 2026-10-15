import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { PgPool } from "../client.js";
import {
  createSourceRelationRepository,
  currentSourceRelationEvidenceSql
} from "./sourceRelationRepository.js";

const citedExclusion =
  "not exists (select 1 from source_relation_evidence existing_evidence where existing_evidence.note_relation_id = n.id)";

describe("source pair note relations", () => {
  it("lists only uncited note relations in the prompt but keys the pair on all of them", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const pool = {
      async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
        queries.push({ text: text.replace(/\s+/g, " "), values });
        return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] } as QueryResult<T>;
      }
    } as unknown as PgPool;
    const repository = createSourceRelationRepository(pool);
    await repository.pairNotes("a", "b", 4);
    await repository.pairNoteFingerprints("a", "b");
    const [listed, keyed] = queries;
    expect(listed!.text).toContain(citedExclusion);
    expect(listed!.text).toContain("limit $3");
    expect(keyed!.text).not.toContain(citedExclusion);
    expect(keyed!.text).not.toContain("limit");
    expect(keyed!.values).toEqual(["a", "b"]);
    // Both read the same eligible note relations (never rejected, current notes and chunks).
    for (const { text } of [listed!, keyed!]) {
      expect(text).toContain("n.status <> 'rejected'");
      expect(text).toContain("a.supersession_status = 'current'");
    }
  });
});

const noteFacts = (alias: string) =>
  `concat_ws('|',${alias}.id::text,${alias}.idea_statement,${alias}.body_markdown,${alias}.supersession_status)`;

describe("source-relation evidence currency", () => {
  it("fingerprints the notes' text and supersession, never their review status", () => {
    for (const alias of ["a", "b"]) {
      expect(currentSourceRelationEvidenceSql).toContain(noteFacts(alias));
      expect(currentSourceRelationEvidenceSql).not.toContain(`${alias}.status::text`);
    }
    // Discarded and archived notes stay non-current through the explicit checks.
    expect(currentSourceRelationEvidenceSql).toContain(
      "a.status not in ('rejected','archived') and b.status not in ('rejected','archived')"
    );
  });

  it("re-keys former fingerprints with the formula the reads use", () => {
    const migration = readFileSync(
      join(import.meta.dirname, "../../drizzle/0048_note_fingerprint_without_review_status.sql"),
      "utf8"
    );
    for (const alias of ["a", "b"]) expect(migration).toContain(noteFacts(alias));
  });
});
