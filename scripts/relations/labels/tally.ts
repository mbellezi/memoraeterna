/**
 * Tallies the blind panel (T45, spec 5.2): the majority per question over the judges' answer files,
 * the unanimity share and Fleiss' kappa per question, and the label counts and positive share per
 * pool and stratum.
 *
 *   npx tsx scripts/relations/labels/tally.ts [--pass <name>] [--judges 3] [--fixture scripts/fixtures/f3-relation-labels.json]
 *
 * Answers: `<pass directory>/answers/<judge>.json`, one JSON array (or JSON lines) of
 * `{"id", "related", "type", "direction"}` per judge, as `judge-prompt.md` asks. The sealed key maps
 * each page position back to its pair and its A/B order; directions are stored by the sorted pair
 * (`lo_to_hi`, `hi_to_lo`, or `symmetric` for a symmetric type).
 *
 * Majority: a value at least more than half of the panel gave. A pair the panel does not call
 * related by majority has no type; a type that no majority gave (three different answers, or two
 * different ones beside a "no") is unresolved and left out of type accuracy; the direction of a
 * directed majority type is the majority among the judges who gave that type.
 *
 * `--pass <name>` tallies a later pass (`.cache/f3/labels/passes/<name>/`) and checks its consistency
 * items against the panel's own tally. `--fixture` writes the versioned ids, content hashes and
 * majority labels (spec 4.5; the panel pass only).
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  answerSchema,
  directionAnswers,
  isDirectedType,
  labelsDirectory,
  readJson,
  sealedSchema,
  sha256Hex,
  stratumNames,
  writeTypes,
  type Answer,
  type Sealed,
  type SealedItem
} from "./common.ts";

export const tallyFormat = "memora-label-tally";
export const fixtureFormat = "memora-f3-relation-labels";
export const defaultPanelSize = 3;

export type Direction = "lo_to_hi" | "hi_to_lo";

/** One judge's answer to one item, validated against the questions. */
export interface Vote {
  related: boolean | null;
  /** Null unless related is yes and the type is in the write vocabulary. */
  type: string | null;
  /** For a directed type: the subject by the sorted pair; `symmetric` for a symmetric type. */
  direction: Direction | "symmetric" | null;
  problems: string[];
}

export function voteOf(answer: Answer | undefined, shownA: "lo" | "hi"): Vote {
  if (!answer) return { related: null, type: null, direction: null, problems: ["missing"] };
  const problems: string[] = [];
  const related = answer.related === "yes";
  if (!related) {
    if (answer.type || answer.direction) problems.push("type or direction given with related no");
    return { related: false, type: null, direction: null, problems };
  }
  const type = answer.type ?? null;
  if (!type || !(writeTypes as readonly string[]).includes(type)) {
    problems.push(`type ${JSON.stringify(type)} is not in the write vocabulary`);
    return { related: true, type: null, direction: null, problems };
  }
  if (!isDirectedType(type)) {
    if (answer.direction) problems.push(`direction given for the symmetric type ${type}`);
    return { related: true, type, direction: "symmetric", problems };
  }
  const given = answer.direction ?? null;
  if (!given || !(directionAnswers as readonly string[]).includes(given)) {
    problems.push(`direction ${JSON.stringify(given)} is not A->B or B->A`);
    return { related: true, type, direction: null, problems };
  }
  const aIsSubject = given === "A->B";
  const loIsSubject = shownA === "lo" ? aIsSubject : !aIsSubject;
  return { related: true, type, direction: loIsSubject ? "lo_to_hi" : "hi_to_lo", problems };
}

export interface QuestionResult<T> {
  majority: T | null;
  /** Votes per value (judges with no valid answer to the question are not counted). */
  votes: Record<string, number>;
  /** Every judge of the panel gave the same valid value. */
  unanimous: boolean;
}

function countVotes<T extends string>(values: ReadonlyArray<T | null>): Record<string, number> {
  const votes: Record<string, number> = {};
  for (const value of values) if (value !== null) votes[value] = (votes[value] ?? 0) + 1;
  return votes;
}

/** A value more than half of the panel gave. */
function majorityOf(votes: Record<string, number>, panel: number): string | null {
  for (const [value, count] of Object.entries(votes)) if (count > panel / 2) return value;
  return null;
}

export interface ItemTally {
  related: QuestionResult<boolean>;
  type: QuestionResult<string>;
  direction: QuestionResult<Direction | "symmetric">;
}

