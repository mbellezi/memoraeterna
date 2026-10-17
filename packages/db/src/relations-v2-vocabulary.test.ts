import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  directedNoteRelationTypes,
  noteRelationReadTypes,
  noteRelationWriteTypes,
  NoteRelationDirectionSchema
} from "@app/domain";
import { describe, expect, it } from "vitest";

// The CHECK constraints of relations v2 (migration 0056) spell the domain vocabulary out: they must
// list exactly the read, write and directed types and the directions of `@app/domain` (D8, D10).
const schema = readFileSync(join(import.meta.dirname, "schema.ts"), "utf8");
const migration = readFileSync(
  join(import.meta.dirname, "../drizzle/0056_relations_v2.sql"),
  "utf8"
);
const list = (values: readonly string[]) => `(${values.map((value) => `'${value}'`).join(",")})`;

describe("the relations v2 constraints match the domain vocabulary", () => {
  it("lists the read types, the write types, the directed types and the directions", () => {
    for (const text of [schema, migration]) {
      expect(text).toContain(`in ${list(noteRelationReadTypes)}`);
      expect(text).toContain(`in ${list(noteRelationWriteTypes)}`);
      expect(text).toContain(`in ${list(directedNoteRelationTypes)}`);
      expect(text).toContain(`in ${list(NoteRelationDirectionSchema.options)}`);
      expect(text).toContain(`in ${list([...noteRelationWriteTypes, "none"])}`);
    }
  });
});
