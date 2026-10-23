import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createAuditLintRepository,
  createTopicTreeRepository,
  type PgPool,
  type ScanCursor
} from "@app/db";
import {
  addressTargets,
  auditLintConfigWith,
  brokenLinkFindings,
  defaultAuditLintConfig,
  duplicateFindings,
  staleEmbeddings
} from "@app/domain";
import type { EmbeddingFact, NeighbourEvidence, TitleGroup } from "@app/domain";
import {
  isLive,
  planRedirectCompression,
  replacementCandidates,
  themeDrift
} from "@app/domain/topic-tree";
import pg from "pg";

import { atomicNoteEmbeddingHash } from "../../apps/desktop/src/main/services/note-embedding-text.js";
import { loadTopicTreeCache } from "../../apps/desktop/src/main/services/topic-tree/topic-cache.js";
import { resolveConnection } from "../kpi/connection.js";
import { lintsUsage, parseLintsArgs, renderLintsMarkdown } from "./audit-lints-core.js";
import type { LintsReport } from "./audit-lints-core.js";

// Usage: npm run topics:lints -- --db <connection.json | postgres url> [--tree <uuid>] [--share 0.01]
// A read-only dry run of AUDIT's lints (F4 T85, D19): the same pure lints and reads the audit job
// runs, over the whole library instead of one audit's window, with nothing recorded or queued.

const fileText = async (path: string, text: string): Promise<void> => {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
};

const elapsed = (started: number): number => Math.round(performance.now() - started);

