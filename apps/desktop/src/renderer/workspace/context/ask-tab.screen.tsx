import type { ScreenModule } from "../surfaces";
import { address, ContextColumn, ids, t } from "./context-fixtures";
import { AskTab } from "./ask-tab";

export const surface = "context-ask";

const sourceAddress = address("source", ids.source);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(700 + n).padStart(12, "0")}`;
const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();

const question = (n: number, text: string, daysAgo: number, scope: unknown) => ({
  id: uuid(n),
  text,
  language: "en",
  scope,
  status: "complete",
  createdAt: day(daysAgo),
  updatedAt: day(daysAgo),
  answerCount: 1
});

const sources = { kind: "sources", sourceIds: [ids.source] };

/** A source being read: its passages are indexed, its notes are still arriving. */
const progress = {
  run: {
    status: "running",
    stage: "atomicNotes",
    startedAt: day(0),
    completedAt: null,
    failedStage: null
  },
  needsYou: null,
  paused: false,
  steps: {
    read: { state: "done", pages: 64 },
    chunks: { state: "done", indexed: 142 },
    notes: { state: "running", soFar: 7, estimate: 18 },
    placed: { state: "running", count: 6 },
    summary: { state: "pending" },
    relations: { state: "pending", count: 0 }
  },
  sections: []
};

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "library.sourceProgress": () => progress,
    // Two of these are about this source; the one about the whole library is not listed here.
    "questions.list": () => ({
      items: [
        question(1, "How much salt goes into sauerkraut?", 1, sources),
        question(2, "Why does the brine have to cover the cabbage?", 4, sources),
        question(3, "Why do fermented foods keep longer outside the fridge?", 6, {
          kind: "library"
        })
      ]
    })
  },
  empty: {
    "library.sourceProgress": () => progress,
    "questions.list": () => ({ items: [] })
  }
};

const noop = () => undefined;

export function render() {
  return (
    <ContextColumn>
      <AskTab t={t} address={sourceAddress} kind="source" id={ids.source} active onOpen={noop} />
    </ContextColumn>
  );
}
