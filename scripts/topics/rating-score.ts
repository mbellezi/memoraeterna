// Scoring of the owner blind rating (E4, D20): a topic counts only when the owner rated it both
// coherent and well named, and the bar is ratingConfig.passBar of ratingConfig.sampleSize. The two
// marginals are reported beside it, per profile and in total.
import { z } from "zod";

import { profileLabels, ratingConfig, ratingProfiles } from "./rating-core.js";
import type { ManifestFile, RatingProfile, SealedFile } from "./rating-core.js";

/** What `scripts/spikes/eval-server.ts` writes: the page's whole answer blob under its storage key. */
export const AnswersFileSchema = z.object({
  key: z.string(),
  answers: z.record(
    z.string(),
    z.object({
      coerente: z.boolean().nullable().optional(),
      bemNomeado: z.boolean().nullable().optional(),
      notas: z.string().optional()
    })
  ),
  savedAt: z.string().optional()
});
export type AnswersFile = z.infer<typeof AnswersFileSchema>;

export interface Tally {
  topics: number;
  /** Topics with both questions answered. */
  rated: number;
  coherentAnswered: number;
  coherentYes: number;
  namedAnswered: number;
  namedYes: number;
  /** Topics rated both coherent and well named: the count D20 gates on. */
  both: number;
}

export interface StratumTally {
  profile: RatingProfile;
  stratum: string;
  tally: Tally;
}

export interface NotCounted {
  position: number;
  profile: RatingProfile;
  stratum: string;
  level: number;
  name: string;
  coherent: boolean | null;
  wellNamed: boolean | null;
  notes: string;
}

export interface RatingScore {
  sampleSize: number;
  passBar: number;
  /** Every topic has both answers. */
  complete: boolean;
  /** True or false once complete; null while topics are unrated. */
  passes: boolean | null;
  total: Tally;
  byProfile: Record<RatingProfile, Tally>;
  byStratum: StratumTally[];
  /** Topics that did not count, in page order, with what the owner wrote. */
  notCounted: NotCounted[];
}

const emptyTally = (): Tally => ({
  topics: 0,
  rated: 0,
  coherentAnswered: 0,
  coherentYes: 0,
  namedAnswered: 0,
  namedYes: 0,
  both: 0
});

function add(tally: Tally, coherent: boolean | null, wellNamed: boolean | null): void {
  tally.topics += 1;
  if (coherent !== null) {
    tally.coherentAnswered += 1;
    if (coherent) tally.coherentYes += 1;
  }
  if (wellNamed !== null) {
    tally.namedAnswered += 1;
    if (wellNamed) tally.namedYes += 1;
  }
  if (coherent !== null && wellNamed !== null) tally.rated += 1;
  if (coherent === true && wellNamed === true) tally.both += 1;
}

export function scoreRating(input: {
  sealed: SealedFile;
  answers: AnswersFile;
  passBar?: number;
  sampleSize?: number;
}): RatingScore {
  const passBar = input.passBar ?? ratingConfig.passBar;
  const sampleSize = input.sampleSize ?? ratingConfig.sampleSize;
  const total = emptyTally();
  const byProfile = Object.fromEntries(
    ratingProfiles.map((profile) => [profile, emptyTally()])
  ) as Record<RatingProfile, Tally>;
  const strata = new Map<string, StratumTally>();
  const notCounted: NotCounted[] = [];
  for (const entry of input.sealed.entries) {
    const answer = input.answers.answers[entry.key];
    const coherent = answer?.coerente ?? null;
    const wellNamed = answer?.bemNomeado ?? null;
    add(total, coherent, wellNamed);
    add(byProfile[entry.profile], coherent, wellNamed);
    const stratumKey = `${entry.profile}/${entry.stratum}`;
    let stratum = strata.get(stratumKey);
    if (!stratum) {
      stratum = { profile: entry.profile, stratum: entry.stratum, tally: emptyTally() };
      strata.set(stratumKey, stratum);
    }
    add(stratum.tally, coherent, wellNamed);
    if (!(coherent === true && wellNamed === true)) {
      notCounted.push({
        position: entry.position,
        profile: entry.profile,
        stratum: entry.stratum,
        level: entry.level,
        name: entry.name,
        coherent,
        wellNamed,
        notes: answer?.notas?.trim() ?? ""
      });
    }
  }
  const complete = total.topics === sampleSize && total.rated === total.topics;
  return {
    sampleSize,
    passBar,
    complete,
    passes: complete ? total.both >= passBar : null,
    total,
    byProfile,
    byStratum: [...strata.values()],
    notCounted
  };
}

// ---------------------------------------------------------------------------
// Rendering

const answerText = (value: boolean | null): string =>
  value === null ? "not answered" : value ? "yes" : "no";

const fraction = (count: number, of: number): string => `${count}/${of}`;

