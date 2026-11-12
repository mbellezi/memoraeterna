import { app, BrowserWindow } from "electron";
import { build } from "vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Isolated, hidden renderer: no application UI, preload, database or user profile is loaded.
app.setPath("userData", mkdtempSync(join(tmpdir(), "memora-graph-webgl-")));
const programs = fileURLToPath(
  new URL("../apps/desktop/src/renderer/components/graph/programs.ts", import.meta.url)
);
const relations = (file) =>
  fileURLToPath(
    new URL(
      `../apps/desktop/src/renderer/workspace/destinations/map/relations/${file}`,
      import.meta.url
    )
  );
const graphModule = (file) =>
  fileURLToPath(new URL(`../apps/desktop/src/renderer/components/graph/${file}`, import.meta.url));
const fixture = `
import Sigma from "sigma";
import { buildBranchSigmaGraph, branchEdgeDisplay, branchNodeDisplay, drawMidpointGlyph } from ${JSON.stringify(relations("branch-sigma.ts"))};
import { fallbackGraphPalette } from ${JSON.stringify(graphModule("graph-tokens.ts"))};
import { drawHaloLabel } from ${JSON.stringify(graphModule("labels.ts"))};
import { GraphNodeProgram, GraphEdgeProgram, GraphDashedEdgeProgram, createGraphArrowProgram, createGraphDashedArrowProgram } from ${JSON.stringify(programs)};
import { NodeCircleProgram, EdgeRectangleProgram } from "sigma/rendering";

/**
 * The Map › Grafo frame time (F5 T151, spec 3.9): a branch of 400 notes in 12 topic groups and
 * 2,000 relations, drawn as the canvas draws it (topic dots, stance lines with a dashed share,
 * halo labels and midpoint glyphs), at 1200 x 800. Each of 120 frames moves the camera and
 * re-runs the reducers (an emphasis changes), the heaviest redraw a pointer causes.
 */
export function branchFrames() {
  const stances = ["supports", "contradicts", "extends", "depends_on", "example_of", "related"];
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const groups = Array.from({ length: 12 }, (_, index) => ({
    id: "group-" + index, title: "Topic " + index, legendLabel: "Topic " + index, colourIndex: index, notes: 0
  }));
  const nodes = Array.from({ length: 400 }, (_, index) => {
    const group = groups[index % 12];
    group.notes += 1;
    return { id: "note-" + index, title: "A note about subject " + index + " and its evidence",
      topicId: group.id, groupId: group.id, colourIndex: group.colourIndex, degree: 10, size: 6 };
  });
  const edges = [];
  const seen = new Set();
  while (edges.length < 2000) {
    const a = Math.floor(random() * 400);
    const near = (a + 1 + Math.floor(random() * (random() < 0.7 ? 24 : 399))) % 400;
    const key = Math.min(a, near) + ":" + Math.max(a, near);
    if (a === near || seen.has(key)) continue;
    seen.add(key);
    edges.push({ id: "edge-" + edges.length, a: "note-" + a, b: "note-" + near, type: stances[edges.length % 6],
      stance: stances[edges.length % 6], suggested: edges.length % 5 === 0 });
  }
  const superEdges = [];
  for (let i = 0; i < 12; i += 1)
    for (let j = i + 1; j < 12; j += 1) superEdges.push({ a: groups[i].id, b: groups[j].id, weight: 1 + ((i * j) % 17) });
  const model = { scope: { kind: "topic", id: "scope" }, scopeTitle: "Scope", children: [], parentId: null,
    groups, nodes, edges, superEdges, unplaced: 0, stances, stanceTypes: {}, hasSuggestions: true, truncated: false };
  const palette = fallbackGraphPalette;
  const graph = buildBranchSigmaGraph(model, palette);
  graph.forEachNode((key, attributes) => {
    if (attributes.kind !== "note") return;
    graph.mergeNodeAttributes(key, { x: (random() - 0.5) * 900, y: (random() - 0.5) * 600 });
  });
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;left:0;top:0;width:1200px;height:800px";
  document.body.appendChild(container);
  let target = null;
  const renderer = new Sigma(graph, container, {
    nodeProgramClasses: { circle: GraphNodeProgram },
    nodeHoverProgramClasses: { circle: GraphNodeProgram },
    edgeProgramClasses: { line: GraphEdgeProgram, dashed: GraphDashedEdgeProgram },
    renderEdgeLabels: true,
    zIndex: true,
    labelDensity: 0.7,
    labelGridCellSize: 150,
    labelRenderedSizeThreshold: 3,
    itemSizesReference: "screen",
    defaultDrawNodeLabel: (context, data) => { drawHaloLabel(context, data, palette); },
    defaultDrawEdgeLabel: (context, edge, source, targetData) => {
      if (!graph.hasEdge(edge.key)) return;
      const attributes = graph.getEdgeAttributes(edge.key);
      if (attributes.interactionTarget !== null || attributes.kind !== "note") return;
      drawMidpointGlyph(context, source, targetData, attributes.stance, edge.glyphColor || palette.stance.related, palette);
    },
    nodeReducer: (node, attributes) => ({ ...attributes, ...branchNodeDisplay(graph, node, target, false, palette) }),
    edgeReducer: (edge, attributes) => ({ ...attributes, ...branchEdgeDisplay(graph, edge, target, false, palette) })
  });
  const camera = renderer.getCamera();
  const times = [];
  for (let frame = 0; frame < 120; frame += 1) {
    target = frame % 3 === 0 ? null : { type: "node", key: "note-" + ((frame * 37) % 400) };
    camera.setState({ x: 0.5 + 0.05 * Math.sin(frame / 9), y: 0.5, ratio: 0.8 + 0.3 * Math.cos(frame / 13), angle: 0 });
    const start = performance.now();
    renderer.refresh();
    times.push(performance.now() - start);
  }
  renderer.kill();
  container.remove();
  const sorted = [...times].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const mean = times.reduce((sum, value) => sum + value, 0) / times.length;
  return { scene: "branch", nodes: 400, relations: 2000, frames: times.length,
    p95Ms: Math.round(p95 * 10) / 10, meanMs: Math.round(mean * 10) / 10, expectedP95Ms: 33 };
}

export function verify() {
  const results = [];
  for (const contextType of ["webgl2", "webgl"]) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const gl = canvas.getContext(contextType, { antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error(contextType + " is unavailable");
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const picking = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, picking);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const params = {
      width: 64, height: 64, pixelRatio: 1, downSizingRatio: 1,
      zoomRatio: 1, sizeRatio: 1, correctionRatio: 1 / 64,
      minEdgeThickness: 1.8, antiAliasingFeather: 1,
      matrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
    };
    function draw(Program, kind, color, pick = false) {
      for (const framebuffer of [null, picking]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const program = new Program(gl, picking, null);
      program.reallocate(1);
      const node = { x: 0, y: 0, size: 16, color, hidden: false };
      if (kind === "node") program.process(12, 0, node);
      else program.process(12, 0, { ...node, x: -0.8 }, { ...node, x: 0.8 }, { size: 8, color, hidden: false });
      program.render(params);
      const pixels = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, pick ? picking : null);
      gl.readPixels(32, 32, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL draw failed");
      program.kill();
      return Array.from(pixels);
    }
    // A suggested relation is a dashed line (decision 29): the alpha along a horizontal edge shows
    // the dashes and the gaps the shader cuts, with the solid program as the reference.
    function alphaRow(Program) {
      for (const framebuffer of [null, picking]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      const program = new Program(gl, picking, null);
      program.reallocate(1);
      const node = { x: 0, y: 0, size: 3, color: "rgba(255, 255, 255, 1)", hidden: false };
      program.process(12, 0, { ...node, x: -0.8 }, { ...node, x: 0.8 }, { size: 4, color: "rgba(255, 255, 255, 1)", hidden: false });
      program.render(params);
      const pixels = new Uint8Array(64 * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 32, 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      if (gl.getError() !== gl.NO_ERROR) throw new Error("WebGL draw failed");
      program.kill();
      return Array.from({ length: 64 }, (_, x) => pixels[x * 4 + 3]);
    }
    const solidRow = alphaRow(GraphEdgeProgram);
    const dashedRow = alphaRow(GraphDashedEdgeProgram);
    // The edge runs from x = 6.4 to 57.6 pixels: 7 px of line, 5 px of gap, and again.
    for (const x of [8, 10, 21, 22, 33, 45]) {
      if (solidRow[x] < 200 || dashedRow[x] < 200) throw new Error("dash missing at " + x + ": " + dashedRow[x]);
    }
    for (const x of [15, 16, 27, 28, 39, 51]) {
      if (solidRow[x] < 200 || dashedRow[x] > 0) throw new Error("gap filled at " + x + ": " + dashedRow[x]);
    }
    const arrowOptions = { lengthToThicknessRatio: 4, widenessToThicknessRatio: 3 };
    const arrowRow = alphaRow(createGraphArrowProgram(arrowOptions));
    const dashedArrowRow = alphaRow(createGraphDashedArrowProgram(arrowOptions));
    const opaque = (row) => row.filter((value) => value > 200).length;
    // The pieces of line along the row: one for a solid line, several for a dashed one.
    const pieces = (row) => row.filter((value, x) => value > 0 && (x === 0 || row[x - 1] === 0)).length;
    if (opaque(arrowRow) < 40 || pieces(arrowRow) !== 1) throw new Error("solid arrow row changed: " + arrowRow.join());
    if (pieces(dashedArrowRow) < 3 || opaque(dashedArrowRow) >= opaque(arrowRow) || opaque(dashedArrowRow) < 10) {
      throw new Error("dashed arrow has no dashes: " + dashedArrowRow.join());
    }
    results.push({ contextType, kind: "dashed", dashedRow, dashedArrowRow });
    for (const [kind, Original, Corrected] of [["node", NodeCircleProgram, GraphNodeProgram], ["edge", EdgeRectangleProgram, GraphEdgeProgram]]) {
      const before = draw(Original, kind, "rgba(148, 148, 148, 0.1)");
      const after = draw(Corrected, kind, "rgba(148, 148, 148, 0.1)");
      if (before[0] < 140 || after[0] > 17 || after[0] < 12 || after[3] < 23 || after[3] > 27) {
        throw new Error(kind + " alpha mismatch: " + JSON.stringify({ before, after }));
      }
      for (const alpha of [0, 0.25, 0.5, 1]) {
        const pixel = draw(Corrected, kind, "rgba(148, 148, 148, " + alpha + ")");
        if (Math.abs(pixel[0] - 148 * alpha) > 2 || Math.abs(pixel[3] - 255 * alpha) > 3) {
          throw new Error(kind + " fade mismatch at " + alpha + ": " + pixel);
        }
      }
      const highlighted = draw(Corrected, kind, "rgba(252, 165, 165, 1)");
      if (highlighted.join() !== "252,165,165,255") throw new Error("Opaque highlight changed");
      const picked = draw(Corrected, kind, "rgba(0, 0, 0, 0)", true);
      if (picked.join() !== "0,0,12,255") throw new Error("Picking ID changed: " + picked);
      results.push({ contextType, kind, before, after, picked });
    }
    gl.deleteFramebuffer(picking);
    gl.deleteTexture(texture);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return results;
}
`;

