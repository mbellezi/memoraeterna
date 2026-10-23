// Command line and Markdown report of `npm run topics:lints` (F4 T85): a read-only dry run of
// AUDIT's lints (spec 3.7, D19) on a profile's database, for the proofs on ENV-G and ENV-C. The
// lints are deterministic, so the same database gives the same counts; timings are the only
// numbers that vary. The report lists identifiers and counts, never titles or note text.
import { parseArgs } from "node:util";

import { z } from "zod";

import { fmtInt, table } from "../kpi/render.js";

export const lintsUsage = `Usage: npx tsx scripts/topics/audit-lints.ts --db <connection.json | postgres url> [options]

  --db <value>         Scratch connection file (.cache/f0/scratch-<name>.json) or a postgres:// URL. Read-only.
  --tree <uuid>        Tree to lint (default: the active tree).
  --share <0..1>       Share of the placed notes the rolling re-placement decides again (default 1: all of them;
                       the product decides 0.01 a day).
  --listed <n>         Entries listed per detail table (default: 10); totals are always exact.
  --out <file.md>      Write the Markdown report here (default: print to stdout).
  --json <file.json>   Also write the full report as JSON.
  --help               Show this text.

Nothing is written: the session is read-only, findings and cursors are not recorded and no job is queued.
Exit code: 0 when the lints ran, 2 when they could not.`;

export interface LintsArgs {
  readonly db: string;
  readonly treeId: string | null;
  readonly share: number;
  readonly listed: number;
  readonly out: string | null;
  readonly json: string | null;
}

export type LintsCommand = { readonly kind: "help" } | ({ readonly kind: "run" } & LintsArgs);

export function parseLintsArgs(argv: readonly string[]): LintsCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      db: { type: "string" },
      tree: { type: "string" },
      share: { type: "string" },
      listed: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };
  if (!values.db) throw new Error("--db is required.");
  const tree = values.tree === undefined ? null : z.string().uuid().safeParse(values.tree);
  if (tree !== null && !tree.success) throw new Error("--tree must be a UUID.");
  const share = values.share === undefined ? 1 : Number(values.share);
  if (!Number.isFinite(share) || share < 0 || share > 1)
    throw new Error(`--share must be between 0 and 1, got "${values.share}".`);
  const listed = values.listed === undefined ? 10 : Number(values.listed);
  if (!Number.isInteger(listed) || listed < 0 || listed > 1_000)
    throw new Error(`--listed must be an integer between 0 and 1000, got "${values.listed}".`);
  return {
    kind: "run",
    db: values.db,
    treeId: tree?.success ? tree.data : null,
    share,
    listed,
    out: values.out ?? null,
    json: values.json ?? null
  };
}

export interface LintsReport {
  generatedAt: string;
  database: { host: string; name: string };
  tree: {
    id: string;
    generation: number;
    spaceKey: string;
    dimensions: number;
    topics: number;
    retiredTopics: number;
    notes: number;
  };
  duplicates: {
    examined: number;
    pairs: number;
    byReason: { vector: number; title: number; both: number };
    genericTitleGroups: number;
    /** Cosine of the pairs found by vector: 0th, 50th and 100th percentile (null without any). */
    cosines: { min: number; median: number; max: number } | null;
    listed: { notes: [string, string]; cosine: number | null; reason: string }[];
    ms: number;
  };
  brokenLinks: {
    checked: number;
    broken: number;
    byReason: Record<string, number>;
    listed: { address: string; reason: string }[];
    ms: number;
  };
  staleEmbeddings: {
    missing: number;
    editedExamined: number;
    content: number;
    ms: number;
  };
  redirects: {
    retired: number;
    direct: number;
    chains: number;
    longestChain: number;
    deadEnds: number;
    unresolved: number;
    listed: { topicId: string; from: string; to: string; hops: number }[];
    ms: number;
  };
  themeDrift: {
    measured: number;
    threshold: number;
    below: number;
    percentiles: { p05: number; p50: number; p95: number } | null;
    listed: { topicId: string; cosine: number }[];
    ms: number;
  };
  replacement: {
    share: number;
    eligible: number;
    sampled: number;
    candidates: number;
    listed: { item: string; from: string; to: string; gain: number }[];
    ms: number;
  };
}

const fmt = (value: number, digits = 3): string => value.toFixed(digits);

