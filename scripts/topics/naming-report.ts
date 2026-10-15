// The naming measurements of a topic export (F2 T18 proof, run on the ENV-G and ENV-F profiles and
// reusable on ENV-C):
//
//   npx tsx scripts/topics/naming-report.ts <export.json> [--language pt-BR] [--sample 20] [--out f.json]
//
// It reads the `topics:export` JSON (T22a) and reports what the naming change-sets recorded
// (calls, repairs and tokens per level), first-try validity, the repair rate, calls and tokens per
// named topic, sibling duplicates (0 expected), the share of names whose language field is the
// content language (100% expected), the stopword heuristic's reading of the generated titles and
// descriptions, identifier-shaped or generic titles, and a deterministic sample of names to check
// by hand. Nothing is read but the file; no model, database or network is used.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import {
  guessLanguage,
  isIdentifierShaped,
  normalizeTopicTitle,
  sameContentLanguage,
  tokenize,
  topicNamingLanguageOf
} from "@app/domain/topic-tree";

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));
const share = (part: number, whole: number): number => (whole === 0 ? 0 : round(part / whole));

/** The part of a `topics:export` document this report reads. */
export interface NamingExport {
  topics: Array<{
    id: string;
    parentId: string | null;
    role: string;
    title: string | null;
    nameState: string;
    nameSource: string | null;
    nameLanguage: string | null;
    description: string | null;
    aliases: string[];
    management: string;
    retiredAt: string | null;
  }>;
  changeSets: { items: Array<{ origin: string; status: string; summary: unknown }> };
}

export interface NamingReport {
  contentLanguage: string;
  topics: number;
  byState: Record<string, number>;
  bySource: Record<string, number>;
  unnamedShare: number;
  naming: {
    changeSets: number;
    calls: number;
    repairCalls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    asked: number;
    firstTryAccepted: number;
    repairAccepted: number;
    /** Topics a first answer named, of the topics put to the model. */
    firstTryValidity: number;
    /** Topics that needed a repair call, of the topics put to the model. */
    repairRate: number;
    callsPerNamedTopic: number;
    tokensPerNamedTopic: number;
  };
  quality: {
    siblingDuplicates: number;
    identifierShaped: number;
    /** LLM and TF-IDF names whose `nameLanguage` is the content language. */
    languageFieldMatch: number;
    /** LLM names whose description the stopword heuristic reads as the content language. */
    descriptionAgrees: number;
    descriptionDisagrees: number;
    /** LLM titles of two or more words that read as English in a library that is not English. */
    englishTitles: number;
  };
  sample: Array<{ path: string; description: string | null; source: string | null }>;
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function namingReport(
  document: NamingExport,
  options: { contentLanguage: string; sample?: number }
): NamingReport {
  const content = topicNamingLanguageOf(options.contentLanguage);
  const live = document.topics.filter(
    (topic) => topic.role === "topic" && topic.retiredAt === null
  );
  const byId = new Map(document.topics.map((topic) => [topic.id, topic]));
  const byState: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  for (const topic of live) {
    byState[topic.nameState] = (byState[topic.nameState] ?? 0) + 1;
    const source = topic.nameSource ?? "none";
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  const naming = {
    changeSets: 0,
    calls: 0,
    repairCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    asked: 0,
    firstTryAccepted: 0,
    repairAccepted: 0
  };
  let namedByModel = 0;
  for (const changeSet of document.changeSets.items) {
    if (changeSet.origin !== "naming" || changeSet.status === "dismissed") continue;
    const summary = (changeSet.summary ?? {}) as Record<string, unknown>;
    naming.changeSets += 1;
    for (const key of [
      "calls",
      "repairCalls",
      "failedCalls",
      "inputTokens",
      "outputTokens",
      "asked",
      "firstTryAccepted",
      "repairAccepted"
    ] as const) {
      naming[key] += numberOf(summary[key]);
    }
    namedByModel += numberOf(summary.llm);
  }

  // Sibling titles compared the way I7 compares them.
  const siblings = new Map<string, Set<string>>();
  let duplicates = 0;
  for (const topic of live) {
    if (topic.title === null || topic.parentId === null) continue;
    const taken = siblings.get(topic.parentId) ?? new Set<string>();
    const key = normalizeTopicTitle(topic.title);
    if (taken.has(key)) duplicates += 1;
    taken.add(key);
    siblings.set(topic.parentId, taken);
  }
  const named = live.filter((topic) => topic.title !== null);
  const generated = named.filter(
    (topic) => topic.nameSource === "llm" || topic.nameSource === "tfidf"
  );
  const llm = named.filter((topic) => topic.nameSource === "llm");
  let agrees = 0;
  let disagrees = 0;
  for (const topic of llm) {
    if (topic.description === null || content === null) continue;
    const guess = guessLanguage(topic.description, 3, 2).language;
    if (guess === null) continue;
    if (guess === content) agrees += 1;
    else disagrees += 1;
  }
  const englishTitles =
    content === null || content === "en"
      ? 0
      : llm.filter(
          (topic) =>
            tokenize(topic.title as string).length >= 2 &&
            guessLanguage(topic.title as string, 1, 1).language === "en"
        ).length;

  // Names to check by hand: evenly spaced through the titles in alphabetical order.
  const ordered = [...named].sort((a, b) =>
    normalizeTopicTitle(a.title as string).localeCompare(normalizeTopicTitle(b.title as string))
  );
  const wanted = Math.min(options.sample ?? 20, ordered.length);
  const sample = Array.from({ length: wanted }, (_, index) => {
    const topic = ordered[
      Math.floor((index * ordered.length) / wanted)
    ] as (typeof ordered)[number];
    const parent = topic.parentId ? byId.get(topic.parentId) : undefined;
    return {
      path: parent?.title ? `${parent.title} › ${topic.title}` : String(topic.title),
      description: topic.description,
      source: topic.nameSource
    };
  });

  return {
    contentLanguage: options.contentLanguage,
    topics: live.length,
    byState,
    bySource,
    unnamedShare: share(byState.unnamed ?? 0, live.length),
    naming: {
      ...naming,
      firstTryValidity: share(naming.firstTryAccepted, naming.asked),
      repairRate: share(naming.asked - naming.firstTryAccepted, naming.asked),
      callsPerNamedTopic: round((naming.calls + naming.repairCalls) / Math.max(1, namedByModel), 3),
      tokensPerNamedTopic: round(
        (naming.inputTokens + naming.outputTokens) / Math.max(1, namedByModel),
        1
      )
    },
    quality: {
      siblingDuplicates: duplicates,
      identifierShaped: named.filter((topic) => isIdentifierShaped(topic.title as string)).length,
      languageFieldMatch: share(
        generated.filter((topic) =>
          sameContentLanguage(topic.nameLanguage, options.contentLanguage)
        ).length,
        generated.length
      ),
      descriptionAgrees: agrees,
      descriptionDisagrees: disagrees,
      englishTitles
    },
    sample
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      language: { type: "string", default: "pt-BR" },
      sample: { type: "string", default: "20" },
      out: { type: "string" }
    }
  });
  const file = positionals[0];
  if (!file) throw new Error("Usage: naming-report.ts <export.json> [--language pt-BR]");
  const document = JSON.parse(await readFile(file, "utf8")) as NamingExport;
  const report = namingReport(document, {
    contentLanguage: values.language as string,
    sample: Number(values.sample)
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) await writeFile(values.out, text);
  process.stdout.write(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
