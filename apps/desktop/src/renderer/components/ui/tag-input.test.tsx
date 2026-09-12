import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { normalizeTags, TagBadges, TagInput } from "./tag-input";

describe("content tags", () => {
  it("normalizes existing and pasted tags without duplicates or empty badges", () => {
    expect(normalizeTags([" Ciência ", "CIÊNCIA", "", "React, Typescript\nreact", "duas palavras", "cafe\u0301", "café"])).toEqual(["ciência", "react", "typescript", "duas palavras", "café"]);
  });

  it("renders normalized badges with accessible removal and stable colors", () => {
    const t = createTranslator("pt-BR");
    const html = renderToStaticMarkup(<TagBadges tags={[" React ", "REACT"]} t={t} onRemove={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Remover tag react"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain("REACT");
    const single = renderToStaticMarkup(<TagBadges tags={["react"]} t={t} />);
    const multiple = renderToStaticMarkup(<TagBadges tags={["other", "react"]} t={t} />);
    expect(multiple).toContain(single);
    expect(single).not.toContain("<button");
  });

  it("provides localized instructions below the empty field in every locale", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      const html = renderToStaticMarkup(<TagInput id="tags" value={[]} onChange={() => {}} t={t} />);
      expect(html).toContain('aria-describedby="tags-hint"');
      expect(html).toContain(t("tagInput.hint"));
      expect(html.indexOf('id="tags-hint"')).toBeGreaterThan(html.indexOf("<input"));
      expect(html).toContain("text-xs text-slate-500");
      expect(html).not.toContain("missing:");
    }
  });

  it("disables input and removal while unavailable", () => {
    const html = renderToStaticMarkup(<TagInput id="tags" value={["tag"]} onChange={() => {}} t={createTranslator("en")} disabled />);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
