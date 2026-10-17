import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { PgPool } from "../client.js";
import { noteRelationStateSql } from "./note-relation-sql.js";
import {
  createSourceRelationRepository,
  currentSourceRelationEvidenceSql,
  noteRelationFingerprintSql
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
    // Both read the same eligible note relations (applied, current notes and chunks), joined on the
    // relation's endpoint columns in its stored direction (relations v2), never on metadata.
    for (const { text } of [listed!, keyed!]) {
      expect(text).toContain(noteRelationStateSql.applied("n"));
      expect(text).toContain("a.supersession_status = 'current'");
      expect(text).toContain(
        "join atomic_notes a on a.id = case when n.direction = 'hi_to_lo' then n.target_atomic_note_id else n.source_atomic_note_id end"
      );
      expect(text).toContain("n.direction <> 'unknown'");
      expect(text).not.toContain("n.metadata");
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

  it("fingerprints facts only: never the relation's status, band, probability, veto or metadata (D11)", () => {
    const fingerprint = noteRelationFingerprintSql("n", "a", "b").replace(/\s+/g, " ");
    expect(currentSourceRelationEvidenceSql.replace(/\s+/g, " ")).toContain(fingerprint);
    for (const column of ["status", "band", "probability", "vetoed_at", "veto_source", "metadata"])
      expect(fingerprint).not.toContain(`n.${column}`);
    for (const fact of [
      "n.id::text",
      "n.source_atomic_note_id",
      "n.target_atomic_note_id",
      "n.direction"
    ])
      expect(fingerprint).toContain(fact);
    expect(fingerprint).toContain("coalesce(n.relation_type,'')");
    // Migration 0056 re-keyed the stored fingerprints with the same facts, lower endpoint first.
    const migration = readFileSync(
      join(import.meta.dirname, "../../drizzle/0056_relations_v2.sql"),
      "utf8"
    ).replace(/\s+/g, "");
    for (const alias of ["a", "b"]) expect(migration).toContain(noteFacts(alias));
    expect(migration).toContain(
      "n.id::text,n.source_atomic_note_id::text,n.target_atomic_note_id::text,n.direction,coalesce(n.relation_type,''),casewhena.id=n.source_atomic_note_id"
    );
  });

  it("counts note-origin evidence only while its note relation is applied (C3)", () => {
    expect(currentSourceRelationEvidenceSql).toContain(noteRelationStateSql.applied("n"));
    expect(currentSourceRelationEvidenceSql).not.toContain("n.status <> 'rejected'");
  });
});
