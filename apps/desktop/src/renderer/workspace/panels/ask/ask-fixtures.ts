import {
  formatObjectAddress,
  type ObjectLocateResult,
  type ObjectResolved,
  type ObjectResolveManyInput
} from "@app/domain";

import type { ConsultationDeltaParagraph } from "../../../../shared/app-events";
import type { QuestionListItemView, QuestionView } from "../../../../shared/ipc-questions";

/**
 * One synthetic Question for the Ask and Question panels' screens and tests (design record §17's
 * fermentation fixture): "Why do fermented foods keep longer outside the fridge?", answered in three
 * paragraphs that cite three passages of two sources. The titles and passages stand for the
 * person's own content and stay in English; every word of the app around them comes from
 * `@app/i18n`.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const askFixture = {
  questionId: uuid(31),
  requestId: uuid(32),
  questionAddress: `memora://question/${uuid(31)}`,
  topicId: uuid(4),
  noteAddress: `memora://note/${uuid(101)}`
} as const;

const sources = {
  micro: { id: uuid(11), title: "Food microbiology, ch. 3" },
  kefir: { id: uuid(12), title: "Kefir and kombucha at home" }
} as const;

const passages = [
  {
    source: sources.micro,
    chunk: uuid(51),
    span: uuid(61),
    text: "Lactic acid bacteria lower the pH of the food below 4.6, a range where most spoilage organisms and pathogens stop growing."
  },
  {
    source: sources.micro,
    chunk: uuid(52),
    span: uuid(62),
    text: "Fermentation does not sterilise the food: it fills the space with harmless organisms, so the dangerous ones find no room."
  },
  {
    source: sources.kefir,
    chunk: uuid(53),
    span: uuid(63),
    text: "A jar of sauerkraut keeps for months in a cool cupboard because the brine and the acid keep working after the jar is closed."
  }
] as const;

const citedAddress = (index: number) => {
  const passage = passages[index] as (typeof passages)[number];
  return formatObjectAddress({
    kind: "source",
    id: passage.source.id,
    anchor: { passage: passage.chunk, span: passage.span }
  });
};

/** The addresses of the three citations, in the order the answer cites them. */
export const citationAddresses = [0, 1, 2].map(citedAddress);

const paragraphMarkdown = [
  "Fermented foods keep because the bacteria that ferment them make the food too acid for spoilage organisms [e1].",
  "The acid is only half of it: the fermenting organisms also **take the space** that harmful ones would need [e2], and they keep working after the jar is closed [e3].",
  "So the shelf life outside the fridge depends on the acid and the salt, not on the cold."
];

const citationsOf = (paragraph: number) => (paragraph === 0 ? [1] : paragraph === 1 ? [2, 3] : []);

const storedCitation = (ordinal: number, stale: boolean) => {
  const passage = passages[ordinal - 1] as (typeof passages)[number];
  return {
    ordinal,
    address: formatObjectAddress({ kind: "source", id: passage.source.id }),
    anchor: { passage: passage.chunk, span: passage.span },
    unavailable: false,
    stale
  };
};

type Variant = "done" | "stale" | "noGrounding" | "running" | "failed" | "canceled";

/** A stored Question in one of the states a page can find it in. */
export function questionFixture(variant: Variant): QuestionView {
  const base = {
    id: askFixture.questionId,
    text: "Why do fermented foods keep longer outside the fridge?",
    language: "en",
    scope: { kind: "library" as const },
    privacy: "allow_remote" as const,
    mode: "text" as const,
    createdAt: "2026-11-11T09:12:00.000Z",
    updatedAt: "2026-11-11T09:13:00.000Z"
  };
  if (variant === "running") return { ...base, status: "running", answers: [] };
  if (variant === "failed")
    return { ...base, status: "failed", errorKey: "consultation.errors.rateLimited", answers: [] };
  const answerBase = {
    version: 1,
    model: { provider: "openai", model: "gpt", lane: "remote" },
    completedAt: "2026-11-11T09:13:00.000Z"
  };
  if (variant === "noGrounding")
    return {
      ...base,
      status: "complete",
      answers: [{ ...answerBase, status: "complete", paragraphs: [], stale: false }]
    };
  const paragraphs = paragraphMarkdown.map((markdown, index) => ({
    markdown,
    citations: citationsOf(index).map((ordinal) =>
      storedCitation(ordinal, variant === "stale" && ordinal === 3)
    )
  }));
  if (variant === "canceled")
    return {
      ...base,
      status: "canceled",
      answers: [
        { ...answerBase, status: "canceled", paragraphs: paragraphs.slice(0, 2), stale: false }
      ]
    };
  return {
    ...base,
    status: "complete",
    answers: [{ ...answerBase, status: "complete", paragraphs, stale: variant === "stale" }]
  };
}