try {
  const command = parseLintsArgs(process.argv.slice(2));
  if (command.kind === "help") {
    console.info(lintsUsage);
  } else {
    const connection = await resolveConnection(command.db);
    const pool = new pg.Pool({
      connectionString: connection.connectionString,
      max: 4,
      options: "-c default_transaction_read_only=on -c statement_timeout=900000",
      connectionTimeoutMillis: 10_000
    }) as PgPool;
    try {
      const report = await dryRun(pool, command, connection.info);
      const markdown = renderLintsMarkdown(report);
      if (command.json) await fileText(command.json, `${JSON.stringify(report, null, 2)}\n`);
      if (command.out) await fileText(command.out, markdown);
      else console.info(markdown);
    } finally {
      await pool.end();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}

async function dryRun(
  pool: PgPool,
  command: Extract<ReturnType<typeof parseLintsArgs>, { kind: "run" }>,
  info: { host: string; name: string }
): Promise<LintsReport> {
  const repository = createTopicTreeRepository(pool);
  const record = command.treeId
    ? await repository.tree(command.treeId)
    : await repository.activeTree();
  if (!record) throw new Error("There is no tree to lint.");
  const cache = await loadTopicTreeCache(pool, record.id);
  if (!cache) throw new Error("The tree could not be loaded.");
  const { state, vectors, config, tree } = cache;
  const lintConfig = auditLintConfigWith({
    // The widest windows the configuration allows: the dry run reads the whole library.
    replacement: { share: command.share, perRun: 100_000, candidates: 100_000 },
    themeDrift: { perRun: 10_000 },
    links: { compressPerRun: 10_000 }
  });
  const space = {
    dimensions: tree.dimensions,
    spaceKey: tree.spaceKey,
    model: tree.embeddingModel
  };
  const lints = createAuditLintRepository(pool);

  // Duplicate notes: every note of the space, in batches, as the audit reads its window.
  let started = performance.now();
  const neighbours: NeighbourEvidence[] = [];
  const titleGroups: TitleGroup[] = [];
  let cursor: ScanCursor | null = null;
  let examined = 0;
  for (;;) {
    const batch = await lints.duplicateBatch(
      space,
      cursor,
      defaultAuditLintConfig.duplicates.batch,
      defaultAuditLintConfig.duplicates.neighbours
    );
    if (batch.notes.length === 0) break;
    neighbours.push(...batch.neighbours);
    titleGroups.push(...(await lints.titleGroups(batch.notes.map((note) => note.id))));
    examined += batch.notes.length;
    const last = batch.notes[batch.notes.length - 1] as { at: string; id: string };
    cursor = { at: last.at, id: last.id };
  }
  const duplicates = duplicateFindings({ neighbours, titleGroups }, lintConfig);
  const byReason = { vector: 0, title: 0, both: 0 };
  for (const pair of duplicates.pairs) byReason[pair.reason] += 1;
  const vectorCosines = duplicates.pairs
    .filter((pair) => pair.cosine !== null && pair.reason !== "title")
    .map((pair) => pair.cosine as number)
    .sort((a, b) => a - b);
  const duplicatesMs = elapsed(started);

  // Broken links: the persisted addresses and whether their objects still exist.
  started = performance.now();
  const targets = addressTargets(await lints.persistedAddresses(lintConfig.links.addressesPerRun));
  const resolutions = await lints.addressResolutions(targets, lintConfig.links.maxHops);
  const broken = brokenLinkFindings(targets, resolutions);
  const brokenByReason: Record<string, number> = {};
  for (const finding of broken) {
    const reason = String(finding.params.reason);
    brokenByReason[reason] = (brokenByReason[reason] ?? 0) + 1;
  }
  const brokenMs = elapsed(started);

  // Stale embeddings: the notes without a vector, and those edited after theirs, checked by hash.
  started = performance.now();
  const missing = await lints.notesWithoutVector(space, 100_000, 0);
  const facts: EmbeddingFact[] = [];
  let editedExamined = 0;
  let editedCursor: ScanCursor | null = null;
  for (;;) {
    const edited = await lints.notesEditedAfterVector(space, editedCursor, 500, 0);
    if (edited.length === 0) break;
    editedExamined += edited.length;
    for (const note of edited) {
      facts.push({
        noteId: note.id,
        expectedHash: atomicNoteEmbeddingHash(note),
        storedHash: note.storedHash
      });
    }
    const last = edited[edited.length - 1] as { at: string; id: string };
    editedCursor = { at: last.at, id: last.id };
  }
  const stale = staleEmbeddings(
    facts,
    auditLintConfigWith({ staleEmbeddings: { perRun: 100_000 } })
  );
  const staleMs = elapsed(started);

  // Redirect chains, theme drift and the rolling re-placement read the tree's cache.
  started = performance.now();
  const plan = planRedirectCompression(state, lintConfig);
  const redirectsMs = elapsed(started);
  started = performance.now();
  const theme = themeDrift(state, lintConfig);
  const themeMs = elapsed(started);
  started = performance.now();
  const replacement = replacementCandidates(state, vectors, config, lintConfig, 0);
  const replacementMs = elapsed(started);

  const listed = command.listed;
  const topics = [...state.topics.values()];
  return {
    generatedAt: new Date().toISOString(),
    database: info,
    tree: {
      id: tree.id,
      generation: tree.generation,
      spaceKey: tree.spaceKey,
      dimensions: tree.dimensions,
      topics: topics.filter((node) => isLive(node)).length,
      retiredTopics: topics.filter((node) => !isLive(node)).length,
      notes: vectors.size
    },
    duplicates: {
      examined,
      pairs: duplicates.pairs.length,
      byReason,
      genericTitleGroups: duplicates.genericTitleGroups,
      cosines:
        vectorCosines.length === 0
          ? null
          : {
              min: vectorCosines[0] as number,
              median: vectorCosines[Math.floor(vectorCosines.length / 2)] as number,
              max: vectorCosines[vectorCosines.length - 1] as number
            },
      listed: duplicates.pairs.slice(0, listed).map((pair) => ({
        notes: [pair.notes[0], pair.notes[1]],
        cosine: pair.cosine,
        reason: pair.reason
      })),
      ms: duplicatesMs
    },
    brokenLinks: {
      checked: targets.length,
      broken: broken.length,
      byReason: brokenByReason,
      listed: broken.slice(0, listed).map((finding) => ({
        address: finding.objectRefs[0] ?? "",
        reason: String(finding.params.reason)
      })),
      ms: brokenMs
    },
    staleEmbeddings: {
      missing: missing.length,
      editedExamined,
      content: stale.content,
      ms: staleMs
    },
    redirects: {
      retired:
        plan.report.direct +
        plan.report.chains.length +
        plan.report.deadEnds +
        plan.report.unresolved.length,
      direct: plan.report.direct,
      chains: plan.report.chains.length,
      longestChain: plan.report.chains.reduce((most, chain) => Math.max(most, chain.hops), 0),
      deadEnds: plan.report.deadEnds,
      unresolved: plan.report.unresolved.length,
      listed: plan.report.chains.slice(0, listed),
      ms: redirectsMs
    },
    themeDrift: {
      measured: theme.measured,
      threshold: lintConfig.themeDrift.cosine,
      below: theme.drifted.length,
      percentiles: theme.percentiles,
      listed: theme.drifted.slice(0, listed),
      ms: themeMs
    },
    replacement: {
      share: command.share,
      eligible: replacement.eligible,
      sampled: replacement.sampled,
      candidates: replacement.candidates.length,
      listed: replacement.candidates.slice(0, listed),
      ms: replacementMs
    }
  };
}
