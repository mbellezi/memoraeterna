import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { TopicNoticeHost } from "./TopicNoticeHost";
import { TopicNoticeCenter } from "./topic-notice-center";
import { pinNotice } from "./topic-ops";

const en = createTranslator("en");
const sources = import.meta.glob<string>(["../../../**/*.tsx", "!../../../**/*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true
});
const plain = (html: string) => html.replaceAll("<!-- -->", "");

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const newCenter = () =>
  new TopicNoticeCenter(() => ({
    undo: async () => ({ status: "undone", changeSetId: id(900), generation: 1 })
  }));

describe("the window's one notice host", () => {
  it("keeps a polite live region on the page with nothing to say", () => {
    const html = plain(renderToString(<TopicNoticeHost t={en} center={newCenter()} />));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("data-topic-notice");
  });

  it("draws the newest notice of any view, once, at one place", () => {
    const center = newCenter();
    center.show(pinNotice(true, "From the navigator"), id(1), "idle");
    center.show(pinNotice(false, "From the Topic page"), id(2), "idle");
    const html = plain(renderToString(<TopicNoticeHost t={en} center={center} />));
    expect(html.match(/data-topic-notice/g)).toHaveLength(1);
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain("Unpinned From the Topic page.");
    expect(html).not.toContain("From the navigator");
    expect(html).toMatch(/aria-keyshortcuts="U"/);
  });

  it("shows the states of the notice it holds: undoing, blocked and failed", () => {
    for (const [state, text] of [
      ["pending", "Undoing..."],
      ["blocked", "a later change depends on it"],
      ["failed", "could not be undone"]
    ] as const) {
      const center = newCenter();
      center.show(pinNotice(true, "Memory"), id(1), state);
      expect(plain(renderToString(<TopicNoticeHost t={en} center={center} />)), state).toContain(
        text
      );
    }
  });

  it("is no longer mounted by the app: the Activity pill shows the notice (T135), and no view draws one", () => {
    const filesWith = (pattern: RegExp) =>
      Object.entries(sources)
        .filter(([, source]) => pattern.test(source))
        .map(([file]) => file);
    expect(filesWith(/<TopicNoticeHost[\s>]/u)).toEqual([]);
    expect(filesWith(/<TopicUndoToast[\s>]/u)).toEqual(["./TopicNoticeHost.tsx"]);
  });
});
