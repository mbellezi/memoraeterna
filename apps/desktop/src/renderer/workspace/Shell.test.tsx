import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { legacyViewIds } from "../../shared/app-menu";
import type { WorkspacePlace } from "./destinations";
import { AddMenu } from "./add/AddMenu";
import { AddFlow } from "./add/add-flow";
import { LegacyMenu, legacyMenuViews } from "./LegacyMenu";
import { Rail, inboxWaitingText, railState } from "./Rail";
import { NavigatorHost } from "./NavigatorHost";
import { Shell, shellState, titleKey } from "./Shell";
import { railCurrentClass, railIdleClass, railItemClass } from "./rail-styles";
import { hostedViewIds, layoutCustomProperties } from "./shell-model";
import { TitleBar } from "./TitleBar";

const en = createTranslator("en");
const noop = () => undefined;
/** A flow over no window: the menu and the drop host only read its snapshot while rendered to a string. */
const addFlow = new AddFlow({
  api: () => ({}) as never,
  openSource: noop,
  openImportPanel: noop,
  storage: null
});

const rail = (inbox: Parameters<typeof Rail>[0]["inbox"], place: WorkspacePlace = "explore") =>
  renderToString(<Rail t={en} place={place} inbox={inbox} onGo={noop} onOpenLegacy={noop} />);

