import { useReducer, type CSSProperties } from "react";

import { historyEntry, id, nodeSummary } from "../../../components/topics/topic-fixtures";
import { screenTranslator } from "../../screen-locale";
import { layoutCustomProperties } from "../../shell-model";
import { defaultWorkspace, reduce, type WorkspaceAction, type WorkspaceState } from "../../state";
import type { ScreenModule } from "../../surfaces";
import { useViewportWidth } from "../../use-workspace";
import { AddSourceContext } from "../../workspace-bridge";
import { ExploreNavigator } from "./ExploreNavigator";
import { Component } from "./ExploreRoot";

export const surface = "destination-explore";

const t = screenTranslator();
const noop = () => undefined;

const area = (n: number, title: string, items: number, children: number) =>
  nodeSummary({ id: id(n), title, items, children, directItems: 2, position: n });

const tree = {
  generation: 4,
  parent: nodeSummary({ id: id(1), title: null, items: 412, children: 6 }),
  nodes: [
    area(2, "Life sciences", 128, 3),
    area(3, "Nutrition", 96, 4),
    area(4, "Urban planning", 84, 2),
    area(5, "Music theory", 70, 3),
    area(
      6,
      "History of science and of the scientific method in Europe, from the Renaissance on",
      34,
      1
    ),
    area(7, "Physiology", 12, 0)
  ],
  items: [],
  moreItems: 0,
  unsorted: 5,
  nextCursor: null
};

/** One branch below "Life sciences": topics with long names, and a note and a source as leaves. */
const lifeSciences = {
  generation: 4,
  parent: tree.nodes[0]!,
  nodes: [
    area(20, "Microbiologia dos alimentos fermentados e de conservas", 54, 2),
    area(21, "Fermentação lática", 18, 0),
    area(22, "Imunologia", 22, 0)
  ],
  items: [],
  moreItems: 0,
  unsorted: 0,
  nextCursor: null
};

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "topics.tree": ({ parentId }: { parentId?: string | null }) =>
      parentId === id(2) ? lifeSciences : tree,
    "topics.notes": { items: [], nextCursor: null },
    "topics.path": null,
    "topics.status": {
      phase: "active",
      counts: { items: 412, placed: 407, pending: 0, needsGate: 0 }
    },
    "viewHistory.list": [
      historyEntry({
        address: `memora://topic/${id(2)}`,
        kind: "topic",
        id: id(2),
        title: "Life sciences",
        pinned: true
      }),
      historyEntry({
        address: `memora://note/${id(30)}`,
        kind: "note",
        id: id(30),
        title: "Temperature controls the final acidity of a ferment",
        parentAddress: `memora://source/${id(31)}`
      })
    ]
  },
  // An empty library: no topic and no item.
  empty: {
    "topics.tree": null,
    "topics.notes": { items: [], nextCursor: null },
    "topics.path": null,
    "topics.status": {
      phase: "active",
      counts: { items: 0, placed: 0, pending: 0, needsGate: 0 }
    },
    "viewHistory.list": []
  }
};

/** Explore as the shell draws it: its navigator with a topic open, and the root beside it. */
function Explore() {
  const width = useViewportWidth();
  const [workspace, dispatch] = useReducer(
    (state: WorkspaceState, action: WorkspaceAction) => reduce(state, action),
    undefined,
    // The topic with the long name is the open one: its row shows the whole name on two lines.
    () =>
      reduce(reduce(defaultWorkspace("2026-11-12"), { type: "go", destination: "explore" }), {
        type: "open",
        address: `memora://topic/${id(6)}`,
        from: -1,
        mode: "push"
      })
  );
  return (
    <AddSourceContext.Provider value={noop}>
      <div
        className="flex h-full bg-background"
        style={layoutCustomProperties(width) as CSSProperties}
      >
        <aside
          aria-label={t("workspace.navigator.label")}
          className="flex h-full w-(--nav-w) shrink-0 flex-col border-r border-border bg-background"
        >
          <div className="min-h-0 flex-1 overflow-y-auto py-3 pr-2 pl-3">
            <ExploreNavigator t={t} workspace={workspace} dispatch={dispatch} />
          </div>
        </aside>
        <div className="min-w-0 flex-1">
          <Component
            t={t}
            address="memora://explore"
            mode="full"
            active
            onState={noop}
            onPlace={noop}
            onOpen={noop}
          />
        </div>
      </div>
    </AddSourceContext.Provider>
  );
}

export function render() {
  return <Explore />;
}