export function tallyItem(votes: readonly Vote[], panel: number): ItemTally {
  const relatedVotes = countVotes(
    votes.map((vote) => (vote.related === null ? null : vote.related ? "yes" : "no"))
  );
  const relatedMajority = majorityOf(relatedVotes, panel);
  const related: QuestionResult<boolean> = {
    majority: relatedMajority === null ? null : relatedMajority === "yes",
    votes: relatedVotes,
    unanimous:
      votes.length === panel &&
      Object.keys(relatedVotes).length === 1 &&
      Object.values(relatedVotes)[0] === panel
  };
  const yesVotes = votes.filter((vote) => vote.related === true);
  const typeVotes = countVotes(yesVotes.map((vote) => vote.type));
  const typeMajority = related.majority === true ? majorityOf(typeVotes, panel) : null;
  const type: QuestionResult<string> = {
    majority: typeMajority,
    votes: typeVotes,
    unanimous:
      votes.length === panel &&
      Object.keys(typeVotes).length === 1 &&
      Object.values(typeVotes)[0] === panel
  };
  const sameType =
    typeMajority === null ? [] : yesVotes.filter((vote) => vote.type === typeMajority);
  const directionVotes = countVotes(sameType.map((vote) => vote.direction));
  const directionMajority =
    typeMajority === null
      ? null
      : isDirectedType(typeMajority)
        ? (majorityOf(directionVotes, panel) as Direction | null)
        : "symmetric";
  const directed = votes.filter(
    (vote) => vote.direction === "lo_to_hi" || vote.direction === "hi_to_lo"
  );
  const allDirections = countVotes(directed.map((vote) => vote.direction));
  const direction: QuestionResult<Direction | "symmetric"> = {
    majority: directionMajority,
    votes: directionVotes,
    unanimous: directed.length === panel && Object.keys(allDirections).length === 1
  };
  return { related, type, direction };
}

/**
 * Fleiss' kappa over items rated by the same number of raters: `ratings[i][category]` counts the
 * raters who put item i in that category. Null when there is nothing to compare or chance agreement
 * is total.
 */
export function fleissKappa(ratings: ReadonlyArray<Record<string, number>>): number | null {
  if (ratings.length === 0) return null;
  const raters = Object.values(ratings[0]!).reduce((sum, value) => sum + value, 0);
  if (raters < 2) return null;
  const totals: Record<string, number> = {};
  let agreement = 0;
  for (const row of ratings) {
    const count = Object.values(row).reduce((sum, value) => sum + value, 0);
    if (count !== raters)
      throw new Error("Fleiss' kappa needs the same number of raters per item.");
    let squares = 0;
    for (const [category, value] of Object.entries(row)) {
      totals[category] = (totals[category] ?? 0) + value;
      squares += value * value;
    }
    agreement += (squares - raters) / (raters * (raters - 1));
  }
  const observed = agreement / ratings.length;
  const chance = Object.values(totals).reduce((sum, value) => {
    const share = value / (ratings.length * raters);
    return sum + share * share;
  }, 0);
  if (Math.abs(1 - chance) < 1e-12) return null;
  return (observed - chance) / (1 - chance);
}

export interface QuestionAgreement {
  /** Items on which every judge gave a valid answer to the question. */
  items: number;
  unanimous: number;
  unanimousShare: number | null;
  kappa: number | null;
}

export interface TallyResult {
  format: typeof tallyFormat;
  version: 1;
  pass: string;
  panel: number;
  judges: Array<{
    name: string;
    answers: number;
    missing: number;
    problems: number;
    yesShare: number | null;
  }>;
  agreement: { related: QuestionAgreement; type: QuestionAgreement; direction: QuestionAgreement };
  items: Array<
    Pick<
      SealedItem,
      | "pairId"
      | "itemId"
      | "kind"
      | "library"
      | "lo"
      | "hi"
      | "sets"
      | "pool"
      | "stratum"
      | "split"
      | "contentSha256"
    > &
      ItemTally
  >;
  /** Label counts per pool and stratum (majority-resolved items) and the positive share. */
  strata: Array<{
    pool: string;
    stratum: number;
    name: string;
    items: number;
    labelled: number;
    related: number;
    positiveShare: number | null;
  }>;
  sets: Array<{
    set: string;
    items: number;
    labelled: number;
    related: number;
    positiveShare: number | null;
  }>;
  unresolved: { related: number; type: number; direction: number };
  problems: string[];
  consistency: { items: number; compared: number; agreeing: number } | null;
}

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