describe("the rail", () => {
  it("has exactly five destinations plus Settings and the old screens", () => {
    const html = rail({ status: "ready", value: 0 });
    expect(html.match(/<button/g)).toHaveLength(7);
    expect(html).toContain('aria-label="Inbox"');
    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("shows the Inbox count as the one filled badge, named in words, and hides it at 0", () => {
    const html = rail({ status: "ready", value: 3 });
    expect(html).toContain("Inbox, 3 decisions are waiting for you");
    expect(html).toContain("bg-warning");
    expect(rail({ status: "ready", value: 0 })).not.toContain("bg-warning");
    expect(rail({ status: "ready", value: 250 })).toContain("99+");
    expect(inboxWaitingText(en, 1)).toBe("1 decision is waiting for you");
  });

  it("marks the old screens item, not a destination, while an old view is on screen", () => {
    const html = renderToString(
      <Rail
        t={en}
        place="explore"
        legacyView="search"
        inbox={{ status: "ready", value: 0 }}
        onGo={noop}
        onOpenLegacy={noop}
      />
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Old screens that are still available" aria-current="page"/u);
  });

  it("gives the current item the accent colour and never the idle grey beside it", () => {
    // `cn` only joins strings and the stylesheet puts the grey after the accent: one never carries both.
    expect(railItemClass).not.toContain("text-secondary-foreground");
    expect(railCurrentClass).toContain("text-accent");
    expect(railCurrentClass).not.toContain("text-secondary-foreground");
    expect(railIdleClass).toContain("text-secondary-foreground");
    const classes = (html: string) =>
      [...html.matchAll(/<button[^>]*class="([^"]*)"/gu)].map((match) => match[1] ?? "");
    const html = rail({ status: "ready", value: 0 });
    const current = [...html.matchAll(/<button[^>]*aria-current="page"[^>]*class="([^"]*)"/gu)];
    expect(current).toHaveLength(1);
    expect(current[0]?.[1]).toContain("text-accent");
    expect(current[0]?.[1]).not.toContain("text-secondary-foreground");
    expect(
      classes(html).filter((value) => value.includes("text-secondary-foreground"))
    ).toHaveLength(6);
    const settings = rail({ status: "ready", value: 0 }, "settings");
    expect(settings.match(/class="[^"]*text-accent[^"]*"/gu)?.length).toBeGreaterThanOrEqual(1);
    // The bar sits against the rail's edge at every tier: (item - rail) / 2.
    expect(railCurrentClass).toContain("before:left-[calc((var(--rail-item-w)-var(--rail-w))/2)]");
    expect(railCurrentClass).not.toContain("before:-left-1.5");
  });

  it("reports loading, a failed count, none and some on its frame", () => {
    expect(railState({ status: "loading" })).toBe("loading");
    expect(railState({ status: "error" })).toBe("error");
    expect(railState({ status: "ready", value: 0 })).toBe("empty");
    expect(railState({ status: "ready", value: 2 })).toBe("success");
    expect(rail({ status: "loading" })).toContain('role="status" aria-busy="true"');
    expect(rail({ status: "error" })).toContain('role="alert"');
  });

  it("lists in the old screens menu only the views no destination hosts", () => {
    const hosted: readonly string[] = Object.values(hostedViewIds);
    // The Map hosts the knowledge graph: it is a destination, never an "Old screens" item.
    expect(hosted).toContain("knowledgeGraph");
    expect(legacyViewIds.filter((view) => hosted.includes(view))).toEqual([]);
    expect(legacyMenuViews.filter((view) => hosted.includes(view))).toEqual([]);
    const html = renderToString(<LegacyMenu t={en} current={null} onOpen={noop} />);
    expect(html).toContain("Old screens that are still available");
    expect(legacyMenuViews.length).toBeGreaterThan(0);
  });
});

describe("the title bar", () => {
  const html = renderToString(
    <TitleBar
      t={en}
      title="Explore"
      onOpenPalette={noop}
      status={<span>pill</span>}
      add={<AddMenu t={en} flow={addFlow} portal={false} />}
    />
  );

  it("has the name, the omni trigger with its keycap, the status slot and Add, and no back, forward or Ask", () => {
    expect(html).toContain("<h1");
    expect(html).toContain("Search, open or ask…");
    expect(html).toContain("⌘K");
    expect(html).toContain("pill");
    expect(html).toContain('aria-label="Add source"');
    expect(html).toContain('aria-label="More ways to add"');
    expect(html).not.toMatch(/Back|Forward|Ask/u);
    expect(html).toContain("min-w-(--omni-min)");
  });

  it("names Settings, an old view or a destination", () => {
    expect(titleKey("settings", null)).toBe("workspace.rail.settings");
    expect(titleKey("inbox", null)).toBe("workspace.destinations.inbox");
    expect(titleKey("explore", "jobs")).toBe("shell.navigation.jobs");
  });
});

describe("the shell frame", () => {
  it("reports error before loading before empty before success", () => {
    const ready = { status: "ready" as const };
    expect(shellState({ status: "error" }, { status: "loading" })).toBe("error");
    expect(shellState({ status: "ready" }, { status: "loading" })).toBe("loading");
    expect(shellState(ready, { status: "ready", empty: true })).toBe("empty");
    expect(shellState(ready, { status: "ready", empty: false })).toBe("success");
    expect(shellState(ready, null)).toBe("success");
    expect(shellState({ status: "loading" }, null)).toBe("loading");
  });

  it("hosts the navigator in Explore only, and writes the layout properties", () => {
    const render = (place: "explore" | "home") =>
      renderToString(
        <Shell
          t={en}
          place={place}
          navigatorOn
          onGo={vi.fn()}
          onOpenLegacy={vi.fn()}
          onOpenPalette={vi.fn()}
          addFlow={addFlow}
          onNavigateActivity={vi.fn()}
          onOpenInbox={vi.fn()}
        >
          <p>content</p>
        </Shell>
      );
    const explore = render("explore");
    expect(explore).toContain('aria-label="Navigator"');
    expect(explore).toContain("--rail-w:");
    expect(explore).toContain("--omni-min:240px");
    expect(render("home")).not.toContain('aria-label="Navigator"');
    expect(explore).toContain("content");
  });
});

describe("the rail's marks and items", () => {
  it("cuts the Inbox badge and the failed-count triangle out of the icon with a ring in the desk colour", () => {
    const ring = "[box-shadow:0_0_0_2px_var(--surface-canvas)]";
    expect(rail({ status: "ready", value: 3 })).toContain(ring);
    expect(rail({ status: "error" })).toContain(ring);
  });

  it("sizes an item from --rail-item-w with no side padding (60 px, 56 at the compact rail)", () => {
    expect(railItemClass).toContain("w-(--rail-item-w)");
    expect(railItemClass).not.toMatch(/\bpx-/u);
    expect(layoutCustomProperties(1440)["--rail-item-w"]).toBe("60px");
    expect(layoutCustomProperties(1180)["--rail-item-w"]).toBe("60px");
    expect(layoutCustomProperties(1179)["--rail-item-w"]).toBe("56px");
    expect(layoutCustomProperties(960)["--rail-item-w"]).toBe("56px");
  });
});

describe("the navigator's states", () => {
  const retry = vi.fn();
  const host = (tree: Parameters<typeof NavigatorHost>[0]["tree"], compact = false) =>
    renderToString(<NavigatorHost t={en} tree={tree} compact={compact} />);
  const ready = {
    status: "ready" as const,
    value: {
      topics: [{ id: "t1", title: "Nutrition", items: 96, children: 4, health: "good" as const }],
      total: 412,
      unsorted: 0
    },
    retry
  };

  it("keeps the Tree header in every state, so the column does not jump", () => {
    for (const tree of [
      { status: "loading" as const, retry },
      { status: "error" as const, retry }
    ])
      expect(host(tree)).toContain(">Tree</h2>");
    expect(host(ready)).toContain(">Tree</h2>");
  });

  it("says a failed read in place: a plain sentence with a solid glyph and a link, not a danger card", () => {
    const html = host({ status: "error", retry });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load the tree.");
    expect(html).toContain("Your sources and notes are untouched.");
    expect(html).toContain(">Try again<");
    expect(html).not.toContain("bg-danger-soft");
    expect(html).not.toContain("border-danger");
    expect(html).toContain("<svg"); // the solid triangle, not an outline icon
    expect(html).not.toContain("lucide");
  });

  it("shows counts on hover and focus only at the compact tier", () => {
    expect(host(ready, true)).toContain("hidden group-hover:block group-focus-visible:block");
    expect(host(ready, false)).not.toContain("group-hover:block");
  });
});
