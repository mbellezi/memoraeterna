import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { RelationsLens } from "./RelationsLens";

const t = createTranslator("en");
const noop = () => undefined;

/** The lens before its first answer, as the server renders it (no effect runs). */
function loadingLens(): string {
  return renderToStaticMarkup(
    <RelationsLens
      t={t}
      active={false}
      scope={{ kind: "topic", id: "00000000-0000-4000-8000-000000000001" }}
      onOpenNote={noop}
      onShowTree={noop}
    />
  );
}

/** The opening tag of the first element carrying `marker`, and what follows it up to `end`. */
function slice(html: string, marker: string, end: string): string {
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<", at);
  return html.slice(start, html.indexOf(end, at) + end.length);
}

describe("the Grafo lens header", () => {
  it("never asks to choose a branch it cannot open: before the first answer the chip holds a bar", () => {
    const html = loadingLens();
    expect(html).toContain('data-state="loading"');
    const menu = t("mapRelations.scope.menu");
    const chip = slice(html, `aria-label="${menu}"`, "</button>");
    expect(chip).toContain("disabled");
    // The instruction stays the chip's name; its face shows no words until the branch is known.
    expect(chip.replace(/<[^>]*>/gu, "")).toBe("");
    expect(chip).toMatch(/aria-hidden="true" class="[^"]*w-28/u);
  });

  it("names the colour depth in words and gives its help to the keyboard, not to a hover alone", () => {
    const html = loadingLens();
    const group = slice(html, 'role="group"', ">");
    expect(group).toContain(`aria-label="${t("mapRelations.depth.label")}"`);
    const describedBy = /aria-describedby="([^"]+)"/u.exec(group)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}" class="sr-only">${t("mapRelations.depth.help")}<`);
  });
});
