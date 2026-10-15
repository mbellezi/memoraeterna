import { describe, expect, it } from "vitest";

import { namingReport } from "./naming-report.js";
import type { NamingExport } from "./naming-report.js";

const topic = (
  id: string,
  parentId: string | null,
  title: string | null,
  fields: Partial<NamingExport["topics"][number]> = {}
): NamingExport["topics"][number] => ({
  id,
  parentId,
  role: parentId === null ? "root" : "topic",
  title,
  nameState: title === null ? "unnamed" : "named",
  nameSource: title === null ? null : "llm",
  nameLanguage: title === null ? null : "pt-BR",
  description:
    title === null
      ? null
      : "Reúne as notas sobre a prática de recuperar o que foi aprendido, não apenas o que você já sabia.",
  aliases: [],
  management: "ai",
  retiredAt: null,
  ...fields
});

const document: NamingExport = {
  topics: [
    topic("root", null, null),
    topic("a", "root", "Memória e aprendizagem"),
    topic("b", "root", "Mares e oceanos"),
    topic("a1", "a", "Prática de recuperação"),
    topic("a2", "a", "prática de RECUPERAÇÃO"),
    topic("b1", "b", "Theory of tides", { nameLanguage: "pt-BR" }),
    topic("b2", "b", "Correntes › correntes, calor", {
      nameState: "provisional",
      nameSource: "tfidf",
      description: null
    }),
    topic("b3", "b", null),
    topic("b4", "b", "T4"),
    topic("gone", "b", "Antigo", { retiredAt: "2026-10-15T00:00:00.000Z" })
  ],
  changeSets: {
    items: [
      {
        origin: "naming",
        status: "applied",
        summary: {
          llm: 2,
          calls: 1,
          repairCalls: 0,
          inputTokens: 1000,
          outputTokens: 200,
          asked: 2,
          firstTryAccepted: 2,
          repairAccepted: 0
        }
      },
      {
        origin: "naming",
        status: "applied",
        summary: {
          llm: 3,
          calls: 1,
          repairCalls: 1,
          failedCalls: 0,
          inputTokens: 2000,
          outputTokens: 400,
          asked: 4,
          firstTryAccepted: 3,
          repairAccepted: 1
        }
      },
      { origin: "place", status: "applied", summary: { placed: 10 } },
      { origin: "naming", status: "dismissed", summary: { llm: 9, calls: 9 } }
    ]
  }
};

describe("the naming report of a topic export", () => {
  const report = namingReport(document, { contentLanguage: "pt-BR", sample: 3 });

  it("counts live topics by state and source, and the unnamed share", () => {
    expect(report.topics).toBe(8);
    expect(report.byState).toEqual({ named: 6, provisional: 1, unnamed: 1 });
    expect(report.bySource).toEqual({ llm: 6, tfidf: 1, none: 1 });
    expect(report.unnamedShare).toBe(0.125);
  });

  it("sums what the naming change-sets recorded, never a dismissed one", () => {
    expect(report.naming).toMatchObject({
      changeSets: 2,
      calls: 2,
      repairCalls: 1,
      asked: 6,
      firstTryAccepted: 5,
      repairAccepted: 1,
      inputTokens: 3000,
      outputTokens: 600,
      firstTryValidity: 0.8333,
      repairRate: 0.1667,
      callsPerNamedTopic: 0.6,
      tokensPerNamedTopic: 720
    });
  });

  it("finds sibling duplicates, identifiers and English titles in a Portuguese library", () => {
    expect(report.quality.siblingDuplicates).toBe(1);
    expect(report.quality.identifierShaped).toBe(1);
    expect(report.quality.englishTitles).toBe(1);
    expect(report.quality.languageFieldMatch).toBe(1);
    expect(report.quality.descriptionAgrees).toBe(6);
    expect(report.quality.descriptionDisagrees).toBe(0);
  });

  it("samples names evenly in alphabetical order, with their parent", () => {
    expect(report.sample).toHaveLength(3);
    expect(report.sample.every((entry) => entry.path.length > 0)).toBe(true);
    const again = namingReport(document, { contentLanguage: "pt-BR", sample: 3 });
    expect(again.sample).toEqual(report.sample);
  });

  it("reads an export without naming change-sets as zero calls", () => {
    const empty = namingReport(
      { topics: document.topics, changeSets: { items: [] } },
      { contentLanguage: "pt-BR" }
    );
    expect(empty.naming).toMatchObject({ calls: 0, firstTryValidity: 0, callsPerNamedTopic: 0 });
  });
});
