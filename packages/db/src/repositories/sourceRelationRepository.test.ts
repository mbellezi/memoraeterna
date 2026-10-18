import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { PgPool } from "../client.js";
import { noteRelationDirectionSql, noteRelationStateSql } from "./note-relation-sql.js";
import {
  createSourceRelationRepository,
  currentSourceRelationEvidenceSql,
  noteRelationFingerprintSql,
  sourceRelationIdentityKey,
  suggestedSourceRelationSql
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
      // Decision 31b: the subject is the one the owner or the decider gave; the judge is told no
      // direction nobody gave, so a relation without one is left out of its hypotheses.
      const shown = noteRelationDirectionSql("n").replace(/\s+/g, " ");
      expect(text).toContain(
        `join atomic_notes a on a.id = case when ${shown} = 'hi_to_lo' then n.target_atomic_note_id else n.source_atomic_note_id end`
      );
      expect(text).toContain("n.direction <> 'unknown'");
      expect(text).toContain(`${shown} <> 'unknown'`);
      expect(text).not.toContain("n.metadata");
    }
  });
});

describe("source relation identity", () => {
  const [a, b] = ["00000000-0000-4000-8000-00000000000a", "00000000-0000-4000-8000-00000000000b"];

  it("orders the endpoints of a symmetric type, and keeps a directed type's order", () => {
    expect(sourceRelationIdentityKey(a, b, "same_as")).toBe(
      sourceRelationIdentityKey(b, a, "same_as")
    );
    expect(sourceRelationIdentityKey(a, b, "extends")).not.toBe(
      sourceRelationIdentityKey(b, a, "extends")
    );
  });

  it("tells a directed type that reads both ways from one that reads from a source (decision 31b)", () => {
    const linked = sourceRelationIdentityKey(a, b, "extends", true);
    expect(linked).toBe(sourceRelationIdentityKey(b, a, "extends", true));
    // Whichever way the sorted endpoints fall, a directed relation keeps its own identity.
    expect(linked).not.toBe(sourceRelationIdentityKey(a, b, "extends"));
    expect(linked).not.toBe(sourceRelationIdentityKey(b, a, "extends"));
    // A symmetric type is the same relation with or without the flag.
    expect(sourceRelationIdentityKey(a, b, "same_as", true)).toBe(
      sourceRelationIdentityKey(a, b, "same_as")
    );
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

  it("counts note-origin evidence while its note relation is shown, applied or suggested (C3, decision 29)", () => {
    expect(currentSourceRelationEvidenceSql).toContain(noteRelationStateSql.shown("n"));
    expect(currentSourceRelationEvidenceSql).not.toContain("n.status <> 'rejected'");
  });
});

describe("automatic source relations nobody kept (decision 29)", () => {
  const sql = suggestedSourceRelationSql("rel").replace(/\s+/g, " ");

  it("promotes typed shown note relations, while the judge's hypotheses stay applied ones", async () => {
    const queries: string[] = [];
    const pool = {
      async query<T extends QueryResultRow>(text: string) {
        queries.push(text.replace(/\s+/g, " "));
        return { command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] } as QueryResult<T>;
      }
    } as unknown as PgPool;
    const repository = createSourceRelationRepository(pool);
    await repository.promoteFromNotes("root");
    await repository.pairNotes("a", "b");
    // A pass reads its relations first, then the pairs it holds; the judge's read comes last.
    const promotion = queries[0];
    const hypotheses = queries.at(-1);
    // Promotion reads relations through the shown predicate (applied or suggested) and no other
    // filter on their status, band or veto (the static visibility test also forbids one).
    expect(promotion).toContain(noteRelationStateSql.shown("n"));
    expect(promotion).toContain("n.relation_type is not null");
    expect(hypotheses).toContain(noteRelationStateSql.applied("n"));
    expect(hypotheses).not.toContain(noteRelationStateSql.suggested("n"));
  });

  it("is any relation with no verdict that no note relation reading as applied supports", () => {
    expect(sql.startsWith("(rel.status = 'pending_review' and not exists")).toBe(true);
    // Judged and promoted alike: nothing in it reads the relation's origin.
    expect(sql).not.toContain("origin = 'promoted'");
    expect(sql).not.toContain("origin = 'judged'");
    expect(sql).toContain("e.origin = 'atomic_notes'");
    // The supporting note relation is current evidence that reads as applied through the module's
    // predicate: the owner's Keep, or an existing relation with no band (D47). A suggestion never
    // confirms, and the owner's verdict is not required of an applied one.
    const evidence = sql.replace(/\s+/g, " ");
    expect(evidence).toContain(noteRelationStateSql.applied("n"));
    expect(evidence).not.toContain(noteRelationStateSql.suggested("n"));
    expect(evidence).not.toContain(noteRelationStateSql.reviewed("n"));
    expect(evidence).toContain("sc.content_hash = e.snapshot->>'sourceHash'");
    // Evidence currentness is the one the reads use, with the applied predicate in place of shown.
    expect(sql).not.toContain(noteRelationStateSql.shown("n"));
    expect(currentSourceRelationEvidenceSql).toContain(noteRelationStateSql.shown("n"));
  });

  it("reads the relation alias r by default", () => {
    expect(suggestedSourceRelationSql()).toContain("r.status = 'pending_review'");
  });
});
