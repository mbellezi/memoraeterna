import { inboxKinds, type InboxItem } from "@app/domain";

import { screenTranslator } from "../../workspace/screen-locale";
import type { ScreenModule } from "../../workspace/surfaces";
import { countsOf, item, page, topicDiff, uuid } from "./inbox-fixtures";
import { InboxScreen } from "./InboxScreen";

export const surface = "inbox";

const t = screenTranslator();
const noop = () => undefined;

/**
 * The page is by risk, oldest first, so the capture opens on a suggestion: the 64% one is the
 * riskiest and the oldest; another, whose decider wrote no probability (D33: "unknown confidence",
 * no number), is a medium one; then one item of every other kind.
 */
const items: InboxItem[] = [
  item("suggestion", { risk: "high", at: "2026-10-23T05:00:00.000000Z" }),
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

const riskRank = { high: 0, medium: 1, low: 2 } as const;

/** The page as the repository gives it: by risk (high first), then oldest first. */
const list =
  (all: readonly InboxItem[]) => (query: { kind?: string | null; risk?: string | null }) =>
    page(
      all
        .filter(
          (entry) =>
            (!query?.kind || entry.kind === query.kind) &&
            (!query?.risk || entry.risk === query.risk)
        )
        .sort((a, b) => riskRank[a.risk] - riskRank[b.risk] || a.at.localeCompare(b.at))
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