const tableRow = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;

function tallyRow(label: string, tally: Tally): string {
  return tableRow([
    label,
    fraction(tally.coherentYes, tally.topics),
    fraction(tally.namedYes, tally.topics),
    fraction(tally.both, tally.topics),
    fraction(tally.rated, tally.topics)
  ]);
}

/** Plain-text summary for the terminal. */
export function renderScoreText(score: RatingScore): string {
  const lines = [
    `Topics rated both coherent and well named: ${fraction(score.total.both, score.sampleSize)} ` +
      `(bar >= ${score.passBar}/${score.sampleSize}, D20)`,
    `Coherent (marginal): ${fraction(score.total.coherentYes, score.total.topics)}`,
    `Well named (marginal): ${fraction(score.total.namedYes, score.total.topics)}`,
    `Rated: ${fraction(score.total.rated, score.total.topics)}`
  ];
  for (const profile of ratingProfiles) {
    const tally = score.byProfile[profile];
    lines.push(
      `  ${profileLabels[profile]}: coherent ${fraction(tally.coherentYes, tally.topics)}, ` +
        `well named ${fraction(tally.namedYes, tally.topics)}, both ${fraction(tally.both, tally.topics)}`
    );
  }
  lines.push(
    score.passes === null
      ? `INCOMPLETE: ${score.total.topics - score.total.rated} of ${score.total.topics} topics lack an answer.`
      : score.passes
        ? "E4 PASSES."
        : "E4 DOES NOT PASS."
  );
  return lines.join("\n");
}

/** The markdown written next to the answers. */
export function renderScoreMarkdown(input: {
  score: RatingScore;
  manifest: ManifestFile;
  sealed: SealedFile;
  answersSavedAt: string | null;
}): string {
  const { score, manifest } = input;
  const verdict =
    score.passes === null
      ? `INCOMPLETE (${score.total.rated}/${score.total.topics} rated)`
      : score.passes
        ? "PASS"
        : "FAIL";
  const lines = [
    `# E4 owner blind rating: ${verdict}`,
    "",
    `Run \`${manifest.run}\`, seed ${manifest.seed}, sampled ${manifest.createdAt}` +
      (input.answersSavedAt ? `, answers saved ${input.answersSavedAt}.` : "."),
    "",
    `Rule (D20): a topic counts only when rated both coherent and well named (including being in the ` +
      `content language). Pass bar: at least ${score.passBar} of ${score.sampleSize}.`,
    "",
    `**Both yes: ${fraction(score.total.both, score.sampleSize)}** (${verdict}). ` +
      `Coherent marginal ${fraction(score.total.coherentYes, score.total.topics)}, ` +
      `well-named marginal ${fraction(score.total.namedYes, score.total.topics)}.`,
    "",
    "## By dataset",
    "",
    tableRow(["Dataset", "Coherent", "Well named", "Both yes", "Rated"]),
    tableRow(["---", "---:", "---:", "---:", "---:"]),
    ...ratingProfiles.map((profile) => tallyRow(profileLabels[profile], score.byProfile[profile])),
    tallyRow("**Total**", score.total),
    "",
    "## By stratum",
    "",
    tableRow(["Dataset / stratum", "Coherent", "Well named", "Both yes", "Rated"]),
    tableRow(["---", "---:", "---:", "---:", "---:"]),
    ...score.byStratum.map((entry) =>
      tallyRow(`${profileLabels[entry.profile]} / ${entry.stratum}`, entry.tally)
    ),
    "",
    "## Trees",
    "",
    tableRow(["Dataset", "config_hash", "Tree generation", "Areas applied"]),
    tableRow(["---", "---", "---:", "---"]),
    ...manifest.profiles.map((profile) =>
      tableRow([
        profile.label,
        `\`${profile.configHash}\``,
        String(profile.generation),
        profile.areasApplied ? "yes" : "no"
      ])
    ),
    "",
    "## Topics that did not count",
    ""
  ];
  if (score.notCounted.length === 0) {
    lines.push("None: every topic was rated both coherent and well named.");
  } else {
    lines.push(
      tableRow([
        "#",
        "Dataset",
        "Stratum",
        "Level",
        "Name",
        "Coherent",
        "Well named",
        "Owner note"
      ]),
      tableRow(["---:", "---", "---", "---:", "---", "---", "---", "---"]),
      ...score.notCounted.map((topic) =>
        tableRow([
          String(topic.position),
          profileLabels[topic.profile],
          topic.stratum,
          String(topic.level),
          topic.name.replace(/\|/gu, "\\|"),
          answerText(topic.coherent),
          answerText(topic.wellNamed),
          topic.notes.replace(/\s+/gu, " ").replace(/\|/gu, "\\|")
        ])
      )
    );
  }
  lines.push("");
  return lines.join("\n");
}
