import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { layoutConfig } from "../layout-config";
import { matchPanel, panelRegistry } from "../PanelStack";
import { destinationRoots } from "../destinations";
import { formatView } from "../route";
import { columnWidth, destinationColumns } from "./columns";
import { InboxRoot } from "./inbox/InboxRoot";
import { MapRoot, readMapAddress } from "./map/MapRoot";

const t = createTranslator("en");
const noop = () => undefined;
const props = {
  t,
  mode: "full" as const,
  active: false,
  onState: noop,
  onPlace: noop,
  onOpen: noop
};

describe("the destination roots in the panel stack", () => {
  it("are found by the stack's glob, ahead of nothing else: the Inbox and the Map take their roots", () => {
    expect(matchPanel(panelRegistry, destinationRoots.inbox)?.kind).toBe("destination-inbox");
    expect(matchPanel(panelRegistry, destinationRoots.map)?.kind).toBe("destination-map");
    expect(matchPanel(panelRegistry, formatView({ view: "map", lens: "shape" }))?.kind).toBe(
      "destination-map"
    );
    expect(matchPanel(panelRegistry, formatView({ view: "inbox", kind: "review" }))?.kind).toBe(
      "destination-inbox"
    );
  });

  it("take no object address and no other destination's root", () => {
    const inbox = panelRegistry.find((module) => module.kind === "destination-inbox")!;
    const map = panelRegistry.find((module) => module.kind === "destination-map")!;
    for (const address of [
      "memora://note/00000000-0000-4000-8000-000000000001",
      destinationRoots.home,
      destinationRoots.library,
      destinationRoots.explore
    ]) {
      expect(inbox.match(address), address).toBe(false);
      expect(map.match(address), address).toBe(false);
    }
    expect(inbox.match(destinationRoots.map)).toBe(false);
    expect(map.match(destinationRoots.inbox)).toBe(false);
  });

  it("name themselves by their destination, in the person's language", () => {
    const inbox = panelRegistry.find((module) => module.kind === "destination-inbox")!;
    expect(inbox.title(null, createTranslator("pt-BR"))).toBe("Caixa de entrada");
    expect(panelRegistry.find((module) => module.kind === "destination-map")!.title(null, t)).toBe(
      "Map"
    );
  });
});

describe("a root reports its own surface and state", () => {
  it("draws the Inbox root as a destination-inbox frame that starts loading", () => {
    const html = renderToString(<InboxRoot {...props} address={destinationRoots.inbox} />);
    expect(html).toContain('data-surface="destination-inbox"');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("<h1");
  });

  it("draws the Map root with its two views, Árvore first, and the placeholder for the graph", () => {
    const html = renderToString(<MapRoot {...props} address={destinationRoots.map} />);
    expect(html).toContain('data-surface="destination-map"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Tree<");
    expect(html).toContain(">Graph<");
    // The default address names the relations view, which is a placeholder until T151.
    expect(html).toContain("The graph of connections is on its way");
    expect(html).toContain('data-state="empty"');
  });

  it("opens the tree view from an address that names it", () => {
    const html = renderToString(
      <MapRoot {...props} address={formatView({ view: "map", lens: "shape" })} />
    );
    expect(html).toContain('data-state="loading"');
    expect(html).not.toContain("The graph of connections is on its way");
  });

  it("shows only the heading as the previous panel, with no views to switch", () => {
    const html = renderToString(
      <MapRoot {...props} mode="compact" address={formatView({ view: "map", lens: "shape" })} />
    );
    expect(html).not.toContain('role="tablist"');
    // No tab panel either: it would be labelled by a tab that is not there.
    expect(html).not.toContain('role="tabpanel"');
    expect(html).not.toContain("aria-labelledby");
    expect(renderToString(<MapRoot {...props} address={destinationRoots.map} />)).toContain(
      'role="tabpanel"'
    );
  });

  it("reports the previous-panel forms as surfaces of their own, so the screens tool captures them", () => {
    const map = renderToString(
      <MapRoot {...props} mode="compact" address={formatView({ view: "map", lens: "shape" })} />
    );
    const inbox = renderToString(
      <InboxRoot {...props} mode="compact" address={destinationRoots.inbox} />
    );
    expect(map).toContain('data-surface="destination-map-compact"');
    expect(inbox).toContain('data-surface="destination-inbox-compact"');
    expect(renderToString(<InboxRoot {...props} address={destinationRoots.inbox} />)).toContain(
      'data-surface="destination-inbox"'
    );
  });

  it("reads the lens and the topic the person came from out of the root's address", () => {
    const id = "00000000-0000-4000-8000-000000000004";
    expect(
      readMapAddress(formatView({ view: "map", lens: "shape", scope: { kind: "topic", id } }))
    ).toEqual({ lens: "shape", scope: `memora://topic/${id}` });
    expect(readMapAddress(destinationRoots.map)).toEqual({ lens: "relations", scope: null });
    expect(readMapAddress(destinationRoots.inbox)).toEqual({ lens: "relations", scope: null });
  });
});

describe("the side columns of the roots", () => {
  it("are 360 and 400 px, and 300 and 320 px below 1180 px", () => {
    expect(destinationColumns.inboxList).toEqual({ standard: 360, compact: 300 });
    expect(destinationColumns.mapInspector).toEqual({ standard: 400, compact: 320 });
    for (const [width, list, inspector] of [
      [960, 300, 320],
      [1179, 300, 320],
      [1180, 360, 400],
      [1440, 360, 400]
    ] as const) {
      expect(columnWidth("inboxList", width), `${width}`).toBe(list);
      expect(columnWidth("mapInspector", width), `${width}`).toBe(inspector);
    }
    expect(layoutConfig.compactBelow).toBe(1180);
  });
});
