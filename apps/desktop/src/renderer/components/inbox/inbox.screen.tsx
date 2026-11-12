import { inboxKinds, type InboxItem } from "@app/domain";

import { screenTranslator } from "../../workspace/screen-locale";
import type { ScreenModule } from "../../workspace/surfaces";
import { countsOf, item, page, topicDiff, uuid } from "./inbox-fixtures";
import { InboxScreen } from "./InboxScreen";

export const surface = "inbox";

const t = screenTranslator();
const noop = () => undefined;

/**
 * The suggestions come first so the capture selects one: a medium one at 64% and one whose decider
 * wrote no probability (D33: "unknown confidence", no number); then one item of every other kind.
 */
const items: InboxItem[] = [
  item("suggestion"),
  item("suggestion", {
    id: uuid(83),
    params: { relationType: "extends", probability: null },
    objects: [
      { kind: "note", id: uuid(84), title: "Magnesium and sleep depth" },
      { kind: "note", id: uuid(85), title: "Evening routines" }
    ]
  }),
  ...inboxKinds.filter((kind) => kind !== "suggestion").map((kind) => item(kind))
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
