// The contrast scan on a real page (F5 X12): `collectInPage` runs in Chromium over a fixture whose
// elements are the cases that put false findings in the journeys, and `evaluateSamples` judges what it
// reports. The colours are the dark theme's real tokens (tokens.css), so a case reads as the app does.
import { beforeAll, describe, expect, it } from "vitest";

import { call, electronBinary, runInPage } from "./contrast-page.js";
import {
  collectInPage,
  evaluateSamples,
  type ContrastResult,
  type ContrastSample
} from "./contrast.js";

const fixture = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #10151d; color: #e4eaf2; font: 14px sans-serif; }
  section { margin: 6px 12px; padding: 6px; background: #171e28; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border-width: 0; }
  .clip-rect { position: absolute; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  input { background: transparent; border: 1px solid #7a899f; font: inherit; color: #e4eaf2; }
  .dim-placeholder::placeholder { color: #3a4658; }
  .good-placeholder::placeholder { color: #9daabd; }
</style></head><body>
<section id="glyphs">
  <svg aria-label="Solid ok" viewBox="0 0 24 24" width="16" height="16" style="color:#5fd08f">
    <circle cx="12" cy="12" r="9.5" fill="currentColor"/>
    <path d="m7.8 12.4 2.8 2.8 5.6-5.8" fill="none" stroke="#171e28" stroke-width="2.2"/>
  </svg>
  <svg aria-label="Solid dim" viewBox="0 0 24 24" width="16" height="16" style="color:#283548">
    <circle cx="12" cy="12" r="9.5" fill="currentColor"/>
    <path d="m7.8 12.4 2.8 2.8 5.6-5.8" fill="none" stroke="#171e28" stroke-width="2.2"/>
  </svg>
  <span style="color:#b6c3d3"><svg aria-label="Line sample" width="32" height="10" viewBox="0 0 32 10">
    <line x1="1" y1="5" x2="31" y2="5" stroke="currentColor" stroke-width="2.2"/></svg></span>
  <svg aria-label="Outline icon" viewBox="0 0 16 16" width="16" height="16" fill="none"
    stroke="currentColor" style="color:#9daabd"><rect x="3" y="2.5" width="10" height="11"/></svg>
</section>
<section id="hidden">
  <span class="sr-only" style="color:#000">Atividade: live region text</span>
  <span class="clip-rect" style="color:#000">Clipped by the old rule</span>
  <span style="color:#2a3544">Visible dim text</span>
</section>
<section id="layers">
  <div style="background: rgba(245, 158, 11, 0.16)"><span style="color:#e8b05a">Warning on its tint</span></div>
  <div style="background: rgba(255, 255, 255, 0.9)"><span style="color:#e4eaf2">White over a light veil</span></div>
</section>
<section id="inactive">
  <button disabled style="color:#2a3544;background:#171e28;border:0">Disabled low</button>
  <button style="color:#2a3544;background:#171e28;border:0">Enabled low</button>
  <div aria-disabled="true"><span style="color:#2a3544">Inactive group</span></div>
  <div data-disabled=""><svg aria-label="Inactive icon" viewBox="0 0 16 16" width="16" height="16" fill="none"
    stroke="#2a3544"><rect x="3" y="2.5" width="10" height="11"/></svg></div>
  <label for="off" style="color:#2a3544">Label of a disabled field</label><input id="off" disabled style="width:40px">
  <fieldset disabled style="border:0;padding:0"><span style="color:#2a3544">In a disabled fieldset</span></fieldset>
</section>
<section id="fields">
  <input class="dim-placeholder" placeholder="Dim placeholder">
  <input class="good-placeholder" placeholder="Good placeholder">
  <input class="dim-placeholder" placeholder="Disabled placeholder" disabled>
  <input value="Dim value" style="color:#3a4658">
</section>
</body></html>`;

const electronAvailable = electronBinary() !== null;

describe.skipIf(!electronAvailable)("the contrast scan on a real page", () => {
  let samples: ContrastSample[];
  let scan: ContrastResult;
  const failed = (text: string) => scan.failures.find((finding) => finding.text === text);
  const seen = (text: string) => samples.some((entry) => entry.text === text);

  beforeAll(async () => {
    const [reported] = await runInPage(fixture, [call(collectInPage, 4000)]);
    samples = reported as ContrastSample[];
    scan = evaluateSamples(samples);
  }, 90_000);

  describe("icons", () => {
    it("reads a solid glyph, not the black fill of its svg root", () => {
      expect(seen("Solid ok")).toBe(true);
      expect(failed("Solid ok")).toBeUndefined();
      const reported = samples.find((entry) => entry.text === "Solid ok");
      // The root's own paint is the default black: the page reports it, the shapes carry the paint.
      expect(reported?.color).toBe("rgb(0, 0, 0)");
      expect(reported?.shapes?.some((shape) => shape.fill === "rgb(95, 208, 143)")).toBe(true);
    });

    it("still fails a solid glyph whose real colour is too dim", () => {
      expect(failed("Solid dim")).toMatchObject({ kind: "glyph", foreground: "rgb(40, 53, 72)" });
    });

    it("reads a line sample and an outline icon by their stroke", () => {
      expect(seen("Line sample")).toBe(true);
      expect(failed("Line sample")).toBeUndefined();
      expect(seen("Outline icon")).toBe(true);
      expect(failed("Outline icon")).toBeUndefined();
    });
  });

  describe("text a person cannot see", () => {
    it("leaves a screen-reader-only text out, however it hides", () => {
      // The page reports them; the verdict leaves them out and counts them as hidden.
      expect(scan.failures.map((finding) => finding.text)).not.toContain(
        "Atividade: live region text"
      );
      expect(scan.failures.map((finding) => finding.text)).not.toContain("Clipped by the old rule");
      expect(scan.hidden).toBeGreaterThanOrEqual(2);
    });

    it("still fails text that is visible and too dim", () => {
      expect(failed("Visible dim text")).toMatchObject({ kind: "text", required: 4.5 });
    });
  });

  describe("translucent and tinted ancestors", () => {
    it("composes the tint over the surface before judging the text on it", () => {
      expect(seen("Warning on its tint")).toBe(true);
      expect(failed("Warning on its tint")).toBeUndefined();
    });

    it("fails light text over a nearly opaque light veil, as the person sees it", () => {
      expect(failed("White over a light veil")).toMatchObject({ background: "rgb(232, 233, 234)" });
    });
  });

  describe("inactive controls", () => {
    it("exempts a disabled control, an inactive group and the label of a disabled field", () => {
      for (const text of [
        "Disabled low",
        "Inactive group",
        "Inactive icon",
        "Label of a disabled field",
        "In a disabled fieldset"
      ])
        expect(seen(text), text).toBe(false);
    });

    it("still judges the same colour on an enabled control", () => {
      expect(failed("Enabled low")).toBeDefined();
    });
  });

  describe("placeholders", () => {
    it("judges a placeholder: WCAG 1.4.3 does not exempt it", () => {
      expect(failed("Dim placeholder")).toMatchObject({ kind: "text", required: 4.5 });
      expect(seen("Good placeholder")).toBe(true);
      expect(failed("Good placeholder")).toBeUndefined();
    });

    it("exempts the placeholder of a disabled field and judges an entered value", () => {
      expect(seen("Disabled placeholder")).toBe(false);
      expect(failed("Dim value")).toBeDefined();
    });
  });
});