/** The paragraphs a `consultation.delta` carries after `count` of them are complete. */
export function deltaParagraphs(count: number): ConsultationDeltaParagraph[] {
  return paragraphMarkdown.slice(0, count).map((markdown, index) => ({
    markdown,
    citations: citationsOf(index).map((ordinal) => ({
      ordinal,
      address: citationAddresses[ordinal - 1] as string
    }))
  }));
}

const resolved = (address: string): ObjectResolved | null => {
  const index = citationAddresses.indexOf(address);
  if (index >= 0) {
    const passage = passages[index] as (typeof passages)[number];
    return {
      address,
      kind: "source",
      title: passage.source.title,
      status: "current",
      preview: passage.text,
      updatedAt: "2026-11-01T10:00:00.000Z"
    };
  }
  const scope = Object.values(sources).find(
    (source) => address === formatObjectAddress({ kind: "source", id: source.id })
  );
  if (scope)
    return {
      address,
      kind: "source",
      title: scope.title,
      status: "current",
      preview: "",
      updatedAt: "2026-11-01T10:00:00.000Z"
    };
  if (address === formatObjectAddress({ kind: "topic", id: askFixture.topicId }))
    return {
      address,
      kind: "topic",
      title: "Lactic fermentation",
      status: "current",
      preview: "",
      updatedAt: "2026-11-01T10:00:00.000Z"
    };
  return null;
};

const topicPath = [
  { kind: "topic" as const, id: uuid(1), title: "" },
  { kind: "topic" as const, id: uuid(2), title: "Life sciences" },
  { kind: "topic" as const, id: uuid(3), title: "Microbiology" },
  { kind: "topic" as const, id: askFixture.topicId, title: "Lactic fermentation" }
];

const recent = (n: number, text: string, createdAt: string): QuestionListItemView => ({
  id: uuid(70 + n),
  text,
  language: "en",
  scope: { kind: "library" },
  status: "complete",
  createdAt,
  updatedAt: createdAt,
  answerCount: 1
});

export const recentQuestions: QuestionListItemView[] = [
  recent(1, "Why do fermented foods keep longer outside the fridge?", "2026-11-11T09:12:00.000Z"),
  recent(2, "Which strains survive the stomach acid?", "2026-11-09T18:40:00.000Z"),
  recent(3, "How much salt does a sauerkraut brine need?", "2026-11-04T07:05:00.000Z")
];

/**
 * The calls the Question panel and its frame make, answered from the fixture. `empty` is an answer
 * that found nothing to rest on; `question` is the Question the stored page reads.
 */
export function questionPanelFixtures(question: QuestionView) {
  const located: ObjectLocateResult = {
    object: { kind: "question", id: askFixture.questionId, title: question.text },
    // A Question that is still being answered has no citations yet, so no place (S4).
    primaryPath:
      question.status === "running"
        ? [{ kind: "question", id: askFixture.questionId, title: question.text }]
        : [...topicPath, { kind: "question", id: askFixture.questionId, title: question.text }],
    alsoIn: [],
    citedBy: [],
    counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 3, children: 0 }
  };
  return {
    "questions.get": question,
    "questions.ask": { questionId: askFixture.questionId, requestId: askFixture.requestId },
    "questions.askAgain": { requestId: askFixture.requestId },
    "questions.cancel": null,
    "objects.locate": () => located,
    "objects.resolveMany": (input: ObjectResolveManyInput) => {
      const items: Record<string, ObjectResolved> = {};
      const missing: string[] = [];
      for (const address of input.addresses) {
        const item = resolved(address);
        if (item) items[address] = item;
        else missing.push(address);
      }
      return { items, missing };
    }
  };
}

/** The calls the Ask panel makes: its recent questions (or none) and the Question it asks. */
export function askPanelFixtures(none: boolean) {
  return {
    ...questionPanelFixtures(questionFixture("running")),
    "questions.list": { items: none ? [] : recentQuestions }
  };
}
