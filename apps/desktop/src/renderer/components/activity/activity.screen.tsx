import { useEffect, useRef } from "react";
import { createTranslator } from "@app/i18n";

import type { ScreenModule } from "../../workspace/surfaces";
import {
  budgetSnapshot,
  changeSet,
  idleStatus,
  inboxCounts,
  runningStatus
} from "./activity-fixtures";
import { ActivityHost } from "./ActivityHost";

export const surface = "activity";

const t = createTranslator("en");
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "gardener.status": runningStatus,
    "budget.snapshot": budgetSnapshot(),
    "inbox.counts": inboxCounts(3),
    "jobs.list": [{ status: "queued" }, { status: "queued" }, { status: "running" }],
    "changes.list": {
      items: [changeSet(1), changeSet(2, { titleParams: { items: 4 } }), changeSet(3)],
      nextCursor: null
    },
    "changes.undo": { status: "undone" },
    "knowledgeControls.update": null,
    "budget.continue": null
  },
  empty: {
    "gardener.status": idleStatus,
    "budget.snapshot": budgetSnapshot(),
    "inbox.counts": inboxCounts(0),
    "jobs.list": [],
    "changes.list": { items: [], nextCursor: null }
  }
};

/** The pill lives in the title bar and the drawer opens from it: the screen opens it, as a click would. */
function OpenActivity() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pill = host.current?.querySelector<HTMLButtonElement>("button[aria-expanded]");
    if (pill && pill.getAttribute("aria-expanded") === "false") pill.click();
  }, []);
  return (
    <div ref={host} className="flex justify-end">
      <ActivityHost t={t} onNavigate={noop} onOpenInbox={noop} />
    </div>
  );
}

export function render() {
  return <OpenActivity />;
}
