import { createTranslator } from "@app/i18n";

import { idleStatus, inboxCounts, runningStatus } from "../components/activity/activity-fixtures";
import { id, nodeSummary } from "../components/topics/topic-fixtures";
import { Shell } from "./Shell";
import type { ScreenModule } from "./surfaces";

export const surface = "shell";

const t = createTranslator("en");
const noop = () => undefined;

const tree = {
  generation: 4,
  parent: nodeSummary({ id: id(1), title: null, items: 412, children: 5 }),
  nodes: [
    nodeSummary({ id: id(2), title: "Life sciences", items: 128, children: 3, position: 0 }),
    nodeSummary({ id: id(3), title: "Nutrition", items: 96, children: 4, position: 1 }),
    nodeSummary({ id: id(4), title: "Urban planning", items: 84, children: 2, position: 2 }),
    nodeSummary({ id: id(5), title: "Music theory", items: 70, children: 3, position: 3 }),
    nodeSummary({ id: id(6), title: "History of science", items: 34, children: 1, position: 4 })
  ],
  items: [],
  moreItems: 0,
  unsorted: 5,
  nextCursor: null
};

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "inbox.counts": inboxCounts(3),
    "gardener.status": runningStatus,
    "topics.tree": tree
  },
  empty: {
    "inbox.counts": inboxCounts(0),
    "gardener.status": idleStatus,
    "topics.tree": null
  }
};

/**
 * Explore's content stands in for the panel stack and the destination roots that later cards bring
 * (T136, T141): a sheet on the desk with the words an empty Explore has. The shell's own parts, the
 * rail, the title bar with the Activity pill and the navigator host, are the real components.
 */
function StandIn() {
  return (
    <div className="grid h-full place-items-center bg-background p-8">
      <div className="max-w-(--measure) rounded-lg bg-surface p-8 shadow-[var(--shadow-sheet)]">
        <h2 className="m-0 font-reading text-2xl font-semibold text-foreground">
          Nothing open yet
        </h2>
        <p className="mt-2 text-base text-secondary-foreground">
          Open a topic from the tree, or press ⌘K to search, open or ask.
        </p>
      </div>
    </div>
  );
}

export function render() {
  return (
    <Shell
      t={t}
      place="explore"
      navigatorOn
      onGo={noop}
      onOpenLegacy={noop}
      onOpenPalette={noop}
      onAdd={noop}
      onAddMore={noop}
      onNavigateActivity={noop}
      onOpenInbox={noop}
    >
      <StandIn />
    </Shell>
  );
}
