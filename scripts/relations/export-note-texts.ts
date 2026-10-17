/**
 * Reads the text of the notes a pairs file names from a scratch PostgreSQL (a cluster started on an APFS
 * clone of a measurement profile, never the profile itself) and writes it as `memora-relations-note-texts`
 * for `score-pairs.ts`. The session is read only; nothing is written to the database.
 *
 *   npx tsx scripts/relations/export-note-texts.ts --conn <connection.json | postgres url> \
 *     --pairs <pairs.json> --out <note-texts.json> [--expect-digest <sha256>]
 *
 * `--expect-digest` is the golden runner's notes digest of the whole library (T44's
 * `.cache/f3/m0/digests.json`): the export refuses to write when the database holds other notes than
 * the ones T44 listed candidates for.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import type pg from "pg";

import {
  createReadOnlyClient,
  resolveEvaluationConnection
} from "../golden/matching-evaluation-db.ts";
import { noteTextsFormat, sha256Hex, storedBody, type NoteTextsFile } from "./note-texts.ts";
import { noteIdsOf, readPairsFile } from "./pair-scoring.ts";

interface NoteRow {
  id: string;
  title: string;
  idea: string;
  body: string;
}

/** The notes digest of `golden-runner.ts`: sorted `source|title|md5(idea|body)|status` lines. */
export async function libraryNotesDigest(
  client: pg.Client
): Promise<{ notes: number; sha256: string }> {
  const rows = await client.query<{ line: string }>(
    `select coalesce(p.title || ' / ', '') || s.title || '|' || n.title || '|' ||
            md5(coalesce(n.idea_statement, '') || '|' || coalesce(n.body_markdown, '')) || '|' ||
            n.status::text as line
       from atomic_notes n
       join source_items s on s.id = n.created_from_source_item_id
       left join source_items p on p.id = s.parent_source_item_id`
  );
  const lines = rows.rows.map((row) => row.line).sort();
  return { notes: lines.length, sha256: sha256Hex(lines.join("\n")) };
}

export async function readNotes(client: pg.Client, ids: readonly string[]): Promise<NoteRow[]> {
  const rows = await client.query<NoteRow>(
    `select id::text as id, title, coalesce(idea_statement, '') as idea,
            coalesce(body_markdown, '') as body
       from atomic_notes where id = any($1::uuid[]) order by id`,
    [ids]
  );
  const found = new Set(rows.rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0)
    throw new Error(
      `${missing.length} note(s) of the pairs file are not in the database (first: ${missing.slice(0, 3).join(", ")}).`
    );
  return rows.rows;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      conn: { type: "string" },
      pairs: { type: "string" },
      out: { type: "string" },
      "expect-digest": { type: "string" }
    },
    strict: true,
    allowPositionals: false
  });
  if (!values.conn || !values.pairs || !values.out)
    throw new Error("--conn, --pairs and --out are required.");
  const pairs = await readPairsFile(values.pairs);
  const ids = noteIdsOf(pairs.file.pairs);
  const connection = await resolveEvaluationConnection(values.conn);
  const client = createReadOnlyClient(connection.connectionString);
  await client.connect();
  let file: NoteTextsFile;
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const digest = await libraryNotesDigest(client);
    if (values["expect-digest"] && digest.sha256 !== values["expect-digest"])
      throw new Error(
        `The library digest ${digest.sha256} is not the expected ${values["expect-digest"]}.`
      );
    const notes = await readNotes(client, ids);
    await client.query("commit");
    file = {
      format: noteTextsFormat,
      version: 1,
      profile: pairs.file.profile,
      libraryDigest: digest.sha256,
      generatedAt: new Date().toISOString(),
      notes: notes.map((note) => ({ ...note, body: storedBody(note.body) }))
    };
    console.info(
      `${connection.description}: library of ${digest.notes} notes (digest ${digest.sha256.slice(0, 12)}), ` +
        `${notes.length} notes with text for ${pairs.file.pairs.length} pairs`
    );
  } finally {
    await client.end();
  }
  const target = resolve(values.out);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(file)}\n`);
  console.info(`wrote ${target}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Driver errors can echo the connection string; report only a content-free summary.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[export-note-texts] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
    );
    process.exitCode = 1;
  }
}
