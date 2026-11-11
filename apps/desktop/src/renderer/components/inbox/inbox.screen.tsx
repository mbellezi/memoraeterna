import { inboxKinds, type InboxItem } from "@app/domain";

import { screenTranslator } from "../../workspace/screen-locale";
import type { ScreenModule } from "../../workspace/surfaces";
import { countsOf, item, page, topicDiff, uuid } from "./inbox-fixtures";
import { InboxScreen } from "./InboxScreen";

export const surface = "inbox";

const t = screenTranslator();
const noop = () => undefined;

/**
 * One item of every kind, the first a reviewed topic overview with its change-set diff, and a
 * second suggestion whose decider wrote no probability (D33: "unknown confidence", no number).
 */
const items: InboxItem[] = [
  ...inboxKinds.map((kind) => item(kind)),
  item("suggestion", {
    id: uuid(83),
    params: { relationType: "extends", probability: null },
    objects: [
      { kind: "note", id: uuid(84), title: "Magnesium and sleep depth" },
      { kind: "note", id: uuid(85), title: "Evening routines" }
    ]
  })
];

const list =
  (all: readonly InboxItem[]) => (query: { kind?: string | null; risk?: string | null }) =>
    page(
      all.filter(
        (entry) =>
          (!query?.kind || entry.kind === query.kind) && (!query?.risk || entry.risk === query.risk)
      )
    );

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "inbox.list": list(items),
    "inbox.counts": countsOf(items),
    "changes.diff": topicDiff(),
    "inbox.act": { status: "done" }
  },
  empty: {
    "inbox.list": list([]),
    "inbox.counts": countsOf([]),
    "changes.diff": null
  }
};

export function render() {
  return <InboxScreen t={t} active onNavigate={noop} onOpenConnections={noop} />;
}
