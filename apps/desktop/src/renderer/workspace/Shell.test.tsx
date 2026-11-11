import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "@app/i18n";

import { legacyViewIds } from "../../shared/app-menu";
import { legacyMenuViews } from "./LegacyMenu";
import { Rail, inboxWaitingText, railState } from "./Rail";
import { Shell, shellState, titleKey } from "./Shell";
import { TitleBar } from "./TitleBar";

const en = createTranslator("en");
const noop = () => undefined;

const rail = (inbox: Parameters<typeof Rail>[0]["inbox"], place = "explore" as const) =>
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

  it("reports loading, a failed count, none and some on its frame", () => {
    expect(railState({ status: "loading" })).toBe("loading");
    expect(railState({ status: "error" })).toBe("error");
    expect(railState({ status: "ready", value: 0 })).toBe("empty");
    expect(railState({ status: "ready", value: 2 })).toBe("success");
    expect(rail({ status: "loading" })).toContain('role="status" aria-busy="true"');
    expect(rail({ status: "error" })).toContain('role="alert"');
  });

  it("lists every remaining legacy view in the old screens menu", () => {
    expect(legacyMenuViews).toEqual([...legacyViewIds]);
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
      onAdd={noop}
      onAddMore={noop}
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
          onAdd={vi.fn()}
          onAddMore={vi.fn()}
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
