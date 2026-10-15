import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentSourceRelationEvidenceSql } from "./sourceRelationRepository.js";

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
