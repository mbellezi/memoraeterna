import { graphLayoutCommandSchema, graphLayoutEventSchema, type GraphForceSettings, type GraphLayoutCommand, type GraphLayoutEdge, type GraphLayoutNode } from "./knowledge-graph-layout-contract";

/** Accepts ongoing network motion while protecting the pointer-controlled node from stale snapshots. */
export class KnowledgeGraphLayout {
  private readonly worker: Worker;
  private sequence = 0;
  private disposed = false;
  private pointer: { index: number; x: number; y: number; released: boolean } | null = null;
  private readonly indices: Map<string, number>;

  constructor(
    nodes: GraphLayoutNode[],
    edges: GraphLayoutEdge[],
    settings: GraphForceSettings,
    restored: boolean,
    onPositions: (positions: Float32Array, running: boolean) => void,
    onError: () => void
  ) {
    this.indices = new Map(nodes.map((node, index) => [node.id, index]));
    this.worker = new Worker(new URL("./knowledge-graph-layout.worker.ts", import.meta.url), { type: "module" });
    const fail = () => { if (!this.disposed) { this.kill(); onError(); } };
    this.worker.onerror = fail;
    this.worker.onmessageerror = fail;
    this.worker.onmessage = (event: MessageEvent<unknown>) => {
      if (this.disposed) return;
      const parsed = graphLayoutEventSchema.safeParse(event.data);
      if (!parsed.success || parsed.data.type === "error") { fail(); return; }
      const update = parsed.data;
      if (update.positions.length !== nodes.length * 2) { fail(); return; }
      if (this.pointer) {
        if (!this.pointer.released || update.sequence < this.sequence) {
          update.positions[this.pointer.index * 2] = this.pointer.x;
          update.positions[this.pointer.index * 2 + 1] = this.pointer.y;
        } else this.pointer = null;
      }
      onPositions(update.positions, update.running || this.pointer !== null);
    };
    this.send({ type: "init", nodes, edges, settings, restored });
  }

  private send(message: GraphLayoutCommand) {
    if (!this.disposed) this.worker.postMessage(graphLayoutCommandSchema.parse(message));
  }

  configure(settings: GraphForceSettings) { this.send({ type: "configure", settings }); }
  reheat() { this.send({ type: "reheat" }); }
  drag(id: string, x: number, y: number, release: boolean) {
    const index = this.indices.get(id);
    if (index === undefined) return;
    this.pointer = { index, x, y, released: release };
    this.sequence += 1;
    this.send({ type: "drag", id, x, y, release, sequence: this.sequence });
  }
  kill() {
    this.disposed = true;
    this.worker.terminate();
  }
}