function agreementOf(
  rows: ReadonlyArray<Record<string, number>>,
  panel: number
): QuestionAgreement {
  const complete = rows.filter(
    (row) => Object.values(row).reduce((sum, value) => sum + value, 0) === panel
  );
  const unanimous = complete.filter((row) =>
    Object.values(row).some((value) => value === panel)
  ).length;
  return {
    items: complete.length,
    unanimous,
    unanimousShare: share(unanimous, complete.length),
    kappa: fleissKappa(complete)
  };
}

export function tally(
  sealed: Sealed,
  judges: ReadonlyArray<{ name: string; answers: readonly Answer[] }>,
  panel = defaultPanelSize,
  reference?: ReadonlyMap<string, boolean | null>
): TallyResult {
  const problems: string[] = [];
  if (judges.length !== panel)
    problems.push(`${judges.length} answer files for a panel of ${panel}`);
  const known = new Set(sealed.items.map((item) => item.itemId));
  const byJudge = judges.map(({ name, answers }) => {
    const byId = new Map<string, Answer>();
    for (const answer of answers) {
      if (!known.has(answer.id)) throw new Error(`${name}: unknown item id ${answer.id}.`);
      if (byId.has(answer.id)) throw new Error(`${name}: item ${answer.id} answered twice.`);
      byId.set(answer.id, answer);
    }
    return { name, byId };
  });
  const judgeStats = byJudge.map(({ name, byId }) => ({
    name,
    answers: byId.size,
    missing: 0,
    problems: 0,
    yes: 0
  }));
  const items: TallyResult["items"] = [];
  const relatedRows: Array<Record<string, number>> = [];
  const typeRows: Array<Record<string, number>> = [];
  const directionRows: Array<Record<string, number>> = [];
  for (const item of sealed.items) {
    const votes = byJudge.map(({ name, byId }, index) => {
      const vote = voteOf(byId.get(item.itemId), item.shownA);
      const stats = judgeStats[index]!;
      if (vote.problems.includes("missing")) stats.missing += 1;
      else if (vote.problems.length > 0) {
        stats.problems += 1;
        problems.push(`${name} ${item.itemId}: ${vote.problems.join("; ")}`);
      }
      if (vote.related === true) stats.yes += 1;
      return vote;
    });
    const result = tallyItem(votes, panel);
    relatedRows.push(result.related.votes);
    if (votes.every((vote) => vote.type !== null))
      typeRows.push(countVotes(votes.map((vote) => vote.type)));
    if (votes.every((vote) => vote.direction === "lo_to_hi" || vote.direction === "hi_to_lo"))
      directionRows.push(countVotes(votes.map((vote) => vote.direction)));
    items.push({
      pairId: item.pairId,
      itemId: item.itemId,
      kind: item.kind,
      library: item.library,
      lo: item.lo,
      hi: item.hi,
      sets: item.sets,
      pool: item.pool,
      stratum: item.stratum,
      split: item.split,
      contentSha256: item.contentSha256,
      ...result
    });
  }
  const strata: TallyResult["strata"] = [];
  for (const pool of ["A", "B", "C"])
    for (let stratum = 0; stratum < stratumNames.length; stratum += 1) {
      const own = items.filter((item) => item.pool === pool && item.stratum === stratum);
      const labelled = own.filter((item) => item.related.majority !== null);
      const related = labelled.filter((item) => item.related.majority === true).length;
      strata.push({
        pool,
        stratum,
        name: stratumNames[stratum]!,
        items: own.length,
        labelled: labelled.length,
        related,
        positiveShare: share(related, labelled.length)
      });
    }
  const setNames = [
    ...new Set(items.flatMap((item) => item.sets.map((membership) => membership.set)))
  ].sort();
  const sets = setNames.map((set) => {
    const own = items.filter((item) => item.sets.some((membership) => membership.set === set));
    const labelled = own.filter((item) => item.related.majority !== null);
    const related = labelled.filter((item) => item.related.majority === true).length;
    return {
      set,
      items: own.length,
      labelled: labelled.length,
      related,
      positiveShare: share(related, labelled.length)
    };
  });
  let consistency: TallyResult["consistency"] = null;
  if (reference) {
    const checks = items.filter((item) =>
      item.sets.some((membership) => membership.set === "consistency")
    );
    const compared = checks.filter(
      (item) => item.related.majority !== null && (reference.get(item.pairId) ?? null) !== null
    );
    consistency = {
      items: checks.length,
      compared: compared.length,
      agreeing: compared.filter((item) => reference.get(item.pairId) === item.related.majority)
        .length
    };
  }
  return {
    format: tallyFormat,
    version: 1,
    pass: sealed.pass,
    panel,
    judges: judgeStats.map(({ name, answers, missing, problems: count, yes }) => ({
      name,
      answers,
      missing,
      problems: count,
      yesShare: share(yes, answers)
    })),
    agreement: {
      related: agreementOf(relatedRows, panel),
      type: agreementOf(typeRows, panel),
      direction: agreementOf(directionRows, panel)
    },
    items,
    strata,
    sets,
    unresolved: {
      related: items.filter((item) => item.related.majority === null).length,
      type: items.filter((item) => item.related.majority === true && item.type.majority === null)
        .length,
      direction: items.filter(
        (item) =>
          item.type.majority !== null &&
          isDirectedType(item.type.majority) &&
          item.direction.majority === null
      ).length
    },
    problems,
    consistency
  };
}

