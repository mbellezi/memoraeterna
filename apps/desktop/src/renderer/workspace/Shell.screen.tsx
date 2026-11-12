import { idleStatus, inboxCounts, runningStatus } from "../components/activity/activity-fixtures";
import { id, nodeSummary } from "../components/topics/topic-fixtures";
import { AddFlow } from "./add/add-flow";
import { Shell } from "./Shell";
import { screenTranslator } from "./screen-locale";
import type { ScreenModule } from "./surfaces";

/** The shell and the rail fill the window: the screens tool shows them edge to edge. */
export const fullWindow = true;

export const surface = "shell";

const t = screenTranslator();
const noop = () => undefined;
const addFlow = new AddFlow({
  api: () => window.app,
  openSource: noop,
  openImportPanel: noop,
  storage: null
});

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
    "jobs.list": [{ status: "queued" }, { status: "queued" }, { status: "running" }],
    "gardener.status": runningStatus,
    "topics.tree": tree
  },
  empty: {
    "inbox.counts": inboxCounts(0),
    "jobs.list": [],
    "gardener.status": idleStatus,
    "topics.tree": null
  }
};

/**
 * Explore's content stands in for the panel stack and the destination roots that later cards bring
 * (T136, T141): an empty desk with no copy, so no language shows an untranslated heading. The shell's
 * own parts, the rail, the title bar with the Activity pill and the navigator host, are the real
 * components.
 */
function StandIn() {
  return <div aria-hidden="true" className="h-full bg-background" />;
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
      addFlow={addFlow}
      onNavigateActivity={noop}
      onOpenInbox={noop}
    >
      <StandIn />
    </Shell>
  );
}
