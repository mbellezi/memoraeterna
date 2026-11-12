import { describe, expect, it } from "vitest";

import { fallbackGraphPalette } from "./graph-tokens";
import { drawHaloLabel, graphLabelLayout, wrapLabel, type LabelContext } from "./labels";

/** Every character is 6 px wide, so widths are easy to reason about. */
const measure = (value: string) => value.length * 6;

describe("graph labels", () => {
  it("break at spaces into at most two lines and never cut a word on the first", () => {
    expect(wrapLabel("O ácido lático inibe patógenos", 90, measure)).toEqual([
      "O ácido lático",
      "inibe patógenos"
    ]);
    expect(wrapLabel("  Kefir  ", 90, measure)).toEqual(["Kefir"]);
    expect(wrapLabel("", 90, measure)).toEqual([]);
    // A long title ends in an ellipsis on the second line, at a space when one is near.
    const lines = wrapLabel(
      "Bactérias láticas toleram meio ácido durante semanas inteiras",
      108,
      measure
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Bactérias láticas");
    expect(lines[1]!.endsWith("…")).toBe(true);
    expect(measure(lines[1]!)).toBeLessThanOrEqual(108);
    // A word longer than a line stays whole on a line that has more after it.
    expect(wrapLabel("Supercalifragilístico curto", 60, measure)[0]).toBe("Supercalifragilístico");
  });

  it("draw each line twice, first as a halo of the canvas colour and then in the label colour", () => {
    const calls: string[] = [];
    const context: LabelContext = {
      font: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "miter",
      textAlign: "left",
      textBaseline: "alphabetic",
      measureText: (text) => ({ width: measure(text) }),
      strokeText(text, _x, y) {
        calls.push(`stroke ${String(this.strokeStyle)} ${this.lineWidth} ${y} ${text}`);
      },
      fillText(text, _x, y) {
        calls.push(`fill ${String(this.fillStyle)} ${y} ${text}`);
      }
    };
    const lines = drawHaloLabel(
      context,
      { x: 10, y: 20, size: 5, label: "Temperatura controla a acidez" },
      fallbackGraphPalette
    );
    expect(lines.length).toBeGreaterThan(0);
    const top = 20 + 5 + graphLabelLayout.gap;
    expect(calls[0]).toBe(
      `stroke ${fallbackGraphPalette.canvas} ${graphLabelLayout.halo * 2} ${top} ${lines[0]}`
    );
    expect(calls.at(-1)).toContain(`fill ${fallbackGraphPalette.label}`);
    expect(context.textAlign).toBe("center");
    // No label, nothing drawn.
    expect(
      drawHaloLabel(context, { x: 0, y: 0, size: 1, label: null }, fallbackGraphPalette)
    ).toEqual([]);
  });
});
