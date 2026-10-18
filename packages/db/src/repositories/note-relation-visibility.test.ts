import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appliedNoteRelationSql,
  currentNoteEndpointsSql,
  earlierVersionNoteRelationSql,
  legacyCountedNoteRelationSql,
  noteRelationStateLabelSql,
  noteRelationStateSql,
  shownNoteRelationSql,
  suggestedNoteRelationSql,
  withdrawnNoteRelationSql
} from "./note-relation-sql.js";

// F3 D9 (I-R9): relation visibility is read only through `note-relation-sql.ts`. Outside it, no SQL
// in the repositories, the scripts or the main process filters `atomic_note_relations` on `status`,
// `band`, `vetoed_at` or `direction_source`. Tests are exempt (their fixtures write those columns);
// so are the package's verify scripts, which probe the database directly. Decision 31b adds the
// direction itself: a direction is shown only through the module's expressions, so a typer's guess
// is never drawn, stated or exported by a reader that forgot the rule.
const workspace = resolve(import.meta.dirname, "../../../..");
const module = "packages/db/src/repositories/note-relation-sql.ts";
const scanned = ["packages/db/src/repositories/", "scripts/", "apps/desktop/src/main/"];

const keywords = new Set([
  "where",
  "on",
  "using",
  "set",
  "join",
  "left",
  "right",
  "inner",
  "cross",
  "full",
  "order",
  "group",
  "limit",
  "returning",
  "values",
  "select",
  "from",
  "and",
  "or",
  "in",
  "union",
  "as",
  "for",
  "with"
]);
const visibilityColumn = "(status|band|vetoed_at|direction_source)";
const comparison = String.raw`\s*(?:::\s*text\s*)?(?:=|<>|!=|\bin\b|\bnot\s+in\b|\bis\b)`;

/** The text of the template literal (or string) around `index`: one SQL statement in practice. */
function statementAround(text: string, index: number): string {
  const start = text.lastIndexOf("`", index);
  const end = text.indexOf("`", index);
  return text.slice(start === -1 ? 0 : start, end === -1 ? text.length : end);
}

