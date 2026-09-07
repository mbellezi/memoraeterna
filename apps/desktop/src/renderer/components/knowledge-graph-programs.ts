import { EdgeRectangleProgram, NodeCircleProgram } from "sigma/rendering";
import type { Attributes } from "graphology-types";

/** Sigma 3 uses ONE / ONE_MINUS_SRC_ALPHA blending, but its stock programs emit straight RGB. */
function premultipliedVertexShader(source: string): string {
  const alphaCorrection = "v_color.a *= bias;";
  if (source.split(alphaCorrection).length !== 2) {
    throw new Error("Unsupported Sigma color shader: expected one alpha correction");
  }
  return source.replace(alphaCorrection, `${alphaCorrection}
  #ifndef PICKING_MODE
  v_color.rgb *= v_color.a;
  #endif`);
}

export class GraphNodeProgram<N extends Attributes = Attributes, E extends Attributes = Attributes, G extends Attributes = Attributes> extends NodeCircleProgram<N, E, G> {
  override getDefinition() {
    const definition = super.getDefinition();
    return { ...definition, VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE) };
  }
}

export class GraphEdgeProgram<N extends Attributes = Attributes, E extends Attributes = Attributes, G extends Attributes = Attributes> extends EdgeRectangleProgram<N, E, G> {
  override getDefinition() {
    const definition = super.getDefinition();
    return { ...definition, VERTEX_SHADER_SOURCE: premultipliedVertexShader(definition.VERTEX_SHADER_SOURCE) };
  }
}
