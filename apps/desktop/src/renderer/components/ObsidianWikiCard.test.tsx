import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import {
  DeliveryProgress,
  isFailedFile,
  ObsidianFailedFiles,
  ObsidianWikiCard
} from "./ObsidianWikiCard";

const t = createTranslator("en");
const escaped = (text: string) => text.replaceAll("'", "&#x27;");
const row = (n: number, status: string, error: string | null) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  memora_id: `00000000-0000-4000-8000-${String(100 + n).padStart(12, "0")}`,
  relative_path: `Memora/Tópicos/Area/Topic ${n}/Topic ${n}.md`,
  status,
  error
});

afterEach(() => vi.unstubAllGlobals());

describe("ObsidianWikiCard", () => {
  it("shows the loading state and no wiki page picker while the status loads", () => {
    vi.stubGlobal("window", {
      app: {
        obsidian: { wikiStatus: () => new Promise(() => undefined) },
        settings: {}
      }
    });
    const html = renderToString(<ObsidianWikiCard t={t} />);
    expect(html).toContain(t("obsidianWiki.title"));
    expect(html).toContain(t("obsidianWiki.loading"));
    expect(html).not.toContain("<select");
  });

  it("separates the files that failed alone from the edits to review", () => {
    expect(isFailedFile(row(1, "error", "obsidianWiki.errors.limit"))).toBe(true);
    expect(isFailedFile(row(2, "error", "obsidianWiki.errors.format"))).toBe(true);
    expect(isFailedFile(row(3, "conflict", "obsidianWiki.errors.conflict"))).toBe(false);
    expect(isFailedFile(row(4, "error", "obsidianWiki.errors.write"))).toBe(false);
  });
});

describe("ObsidianFailedFiles", () => {
  it("shows nothing when every file was written", () => {
    expect(renderToString(<ObsidianFailedFiles t={t} failed={[]} />)).toBe("");
  });

  it("names each file that was not written and why", () => {
    const html = renderToString(
      <ObsidianFailedFiles
        t={t}
        failed={[
          row(1, "error", "obsidianWiki.errors.limit"),
          row(2, "error", "obsidianWiki.errors.format")
        ]}
      />
    );
    expect(html).toContain(t("obsidianWiki.failedTitle"));
    expect(html).toContain("Memora/Tópicos/Area/Topic 1/Topic 1.md");
    expect(html).toContain(escaped(t("obsidianWiki.fileTooLarge")));
    expect(html).toContain(escaped(t("obsidianWiki.errors.format")));
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("DeliveryProgress", () => {
  it("shows a running pass with its count and an accessible progress bar", () => {
    const html = renderToString(
      <DeliveryProgress
        t={t}
        delivery={{ state: "running", total: 20_412, delivered: 600, failed: 0 }}
      />
    );
    expect(html).toContain("Updating the vault: 600 of 20412 files checked.");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="600"');
    expect(html).toContain('aria-valuemax="20412"');
    expect(html).toContain(`aria-label="${t("obsidianWiki.deliveryLabel")}"`);
    expect(html).toContain('aria-live="polite"');
  });

  it("reports a finished pass and the files that failed, without a bar", () => {
    const html = renderToString(
      <DeliveryProgress t={t} delivery={{ state: "done", total: 30, delivered: 30, failed: 2 }} />
    );
    expect(html).toContain("The last pass checked all 30 files.");
    expect(html).toContain("2 could not be written.");
    expect(html).not.toContain('role="progressbar"');
  });

  it("reports a stopped pass in every interface language", () => {
    for (const language of supportedLanguageCodes) {
      const translate = createTranslator(language, { missingKeyBehavior: "throw" });
      const html = renderToString(
        <DeliveryProgress
          t={translate}
          delivery={{ state: "stopped", total: 30, delivered: 12, failed: 0 }}
        />
      );
      expect(html).toContain("12");
      expect(html).toContain("30");
    }
  });
});
