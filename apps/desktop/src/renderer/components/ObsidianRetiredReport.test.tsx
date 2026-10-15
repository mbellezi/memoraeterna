import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes, type MessageKey } from "@app/i18n";

import { ObsidianRetiredReport } from "./ObsidianRetiredReport";

const t = createTranslator("en");
const escaped = (text: string) => text.replaceAll("'", "&#x27;");
const retired = (
  overrides: Partial<Parameters<typeof ObsidianRetiredReport>[0]["retired"]> = {}
) => ({
  archived: 0,
  absent: 0,
  keptTotal: 0,
  kept: [],
  ...overrides
});
const kept = (n: number, reason: "edited" | "unverified" | "unsafe" | "limit" = "edited") => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  relativePath: `Memora/Wiki/Topics/Topic ${n}.md`,
  reason
});
const render = (
  value: ReturnType<typeof retired>,
  props: { busy?: boolean; active?: boolean; translate?: typeof t } = {}
) =>
  renderToString(
    <ObsidianRetiredReport
      t={props.translate ?? t}
      retired={value}
      busy={props.busy ?? false}
      active={props.active ?? true}
      onMove={() => undefined}
    />
  );

describe("ObsidianRetiredReport", () => {
  it("shows nothing until an old wiki file was retired", () => {
    expect(render(retired())).toBe("");
  });

  it("counts the files moved to recovery and says edited files are kept", () => {
    const html = render(retired({ archived: 20 }));
    expect(html).toContain('data-testid="obsidian-retired-report"');
    expect(html).toContain(t("obsidianWiki.retiredTitle"));
    expect(html).toContain(t("obsidianWiki.retiredArchived"));
    expect(html).toContain(">20<");
    expect(html).toContain(t("obsidianWiki.retiredKept"));
    expect(html).toContain(">0<");
    expect(html).not.toContain(t("obsidianWiki.retiredMove"));
    expect(html).not.toContain(t("obsidianWiki.retiredAbsent"));
  });

  it("lists each kept file by path with a Move to recovery action and the reason", () => {
    const html = render(
      retired({
        archived: 20,
        absent: 1,
        keptTotal: 2,
        kept: [kept(5), kept(17, "unverified")]
      })
    );
    expect(html).toContain(t("obsidianWiki.retiredAbsent"));
    expect(html).toContain("Memora/Wiki/Topics/Topic 5.md");
    expect(html).toContain("Memora/Wiki/Topics/Topic 17.md");
    expect(html).toContain(t("obsidianWiki.retiredReasonEdited"));
    expect(html).toContain(t("obsidianWiki.retiredReasonUnverified"));
    expect(html.split(t("obsidianWiki.retiredMove")).length - 1).toBe(2);
    // A person never reads the registry ids.
    expect(html).not.toContain("00000000-0000-4000");
    // The action is named by the file it moves.
    expect(html).toContain("aria-describedby=");
  });

  it("disables the actions while a move is running or the sync is not active", () => {
    const value = retired({ keptTotal: 1, kept: [kept(5)] });
    expect(render(value, { busy: true })).toMatch(/<button[^>]*\sdisabled=""/);
    expect(render(value, { active: false })).toMatch(/<button[^>]*\sdisabled=""/);
    expect(render(value)).not.toMatch(/<button[^>]*\sdisabled=""/);
  });

  it("says when more files are kept than listed", () => {
    const html = render(
      retired({ keptTotal: 205, kept: Array.from({ length: 200 }, (_, n) => kept(n)) })
    );
    expect(html).toContain(">205<");
    expect(html).toContain(t("obsidianWiki.retiredMore"));
  });

  it("is translated in every locale", () => {
    const keys: MessageKey[] = [
      "obsidianWiki.retiredTitle",
      "obsidianWiki.retiredHint",
      "obsidianWiki.retiredArchived",
      "obsidianWiki.retiredAbsent",
      "obsidianWiki.retiredKept",
      "obsidianWiki.retiredMove",
      "obsidianWiki.retiredMore",
      "obsidianWiki.retiredReasonEdited",
      "obsidianWiki.retiredReasonUnverified",
      "obsidianWiki.retiredReasonUnsafe",
      "obsidianWiki.retiredReasonLimit",
      "obsidianWiki.errors.retired",
      "obsidianWiki.errors.retiredMove"
    ];
    for (const locale of supportedLanguageCodes) {
      const translate = createTranslator(locale);
      for (const key of keys) {
        expect(translate(key), `${locale} ${key}`).not.toContain("[[missing");
        if (locale !== "en") expect(translate(key), `${locale} ${key}`).not.toBe(t(key));
      }
      const html = render(
        retired({ archived: 3, absent: 1, keptTotal: 1, kept: [kept(1, "unsafe")] }),
        { translate }
      );
      expect(html).toContain(escaped(translate("obsidianWiki.retiredReasonUnsafe")));
    }
  });
});