/** Filters on the visibility columns of `atomic_note_relations` in one file's SQL. */
export function visibilityFilters(text: string): string[] {
  const found: string[] = [];
  for (const binding of text.matchAll(
    /\batomic_note_relations\b(\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/giu
  )) {
    const statement = statementAround(text, binding.index ?? 0);
    const alias = binding[2]?.toLowerCase();
    const pattern =
      alias && !keywords.has(alias)
        ? new RegExp(String.raw`\b${alias}\.${visibilityColumn}\b${comparison}`, "giu")
        : // Unaliased: a bare column in the statement's conditions.
          new RegExp(String.raw`(?<![\w.])${visibilityColumn}\b${comparison}`, "giu");
    // An unaliased statement compares bare columns after its first `where`.
    const scope =
      alias && !keywords.has(alias)
        ? statement
        : statement.slice(Math.max(0, statement.search(/\bwhere\b/iu)));
    if (!(alias && !keywords.has(alias)) && !/\bwhere\b/iu.test(statement)) continue;
    for (const match of scope.matchAll(pattern)) found.push(match[0].replace(/\s+/gu, " "));
  }
  for (const match of text.matchAll(/\batomicNoteRelations\.(status|band|vetoedAt)\b/gu))
    found.push(match[0]);
  return [...new Set(found)];
}

/**
 * The files that read the raw `direction` of `atomic_note_relations` on purpose (decision 31b): the
 * repository that writes it, the promotion SQL that keeps a legacy unknown direction out and
 * fingerprints the stored fact, the reconcile script that rewrites a row's bands and keeps its
 * direction as it is, and the golden and end-to-end harnesses that digest the stored record. Every reader that shows a direction goes through `noteRelationDirectionSql`.
 */
const rawDirectionReaders = new Set([
  "packages/db/src/repositories/atomicNoteRelationRepository.ts",
  "packages/db/src/repositories/sourceRelationRepository.ts",
  "apps/desktop/src/main/services/golden-runner.ts",
  "apps/desktop/src/main/services/topics-e2e/facts.ts",
  "apps/desktop/src/main/services/verify-phase4-e2e.ts",
  "scripts/relations/reconcile.ts"
]);

/** Reads of the raw `direction` column of `atomic_note_relations` in one file's SQL. */
export function rawDirectionReads(text: string): string[] {
  const found: string[] = [];
  for (const binding of text.matchAll(
    /\batomic_note_relations\b(\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/giu
  )) {
    const alias = binding[2]?.toLowerCase();
    const statement = statementAround(text, binding.index ?? 0);
    // A write names the column without reading it (`insert into atomic_note_relations (direction)`).
    if (/\b(?:insert\s+into|update)\s+$/iu.test(text.slice(0, binding.index ?? 0))) continue;
    // Unaliased (`select direction from atomic_note_relations where ...`): a bare column, not a
    // quoted key, a longer name or another table's column.
    const pattern =
      alias && !keywords.has(alias)
        ? new RegExp(String.raw`\b${alias}\.direction\b`, "giu")
        : /(?<![\w.'"])direction(?![\w'"])/giu;
    for (const match of statement.matchAll(pattern)) found.push(match[0]);
  }
  for (const match of text.matchAll(/\batomicNoteRelations\.direction\b/gu)) found.push(match[0]);
  return [...new Set(found)];
}

const isTest = (file: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) || /(^|\/)__fixtures__\//u.test(file);

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\0")
    .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/u.test(file) && !isTest(file))
    .filter((file) => scanned.some((prefix) => file.startsWith(prefix)))
    .filter((file) => file !== module && existsSync(resolve(workspace, file)));
}

describe("note relation visibility is read through one module (D9)", () => {
  it("finds no other filter on status, band or vetoed_at of atomic_note_relations", () => {
    const filters = sourceFiles().flatMap((file) =>
      visibilityFilters(readFileSync(resolve(workspace, file), "utf8")).map(
        (filter) => `${file}: ${filter}`
      )
    );
    expect(filters).toEqual([]);
  });

  it("shows a direction only through the module's expressions (decision 31b)", () => {
    const reads = sourceFiles()
      .filter((file) => !rawDirectionReaders.has(file))
      .flatMap((file) =>
        rawDirectionReads(readFileSync(resolve(workspace, file), "utf8")).map(
          (read) => `${file}: ${read}`
        )
      );
    expect(reads).toEqual([]);
    expect(rawDirectionReads("`select r.direction from atomic_note_relations r`")).toEqual([
      "r.direction"
    ]);
    expect(
      rawDirectionReads(
        `\`select \${noteRelationDirectionSql("r")} from atomic_note_relations r where r.direction_source = 'owner'\``
      )
    ).toEqual([]);
    expect(rawDirectionReads("`select s.direction from source_relations s`")).toEqual([]);
    // A statement that binds no alias reads the bare column.
    expect(
      rawDirectionReads("`select direction from atomic_note_relations where id = $1`")
    ).toEqual(["direction"]);
    expect(
      rawDirectionReads("`select id from atomic_note_relations where direction = 'lo_to_hi'`")
    ).toEqual(["direction"]);
    expect(
      rawDirectionReads(
        "`select id, metadata->>'direction', relation_direction from atomic_note_relations where id = $1`"
      )
    ).toEqual([]);
    expect(
      rawDirectionReads("`insert into atomic_note_relations (id, direction) values ($1, $2)`")
    ).toEqual([]);
  });

  it("detects a filter, aliased or not, and ignores reads and the predicates", () => {
    expect(
      visibilityFilters("`select 1 from atomic_note_relations r where r.status <> 'rejected'`")
    ).toEqual(["r.status <>"]);
    expect(
      visibilityFilters("`select 1 from atomic_note_relations n where n.band = 'apply'`")
    ).toEqual(["n.band ="]);
    expect(
      visibilityFilters("`select 1 from atomic_note_relations as x where x.vetoed_at is null`")
    ).toEqual(["x.vetoed_at is"]);
    expect(
      visibilityFilters(
        "`select count(*) from atomic_note_relations where status <> 'pending_review'`"
      )
    ).toEqual(["status <>"]);
    expect(visibilityFilters("eq(atomicNoteRelations.status, 'accepted')")).toEqual([
      "atomicNoteRelations.status"
    ]);
    expect(
      visibilityFilters(
        `\`select r.status, r.band from atomic_note_relations r where \${shownNoteRelationSql("r")}\``
      )
    ).toEqual([]);
    expect(
      visibilityFilters(
        "`select 1 from atomic_note_relations r where r.direction_source = 'owner'`"
      )
    ).toEqual(["r.direction_source ="]);
    // Another table's status under the same statement shape is not a note relation's.
    expect(
      visibilityFilters("`select 1 from source_relations r where r.status <> 'rejected'`")
    ).toEqual([]);
  });
});

describe("the visibility predicates (D9)", () => {
  const state = {
    accepted: { status: "accepted", band: null, vetoed: false },
    acceptedVetoed: { status: "accepted", band: "suggest", vetoed: true },
    legacy: { status: "pending_review", band: null, vetoed: false },
    applied: { status: "pending_review", band: "apply", vetoed: false },
    suggested: { status: "pending_review", band: "suggest", vetoed: false },
    withdrawn: { status: "pending_review", band: "apply", vetoed: true },
    removed: { status: "rejected", band: "apply", vetoed: false }
  } as const;
  type State = (typeof state)[keyof typeof state];

  /** Evaluates a state predicate's SQL on one row with a tiny interpreter of its grammar. */
  function holds(sql: string, row: State): boolean {
    const js = sql
      .replace(/r\.status = '([a-z_]+)'/gu, (_, value) => JSON.stringify(row.status === value))
      .replace(/r\.status <> '([a-z_]+)'/gu, (_, value) => JSON.stringify(row.status !== value))
      .replace(/r\.vetoed_at is not null/gu, JSON.stringify(row.vetoed))
      .replace(/r\.vetoed_at is null/gu, JSON.stringify(!row.vetoed))
      .replace(/r\.band = '([a-z_]+)'/gu, (_, value) => JSON.stringify(row.band === value))
      .replace(/r\.band is null/gu, JSON.stringify(row.band === null))
      .replace(/\band\b/gu, "&&")
      .replace(/\bor\b/gu, "||");
    expect(js).toMatch(/^[()\s&|truefals]+$/u);
    return Function(`return (${js});`)() as boolean;
  }

  const expected: Record<keyof typeof state, string[]> = {
    accepted: ["applied", "kept", "shown", "reviewed"],
    acceptedVetoed: ["applied", "kept", "shown", "reviewed"],
    legacy: ["applied", "shown", "undecidedByHuman", "vetoable"],
    applied: ["applied", "shown", "undecidedByHuman", "vetoable"],
    suggested: ["suggested", "shown", "undecidedByHuman", "vetoable"],
    withdrawn: ["withdrawn", "undecidedByHuman"],
    removed: ["removed", "reviewed"]
  };

  it("classifies every state: a human verdict is final, a veto withdraws, the band applies or suggests", () => {
    for (const [name, row] of Object.entries(state) as Array<[keyof typeof state, State]>) {
      const truths = Object.entries(noteRelationStateSql)
        .filter(([, predicate]) => holds(predicate("r"), row))
        .map(([predicate]) => predicate)
        .sort();
      expect(truths, name).toEqual([...expected[name]].sort());
    }
  });

  it("requires both endpoints current with current primary evidence", () => {
    const endpoints = currentNoteEndpointsSql("r");
    for (const column of ["source_atomic_note_id", "target_atomic_note_id"])
      expect(endpoints).toContain(`nrv_note.id = r.${column}`);
    expect(endpoints).toContain("supersession_status = 'current'");
    expect(endpoints).toContain("status not in ('rejected','archived')");
    expect(endpoints).toContain("metadata->>'supersededByDocumentId' is null");
    for (const full of [
      appliedNoteRelationSql,
      suggestedNoteRelationSql,
      shownNoteRelationSql,
      withdrawnNoteRelationSql
    ]) {
      expect(full("r")).toContain(endpoints);
      expect(full("r", ["a", "b"])).toContain("a.supersession_status = 'current'");
      expect(full("r", ["a", "b"])).toContain("b.supersession_status = 'current'");
    }
    // An endpoint whose currency the query computed once is read from that column.
    const computed = shownNoteRelationSql("r", [{ alias: "s", current: "s.current" }, "o"]);
    expect(computed).toContain("(s.current is true)");
    expect(computed).toContain("o.supersession_status = 'current'");
    expect(() =>
      shownNoteRelationSql("r", [{ alias: "s", current: "s.current; drop" }, "o"])
    ).toThrow("Unsafe SQL column");
    expect(appliedNoteRelationSql("r")).toContain(noteRelationStateSql.applied("r"));
    expect(earlierVersionNoteRelationSql("r", "s", "o")).toContain(
      noteRelationStateSql.applied("r")
    );
    expect(earlierVersionNoteRelationSql("r", "s", "o")).toContain("not (");
  });

  it("labels a relation kept, withdrawn, suggested, removed or applied from the same predicates", () => {
    const label = noteRelationStateLabelSql("r");
    expect(label).toContain(noteRelationStateSql.kept("r"));
    expect(label).toContain(noteRelationStateSql.withdrawn("r"));
    expect(label).toContain(noteRelationStateSql.suggested("r"));
    expect(label).toContain(noteRelationStateSql.removed("r"));
    // The owner's verdict wins over a veto that was recorded before it, and applied is the rest.
    expect(label.indexOf("'kept'")).toBeLessThan(label.indexOf("'withdrawn'"));
    expect(label.indexOf("'withdrawn'")).toBeLessThan(label.indexOf("'suggested'"));
    expect(label.indexOf("'suggested'")).toBeLessThan(label.indexOf("'removed'"));
    expect(label).toContain("else 'applied'");
    expect(() => noteRelationStateLabelSql("r; drop")).toThrow("Unsafe SQL alias");
  });

  it("keeps the legacy reading for libraries without the v2 columns", () => {
    expect(legacyCountedNoteRelationSql("r", ["accepted", "pending_review"])).toBe(
      "r.status::text in ('accepted', 'pending_review')"
    );
    expect(legacyCountedNoteRelationSql("r", [])).toBe("false");
    expect(() => legacyCountedNoteRelationSql("r", ["kept"])).toThrow("Relation statuses");
  });

  it("refuses an alias that is not a plain identifier", () => {
    for (const predicate of [
      noteRelationStateSql.applied,
      appliedNoteRelationSql,
      (alias: string) => earlierVersionNoteRelationSql("r", alias, "o")
    ])
      expect(() => predicate("r; drop table x")).toThrow("Unsafe SQL alias");
  });
});