async function verify() {
  let window;
  const deadline = setTimeout(() => {
    console.error("WebGL verification timed out");
    app.exit(1);
  }, 60_000);
  try {
    console.log("Building isolated WebGL fixture...");
    const bundle = await build({
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        lib: { entry: "graph-alpha-check", name: "GraphAlphaCheck", formats: ["iife"] }
      },
      plugins: [
        {
          name: "graph-alpha-fixture",
          resolveId(id) {
            if (id === "graph-alpha-check" || id.endsWith("/graph-alpha-check"))
              return "\0graph-alpha-check";
          },
          load(id) {
            if (id === "\0graph-alpha-check") return fixture;
          }
        }
      ]
    });
    const output = (Array.isArray(bundle) ? bundle[0] : bundle).output.find(
      (item) => item.type === "chunk"
    );
    if (!output) throw new Error("Missing test bundle");
    console.log("Waiting for Electron...");
    await app.whenReady();
    app.dock?.hide();
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 860,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true }
    });
    console.log("Loading isolated renderer...");
    await window.loadURL("data:text/html,<html><body></body></html>");
    console.log("Checking rendered pixels...");
    // A failure inside the renderer reaches here as its own message, not as Electron's generic one.
    const outcome = await window.webContents.executeJavaScript(
      output.code +
        "\n(() => { try { return { results: GraphAlphaCheck.verify(), branch: GraphAlphaCheck.branchFrames() }; } catch (error) { return { failure: String((error && error.stack) || error) }; } })();"
    );
    if (outcome.failure) throw new Error(outcome.failure);
    const { results, branch } = outcome;
    console.log(JSON.stringify({ passed: true, results }, null, 2));
    // Reported, not a gate (spec 5.5): the Map › Grafo branch scene's frame time.
    console.log(
      `Map › Grafo branch frame time: p95 ${branch.p95Ms} ms, mean ${branch.meanMs} ms over ${branch.frames} frames (${branch.nodes} notes, ${branch.relations} relations; about ${branch.expectedP95Ms} ms or less expected)`
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    window?.destroy();
    app.exit(process.exitCode ?? 0);
  }
}

// Let Electron finish evaluating its main module before waiting for app readiness.
void verify();