export function renderLintsMarkdown(report: LintsReport): string {
  const { tree, duplicates, brokenLinks, staleEmbeddings, redirects, themeDrift, replacement } =
    report;
  const lines: string[] = [];
  lines.push(`# AUDIT lints (dry run)`);
  lines.push("");
  lines.push(
    `Database ${report.database.name} on ${report.database.host}; tree ${tree.id} at generation ${tree.generation}, ` +
      `space \`${tree.spaceKey}\` (${tree.dimensions} dimensions); ${fmtInt(tree.topics)} live topics, ` +
      `${fmtInt(tree.retiredTopics)} retired, ${fmtInt(tree.notes)} current notes with a vector. ${report.generatedAt}.`
  );
  lines.push("");
  lines.push(`## Duplicate notes`);
  lines.push("");
  lines.push(
    `Notes examined ${fmtInt(duplicates.examined)}; duplicate pairs ${fmtInt(duplicates.pairs)} ` +
      `(vector ${fmtInt(duplicates.byReason.vector)}, title ${fmtInt(duplicates.byReason.title)}, ` +
      `both ${fmtInt(duplicates.byReason.both)}); title groups left out as generic ` +
      `${fmtInt(duplicates.genericTitleGroups)}; ${fmtInt(duplicates.ms)} ms.` +
      (duplicates.cosines
        ? ` Cosine of the pairs found by vector: min ${fmt(duplicates.cosines.min)}, median ` +
          `${fmt(duplicates.cosines.median)}, max ${fmt(duplicates.cosines.max)}.`
        : "")
  );
  if (duplicates.listed.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["Note", "Note", "Cosine", "Why"],
        duplicates.listed.map((pair) => [
          pair.notes[0],
          pair.notes[1],
          pair.cosine === null ? "" : fmt(pair.cosine),
          pair.reason
        ])
      )
    );
  }
  lines.push("");
  lines.push(`## Broken links`);
  lines.push("");
  lines.push(
    `Addresses checked ${fmtInt(brokenLinks.checked)}; broken ${fmtInt(brokenLinks.broken)}` +
      (Object.keys(brokenLinks.byReason).length > 0
        ? ` (${Object.entries(brokenLinks.byReason)
            .map(([reason, count]) => `${reason} ${fmtInt(count)}`)
            .join(", ")})`
        : "") +
      `; ${fmtInt(brokenLinks.ms)} ms.`
  );
  if (brokenLinks.listed.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["Address", "Why"],
        brokenLinks.listed.map((entry) => [entry.address, entry.reason])
      )
    );
  }
  lines.push("");
  lines.push(`## Stale embeddings`);
  lines.push("");
  lines.push(
    `Notes without a vector in the tree's space ${fmtInt(staleEmbeddings.missing)}; notes edited after their ` +
      `vector ${fmtInt(staleEmbeddings.editedExamined)}, of which built on other text ${fmtInt(staleEmbeddings.content)}; ` +
      `${fmtInt(staleEmbeddings.ms)} ms.`
  );
  lines.push("");
  lines.push(`## Redirect chains`);
  lines.push("");
  lines.push(
    `Retired topics ${fmtInt(redirects.retired)}: straight to a live topic ${fmtInt(redirects.direct)}, ` +
      `chains to compress ${fmtInt(redirects.chains)} (longest ${fmtInt(redirects.longestChain)} redirects), ` +
      `dead ends ${fmtInt(redirects.deadEnds)}, cycles or missing targets ${fmtInt(redirects.unresolved)}; ` +
      `${fmtInt(redirects.ms)} ms.`
  );
  if (redirects.listed.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["Topic", "Redirects to", "Should redirect to", "Hops"],
        redirects.listed.map((chain) => [chain.topicId, chain.from, chain.to, fmtInt(chain.hops)])
      )
    );
  }
  lines.push("");
  lines.push(`## Theme drift`);
  lines.push("");
  lines.push(
    `LLM-named topics measured ${fmtInt(themeDrift.measured)}; below cosine ${fmt(themeDrift.threshold, 2)}: ` +
      `${fmtInt(themeDrift.below)}; ${fmtInt(themeDrift.ms)} ms.` +
      (themeDrift.percentiles
        ? ` Label-to-centroid cosine: p05 ${fmt(themeDrift.percentiles.p05)}, p50 ${fmt(themeDrift.percentiles.p50)}, ` +
          `p95 ${fmt(themeDrift.percentiles.p95)}.`
        : "")
  );
  if (themeDrift.listed.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["Topic", "Cosine"],
        themeDrift.listed.map((entry) => [entry.topicId, fmt(entry.cosine)])
      )
    );
  }
  lines.push("");
  lines.push(`## Rolling re-placement`);
  lines.push("");
  lines.push(
    `Placed notes the sample draws from ${fmtInt(replacement.eligible)}; decided again ${fmtInt(replacement.sampled)} ` +
      `(share ${fmt(replacement.share, 2)}); candidates ${fmtInt(replacement.candidates)}; ${fmtInt(replacement.ms)} ms.`
  );
  if (replacement.listed.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["Note", "Sits in", "PLACE would choose", "Gain"],
        replacement.listed.map((entry) => [entry.item, entry.from, entry.to, fmt(entry.gain)])
      )
    );
  }
  lines.push("");
  return lines.join("\n");
}