// --- Fixture --------------------------------------------------------------------------------------

export const labelFixtureSchema = z
  .object({
    format: z.literal(fixtureFormat),
    version: z.literal(1),
    seed: z.number().int(),
    labelSetSha256: z.string(),
    panel: z.number().int().positive(),
    agreement: z.record(z.string(), z.unknown()),
    items: z.array(
      z
        .object({
          pairId: z.string(),
          kind: z.enum(["note", "source"]),
          library: z.string(),
          lo: z.string(),
          hi: z.string(),
          sets: z.array(z.string()),
          pool: z.string().nullable(),
          stratum: z.number().int().nullable(),
          split: z.string().nullable(),
          contentSha256: z.string(),
          related: z.boolean().nullable(),
          type: z.string().nullable(),
          direction: z.enum(["lo_to_hi", "hi_to_lo", "symmetric"]).nullable(),
          votes: z.object({ yes: z.number().int(), no: z.number().int() }).strict(),
          unanimous: z.boolean()
        })
        .strict()
    )
  })
  .strict();
export type LabelFixture = z.infer<typeof labelFixtureSchema>;

/** The versioned labels: ids, content hashes and majority labels, no text (spec 4.5). */
export function labelFixture(result: TallyResult, sealed: Sealed): LabelFixture {
  return labelFixtureSchema.parse({
    format: fixtureFormat,
    version: 1,
    seed: sealed.seed,
    labelSetSha256: sealed.labelSetSha256,
    panel: result.panel,
    agreement: result.agreement,
    items: [...result.items]
      .sort((a, b) => (a.pairId < b.pairId ? -1 : 1))
      .map((item) => ({
        pairId: item.pairId,
        kind: item.kind,
        library: item.library,
        lo: item.lo,
        hi: item.hi,
        sets: [...new Set(item.sets.map((membership) => membership.set))].sort(),
        pool: item.pool,
        stratum: item.stratum,
        split: item.split,
        contentSha256: item.contentSha256,
        related: item.related.majority,
        type: item.type.majority,
        direction: item.direction.majority,
        votes: { yes: item.related.votes.yes ?? 0, no: item.related.votes.no ?? 0 },
        unanimous: item.related.unanimous
      }))
  });
}

// --- Report ---------------------------------------------------------------------------------------

const percent = (value: number | null): string =>
  value === null ? "-" : `${(100 * value).toFixed(1)}%`;
const fixed = (value: number | null): string => (value === null ? "-" : value.toFixed(3));

