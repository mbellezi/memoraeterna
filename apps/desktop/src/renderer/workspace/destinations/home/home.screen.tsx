import type { CSSProperties } from "react";

import { destinationRoots } from "../../destinations";
import { screenTranslator } from "../../screen-locale";
import { layoutCustomProperties } from "../../shell-model";
import { defaultWorkspace } from "../../state";
import { AddSourceContext, WorkspaceBridgeContext } from "../../workspace-bridge";
import type { ScreenModule } from "../../surfaces";
import { homeDigest, ids } from "./home-fixtures";
import { HomeRoot } from "./HomeRoot";

/** Home fills the content area of the window: the rail's width stands empty beside it. */
export const fullWindow = true;

export const surface = "destination-home";

const t = screenTranslator();
const noop = () => undefined;

const processing = {
  rows: [{ id: ids.generatingSource }],
  total: 1
};

const progress = {
  run: null,
  needsYou: null,
  paused: false,
  steps: {
    read: { state: "done", pages: 24 },
    chunks: { state: "done", indexed: 40 },
    notes: { state: "running", soFar: 7, estimate: 18 },
    placed: { state: "running", count: 5 },
    summary: { state: "pending" },
    relations: { state: "pending", count: 0 }
  },
  sections: []
};

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "home.digest": () => homeDigest(Date.now()),
    "library.rows": processing,
    "library.sourceProgress": progress,
    "changes.undo": { status: "undone", kind: "topic", id: ids.question }
  },
  empty: {
    "home.digest": () => homeDigest(Date.now(), { firstRun: true }),
    "library.rows": { rows: [], total: 0 },
    "library.sourceProgress": null
  }
};

/** Home was last opened yesterday evening: the briefing says "while you were away". */
const bridge = {
  workspace: {
    ...defaultWorkspace("2026-11-11"),
    lastHomeOpenAt: new Date(Date.now() - 12 * 3_600_000).toISOString()
  },
  dispatch: noop
};

/** Home in the panel stack's root slot (the app provides the Add command, so the first run's button is live), with the rail's width beside it as in the window. */
export function render() {
  return (
    <WorkspaceBridgeContext.Provider value={bridge}>
      <AddSourceContext.Provider value={noop}>
        <div
          className="flex h-screen bg-background text-foreground"
          style={layoutCustomProperties(window.innerWidth) as CSSProperties}
        >
          <div
            aria-hidden="true"
            className="shrink-0 border-r border-border bg-surface"
            style={{ width: "var(--rail-w)" }}
          />
          <div className="min-w-0 flex-1">
            <HomeRoot
              t={t}
              address={destinationRoots.home}
              mode="full"
              active
              onState={noop}
              onPlace={noop}
              onOpen={noop}
            />
          </div>
        </div>
      </AddSourceContext.Provider>
    </WorkspaceBridgeContext.Provider>
  );
}
