import type { ScreenModule } from "../surfaces";
import { ContextColumn, focusedNote, t } from "./context-fixtures";
import { HistoryTab } from "./history-tab";

export const surface = "context-history";

const hourMs = 60 * 60 * 1000;
const at = (hours: number) => new Date(Date.now() - hours * hourMs).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`;

const change = (
  n: number,
  fields: {
    kind?: "topic" | "relation" | "overview";
    titleKey: string;
    titleParams?: Record<string, string | number>;
    origin: string;
    status?: "applied" | "undone" | "pending_review" | "dismissed";
    undo: "available" | "blocked" | "unavailable";
    hours: number;
  }
) => ({
  kind: fields.kind ?? "topic",
  id: uuid(n),
  titleKey: fields.titleKey,
  titleParams: fields.titleParams ?? {},
  risk: "low",
  status: fields.status ?? "applied",
  origin: fields.origin,
  subjectId: null,
  jobId: null,
  at: at(fields.hours),
  undoneAt: fields.status === "undone" ? at(fields.hours - 1) : null,
  undo: fields.undo
});

/** What happened to the note in focus, newest first: a mix of the stores and of the states a row has. */
const changes = [
  change(1, {
    kind: "relation",
    titleKey: "changes.titles.relationMatched",
    titleParams: { note: "Lactic acid inhibits pathogens by lowering the pH" },
    origin: "match",
    undo: "available",
    hours: 2
  }),
  change(2, {
    titleKey: "topics.changeSets.proposal",
    titleParams: { items: 9 },
    origin: "rebalance",
    status: "pending_review",
    undo: "unavailable",
    hours: 9
  }),
  change(3, {
    titleKey: "topics.changeSets.humanMove",
    origin: "human",
    undo: "blocked",
    hours: 27
  }),
  change(4, {
    kind: "relation",
    titleKey: "changes.titles.relation.reconcile",
    origin: "reconcile",
    status: "undone",
    undo: "unavailable",
    hours: 52
  }),
  change(5, {
    titleKey: "topics.changeSets.place",
    titleParams: { items: 12 },
    origin: "place",
    undo: "available",
    hours: 76
  })
];

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "changes.forObject": () => ({ items: changes }),
    "changes.undo": () => ({ status: "undone", kind: "topic", id: uuid(5) })
  },
  empty: { "changes.forObject": () => ({ items: [] }) }
};

const noop = () => undefined;

export function render() {
  return (
    <ContextColumn>
      <HistoryTab
        t={t}
        address={focusedNote.address}
        kind="note"
        id={focusedNote.id}
        active
        onOpen={noop}
      />
    </ContextColumn>
  );
}