export function renderTallyMarkdown(result: TallyResult): string {
  const lines = [
    `# Panel tally: ${result.pass}`,
    "",
    `${result.items.length} items, panel of ${result.panel}; unresolved: related ${result.unresolved.related}, type ${result.unresolved.type}, direction ${result.unresolved.direction}.`,
    "",
    "| Question | Items with every answer | Unanimous | Fleiss kappa |",
    "| --- | ---: | ---: | ---: |",
    ...(["related", "type", "direction"] as const).map((question) => {
      const row = result.agreement[question];
      return `| ${question} | ${row.items} | ${row.unanimous} (${percent(row.unanimousShare)}) | ${fixed(row.kappa)} |`;
    }),
    "",
    "| Judge | Answers | Missing | Problems | Yes share |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...result.judges.map(
      (judge) =>
        `| ${judge.name} | ${judge.answers} | ${judge.missing} | ${judge.problems} | ${percent(judge.yesShare)} |`
    ),
    "",
    "| Pool | Stratum | Items | Labelled | Related | Positive share |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...result.strata
      .filter((row) => row.items > 0)
      .map(
        (row) =>
          `| ${row.pool} | ${row.name} | ${row.items} | ${row.labelled} | ${row.related} | ${percent(row.positiveShare)} |`
      ),
    "",
    "| Set | Items | Labelled | Related | Positive share |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...result.sets.map(
      (row) =>
        `| ${row.set} | ${row.items} | ${row.labelled} | ${row.related} | ${percent(row.positiveShare)} |`
    )
  ];
  if (result.consistency)
    lines.push(
      "",
      `Consistency items: ${result.consistency.agreeing} of ${result.consistency.compared} compared agree with the panel (${result.consistency.items} in the pass).`
    );
  if (result.problems.length > 0)
    lines.push(
      "",
      `Problems (${result.problems.length}):`,
      "",
      ...result.problems.slice(0, 50).map((problem) => `- ${problem}`)
    );
  return `${lines.join("\n")}\n`;
}

// --- Inputs and main ------------------------------------------------------------------------------

/** One answer file: a JSON array, an object with an `answers` array, or JSON lines. */
export function parseAnswers(text: string, name: string): Answer[] {
  const trimmed = text.trim();
  let raw: unknown[];
  try {
    if (trimmed.startsWith("[")) raw = JSON.parse(trimmed) as unknown[];
    else if (trimmed.startsWith("{") && !trimmed.includes("\n{")) {
      const parsed = JSON.parse(trimmed) as { answers?: unknown };
      raw = Array.isArray(parsed.answers) ? parsed.answers : [parsed];
    } else
      raw = trimmed
        .split(/\r?\n/u)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new Error(`${name}: the answers are not valid JSON.`);
  }
  return raw.map((entry, index) => {
    const parsed = answerSchema.safeParse(entry);
    if (!parsed.success)
      throw new Error(
        `${name}: answer ${index + 1} is malformed (${parsed.error.issues[0]?.message}).`
      );
    return parsed.data;
  });
}

async function readJudges(directory: string): Promise<Array<{ name: string; answers: Answer[] }>> {
  const files = (await readdir(directory).catch(() => [] as string[]))
    .filter((file) => [".json", ".jsonl"].includes(extname(file)))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const name = basename(file, extname(file));
      return { name, answers: parseAnswers(await readFile(join(directory, file), "utf8"), name) };
    })
  );
}

const passDirectory = (pass: string | undefined): string =>
  pass && pass !== "panel" ? `${labelsDirectory}/passes/${pass}` : labelsDirectory;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { pass: { type: "string" }, judges: { type: "string" }, fixture: { type: "string" } },
    strict: true,
    allowPositionals: false
  });
  const directory = passDirectory(values.pass);
  const panel = values.judges ? Number(values.judges) : defaultPanelSize;
  const sealed = await readJson(join(directory, "sealed.json"), sealedSchema, "sealed key");
  const judges = await readJudges(join(directory, "answers"));
  if (judges.length === 0) throw new Error(`No answer files in ${join(directory, "answers")}.`);
  let reference: Map<string, boolean | null> | undefined;
  if (directory !== labelsDirectory) {
    const base = JSON.parse(await readFile(join(labelsDirectory, "tally.json"), "utf8")) as {
      items: Array<{ pairId: string; related: { majority: boolean | null } }>;
    };
    reference = new Map(base.items.map((item) => [item.pairId, item.related.majority]));
  }
  const result = tally(sealed, judges, panel, reference);
  await writeFile(join(directory, "tally.json"), `${JSON.stringify(result, null, 1)}\n`);
  await writeFile(join(directory, "tally.md"), renderTallyMarkdown(result));
  console.info(renderTallyMarkdown(result).split("\n").slice(0, 12).join("\n"));
  if (values.fixture) {
    if (directory !== labelsDirectory) throw new Error("--fixture writes the panel pass only.");
    if (judges.length !== panel) throw new Error(`The fixture needs ${panel} answer files.`);
    const target = resolve(values.fixture);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(labelFixture(result, sealed), null, 1)}\n`);
    console.info(`wrote ${target} (sealed key ${sha256Hex(JSON.stringify(sealed)).slice(0, 12)})`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[labels/tally] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
