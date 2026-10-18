import { describe, expect, it, vi } from "vitest";

// Sigma reads WebGL constants when it loads; this environment has no WebGL, only the constants.
vi.hoisted(() => {
  class Context {}
  Object.assign(Context, {
    BOOL: 35670,
    BYTE: 5120,
    UNSIGNED_BYTE: 5121,
    SHORT: 5122,
    UNSIGNED_SHORT: 5123,
    INT: 5124,
    UNSIGNED_INT: 5125,
    FLOAT: 5126,
    POINTS: 0,
    LINES: 1,
    TRIANGLES: 4
  });
  Object.assign(globalThis, {
    WebGLRenderingContext: Context,
    WebGL2RenderingContext: class extends Context {}
  });
});

import {
  GraphDashedEdgeProgram,
  GraphEdgeProgram,
  dashedShaderDefinition,
  graphArrowHead,
  graphArrowShaft,
  graphDashedArrowShaft
} from "./programs";
import { egoArrowOptions } from "./ego-graph-sigma";
import { graphDashPattern } from "./view-model";

// The pixels are checked in a real WebGL context by `npm run test:graph-webgl`; these tests pin
// the shader text a context compiles: what the dash adds, what it keeps and what it refuses.
const definitionOf = (Program: new (...args: never[]) => object) =>
  (
    Program.prototype as { getDefinition(): ReturnType<GraphEdgeProgram["getDefinition"]> }
  ).getDefinition.call(Object.create(Program.prototype));

describe("the dashed edge program", () => {
  const solid = definitionOf(GraphEdgeProgram);
  const dashed = definitionOf(GraphDashedEdgeProgram);

  it("cuts the line in the fragment shader and measures it in the vertex shader", () => {
    expect(solid.FRAGMENT_SHADER_SOURCE).not.toContain("discard");
    expect(dashed.FRAGMENT_SHADER_SOURCE).toContain(
      "if (mod(v_dashDistance, u_dashPattern.x + u_dashPattern.y) > u_dashPattern.x) discard;"
    );
    expect(dashed.VERTEX_SHADER_SOURCE).toContain("v_dashDistance = a_positionCoef * length(");
    for (const source of [dashed.VERTEX_SHADER_SOURCE, dashed.FRAGMENT_SHADER_SOURCE])
      expect(source).toContain("varying highp float v_dashDistance;");
    expect(dashed.UNIFORMS).toEqual([...solid.UNIFORMS, "u_dashViewport", "u_dashPattern"]);
  });

  it("keeps everything else of the stock program, premultiplied colour included", () => {
    expect(dashed.VERTEX_SHADER_SOURCE).toContain("v_color.rgb *= v_color.a;");
    expect(dashed.VERTEX_SHADER_SOURCE.split("v_color.a *= bias;")).toHaveLength(2);
    expect(dashed.ATTRIBUTES).toEqual(solid.ATTRIBUTES);
    expect(dashed.VERTICES).toBe(solid.VERTICES);
    expect(dashed.METHOD).toBe(solid.METHOD);
    // The solid program is untouched by the dashed one's edits.
    expect(solid.VERTEX_SHADER_SOURCE).not.toContain("u_dashViewport");
    expect(solid.UNIFORMS).not.toContain("u_dashPattern");
  });

  it("uses one dash pattern for the canvas and the legend", () => {
    expect(graphDashPattern.dash).toBeGreaterThan(graphDashPattern.gap);
    expect(graphDashPattern.gap).toBeGreaterThan(2);
  });

  it("refuses a shader it does not know how to cut, instead of half-patching it", () => {
    expect(() =>
      dashedShaderDefinition({
        VERTEX_SHADER_SOURCE: "void main() {}",
        FRAGMENT_SHADER_SOURCE: "void main(void) {}",
        UNIFORMS: []
      })
    ).toThrow("cannot cut it into dashes");
    expect(() =>
      dashedShaderDefinition({ ...dashed, FRAGMENT_SHADER_SOURCE: "precision mediump float;" })
    ).toThrow("cannot cut it into dashes");
  });
});

describe("the dashed arrow program", () => {
  // The shaft of a suggested, directed relation is Sigma's clamped line (it stops at the head) cut
  // into dashes; the head stays solid. The pixels are checked by `npm run test:graph-webgl`.
  const solidShaft = definitionOf(graphArrowShaft(egoArrowOptions));
  const dashedShaft = definitionOf(graphDashedArrowShaft(egoArrowOptions));
  const head = definitionOf(graphArrowHead(egoArrowOptions));

  it("cuts the clamped shaft into dashes, and only the shaft", () => {
    expect(solidShaft.FRAGMENT_SHADER_SOURCE).not.toContain("discard");
    expect(dashedShaft.FRAGMENT_SHADER_SOURCE).toContain(
      "if (mod(v_dashDistance, u_dashPattern.x + u_dashPattern.y) > u_dashPattern.x) discard;"
    );
    expect(dashedShaft.VERTEX_SHADER_SOURCE).toContain("v_dashDistance = a_positionCoef * length(");
    for (const source of [dashedShaft.VERTEX_SHADER_SOURCE, dashedShaft.FRAGMENT_SHADER_SOURCE])
      expect(source).toContain("varying highp float v_dashDistance;");
    expect(dashedShaft.UNIFORMS).toEqual([
      ...solidShaft.UNIFORMS,
      "u_dashViewport",
      "u_dashPattern"
    ]);
    // The head and the solid shaft know nothing of the dash.
    for (const solid of [head, solidShaft]) {
      expect(solid.VERTEX_SHADER_SOURCE).not.toContain("u_dashViewport");
      expect(solid.FRAGMENT_SHADER_SOURCE).not.toContain("u_dashPattern");
      expect(solid.UNIFORMS).not.toContain("u_dashPattern");
    }
  });

  it("keeps the stock clamped shaft and the premultiplied colour of every part", () => {
    for (const part of [solidShaft, dashedShaft, head]) {
      expect(part.VERTEX_SHADER_SOURCE).toContain("v_color.rgb *= v_color.a;");
      expect(part.VERTEX_SHADER_SOURCE.split("v_color.a *= bias;")).toHaveLength(2);
    }
    expect(dashedShaft.ATTRIBUTES).toEqual(solidShaft.ATTRIBUTES);
    expect(dashedShaft.VERTICES).toBe(solidShaft.VERTICES);
    expect(dashedShaft.METHOD).toBe(solidShaft.METHOD);
    // The clamped shaft is not the rectangle: it has its own attributes for the head's length.
    expect(solidShaft.VERTEX_SHADER_SOURCE).not.toBe(
      definitionOf(GraphEdgeProgram).VERTEX_SHADER_SOURCE
    );
  });
});
