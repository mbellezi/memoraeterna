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

  it("draw a plate of the canvas colour behind each line, then each line as a halo and in the label colour", () => {
    const calls: string[] = [];
    const context: LabelContext = {
      font: "",
      globalAlpha: 1,
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
      },
      beginPath() {
        calls.push("path");
      },
      roundRect(x, y, width, height) {
        calls.push(`plate ${x} ${y} ${width} ${height}`);
      },
      fill() {
        calls.push(`plate fill ${String(this.fillStyle)} ${this.globalAlpha}`);
      }
    };
    const lines = drawHaloLabel(
      context,
      { x: 10, y: 20, size: 5, label: "Temperatura controla a acidez" },
      fallbackGraphPalette
    );
    expect(lines).toHaveLength(2);
    const top = 20 + 5 + graphLabelLayout.gap;
    const { halo, lineHeight, plateOpacity } = graphLabelLayout;
    // One path holds a plate per line: the line's width plus the halo on each side, a line high
    // plus a pixel above and below, filled once in the canvas colour at the plate's opacity.
    const plate = (index: number) => {
      const width = measure(lines[index]!) + halo * 2;
      return `plate ${10 - width / 2} ${top + index * lineHeight - 1} ${width} ${lineHeight + 2}`;
    };
    expect(calls.slice(0, 4)).toEqual([
      "path",
      plate(0),
      plate(1),
      `plate fill ${fallbackGraphPalette.canvas} ${plateOpacity}`
    ]);
    expect(context.globalAlpha).toBe(1);
    expect(calls[4]).toBe(`stroke ${fallbackGraphPalette.canvas} ${halo * 2} ${top} ${lines[0]}`);
    expect(calls.at(-1)).toContain(`fill ${fallbackGraphPalette.label}`);
    expect(context.textAlign).toBe("center");
    // No label, nothing drawn.
    expect(
      drawHaloLabel(context, { x: 0, y: 0, size: 1, label: null }, fallbackGraphPalette)
    ).toEqual([]);
  });
});
