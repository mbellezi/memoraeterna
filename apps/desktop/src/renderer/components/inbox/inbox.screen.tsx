import { inboxKinds, type InboxItem } from "@app/domain";
import { createTranslator } from "@app/i18n";

import type { ScreenModule } from "../../workspace/surfaces";
import { countsOf, item, page, topicDiff } from "./inbox-fixtures";
import { InboxScreen } from "./InboxScreen";

export const surface = "inbox";

const t = createTranslator("en");
const noop = () => undefined;

/** One item of every kind, the first a reviewed topic overview with its change-set diff. */
const items: InboxItem[] = inboxKinds.map((kind) => item(kind));

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
