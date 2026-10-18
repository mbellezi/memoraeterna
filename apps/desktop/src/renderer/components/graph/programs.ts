import {
  EdgeRectangleProgram,
  NodeCircleProgram,
  createEdgeArrowHeadProgram,
  createEdgeClampedProgram,
  createEdgeCompoundProgram
} from "sigma/rendering";
import type { Attributes } from "graphology-types";

import { graphDashPattern } from "./view-model";

/** Sigma 3 uses ONE / ONE_MINUS_SRC_ALPHA blending, but its stock programs emit straight RGB. */
function premultipliedVertexShader(source: string): string {
  const alphaCorrection = "v_color.a *= bias;";
  if (source.split(alphaCorrection).length !== 2) {
    throw new Error("Unsupported Sigma color shader: expected one alpha correction");
  }
  return source.replace(
    alphaCorrection,
    `${alphaCorrection}
  #ifndef PICKING_MODE
  v_color.rgb *= v_color.a;
  #endif`
  );
}

export class GraphNodeProgram<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes
> extends NodeCircleProgram<N, E, G> {
  override getDefinition() {
    const definition = super.getDefinition();
    return {
      ...definition,
      VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE)
    };
  }
}

export class GraphEdgeProgram<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes
> extends EdgeRectangleProgram<N, E, G> {
  override getDefinition() {
    const definition = super.getDefinition();
    return {
      ...definition,
      VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE)
    };
  }
}

export function createGraphArrowProgram(options: {
  lengthToThicknessRatio: number;
  widenessToThicknessRatio: number;
}): ReturnType<typeof createEdgeCompoundProgram> {
  // Sigma's factory type erases the concrete EdgeProgram methods.
  const Shaft = createEdgeClampedProgram(options) as typeof EdgeRectangleProgram;
  const Head = createEdgeArrowHeadProgram(options) as typeof EdgeRectangleProgram;
  return createEdgeCompoundProgram([
    class extends Shaft {
      override getDefinition() {
        const definition = super.getDefinition();
        return {
          ...definition,
          VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE)
        };
      }
    },
    class extends Head {
      override getDefinition() {
        const definition = super.getDefinition();
        return {
          ...definition,
          VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE)
        };
      }
    }
  ]);
}

/** The uniforms the dash needs, besides the ones of the program it extends. */
const dashUniforms = ["u_dashViewport", "u_dashPattern"] as const;

interface ShaderDefinition {
  VERTEX_SHADER_SOURCE: string;
  FRAGMENT_SHADER_SOURCE: string;
  UNIFORMS: ReadonlyArray<string>;
}

/**
 * Cuts a line into dashes: the vertex shader measures how far along the line each vertex is, in
 * screen pixels (the line's length times the 0..1 position along the quad), and the fragment shader
 * drops the pixels of the gaps. Sigma's edge shaders (rectangle and clamped) share the varyings this
 * relies on; a shader that does not is refused, never half-patched.
 */
export function dashedShaderDefinition<D extends ShaderDefinition>(definition: D): D {
  const vertex = definition.VERTEX_SHADER_SOURCE;
  const fragment = definition.FRAGMENT_SHADER_SOURCE;
  const normal = "v_normal = unitNormal;";
  const varying = "varying float v_feather;";
  const entry = "void main(void) {";
  const expected =
    vertex.split(normal).length === 2 &&
    vertex.split(varying).length === 2 &&
    vertex.includes("a_positionCoef") &&
    vertex.includes("a_positionStart") &&
    vertex.includes("a_positionEnd") &&
    vertex.includes("u_matrix") &&
    fragment.split(varying).length === 2 &&
    fragment.split(entry).length === 2;
  if (!expected) throw new Error("Unsupported Sigma edge shader: cannot cut it into dashes");
  return {
    ...definition,
    VERTEX_SHADER_SOURCE: vertex
      .replace(
        varying,
        `${varying}
varying highp float v_dashDistance;
uniform vec2 u_dashViewport;`
      )
      .replace(
        normal,
        `${normal}

  // Distance along the line in screen pixels: clip space spans half the viewport each way.
  vec2 dashFrom = (u_matrix * vec3(a_positionStart, 1)).xy * 0.5 * u_dashViewport;
  vec2 dashTo = (u_matrix * vec3(a_positionEnd, 1)).xy * 0.5 * u_dashViewport;
  v_dashDistance = a_positionCoef * length(dashTo - dashFrom);`
      ),
    FRAGMENT_SHADER_SOURCE: fragment
      .replace(
        varying,
        `${varying}
varying highp float v_dashDistance;
uniform vec2 u_dashPattern;`
      )
      .replace(
        entry,
        `${entry}
  if (mod(v_dashDistance, u_dashPattern.x + u_dashPattern.y) > u_dashPattern.x) discard;
`
      ),
    UNIFORMS: [...definition.UNIFORMS, ...dashUniforms]
  };
}

type Uniforms = EdgeRectangleProgram["setUniforms"];

/** Sets the dash uniforms of a program built with `dashedShaderDefinition`. */
function setDashUniforms(...[params, { gl, uniformLocations }]: Parameters<Uniforms>): void {
  gl.uniform2f(uniformLocations.u_dashViewport!, params.width, params.height);
  gl.uniform2f(uniformLocations.u_dashPattern!, graphDashPattern.dash, graphDashPattern.gap);
}

/** A straight line cut into dashes: a suggested relation without a direction. */
export class GraphDashedEdgeProgram<
  N extends Attributes = Attributes,
  E extends Attributes = Attributes,
  G extends Attributes = Attributes
> extends GraphEdgeProgram<N, E, G> {
  override getDefinition() {
    return dashedShaderDefinition(super.getDefinition());
  }

  override setUniforms(...args: Parameters<Uniforms>): void {
    super.setUniforms(...args);
    setDashUniforms(...args);
  }
}

/** A dashed shaft with the solid arrow head: a suggested relation that reads in one direction. */
export function createGraphDashedArrowProgram(options: {
  lengthToThicknessRatio: number;
  widenessToThicknessRatio: number;
}): ReturnType<typeof createEdgeCompoundProgram> {
  const Shaft = createEdgeClampedProgram(options) as typeof EdgeRectangleProgram;
  const Head = createEdgeArrowHeadProgram(options) as typeof EdgeRectangleProgram;
  return createEdgeCompoundProgram([
    class extends Shaft {
      override getDefinition() {
        const definition = super.getDefinition();
        return dashedShaderDefinition({
          ...definition,
          VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE)
        });
      }

      override setUniforms(...args: Parameters<Uniforms>): void {
        super.setUniforms(...args);
        setDashUniforms(...args);
      }
    },
    class extends Head {
      override getDefinition() {
        const definition = super.getDefinition();
        return {
          ...definition,
          VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE)
        };
      }
    }
  ]);
}
