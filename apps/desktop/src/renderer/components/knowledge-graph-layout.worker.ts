import { graphLayoutCommandSchema, type GraphLayoutEvent } from "./knowledge-graph-layout-contract";
import { createGraphPhysics } from "./knowledge-graph-physics";

let physics: ReturnType<typeof createGraphPhysics> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let sequence = 0;
let startedAt = 0;
let dragging = false;

function emit(event: GraphLayoutEvent) {
  if (event.type === "positions") self.postMessage(event, { transfer: [event.positions.buffer] });
  else self.postMessage(event);
}

function step() {
  timer = null;
  if (!physics) return;
  try {
    const tickStartedAt = performance.now();
    const settled = physics.tick();
    const running = dragging || (!settled && performance.now() - startedAt < 15_000);
    emit({ type: "positions", positions: physics.positions(), running, sequence });
    if (running) timer = setTimeout(step, Math.max(0, 16 - (performance.now() - tickStartedAt)));
  } catch {
    emit({ type: "error" });
  }
}

function wake() {
  startedAt = performance.now();
  if (timer === null) timer = setTimeout(step, 0);
}

self.onmessage = (event: MessageEvent<unknown>) => {
  try {
    const message = graphLayoutCommandSchema.parse(event.data);
    switch (message.type) {
      case "init":
        if (timer !== null) clearTimeout(timer);
        timer = null;
        physics = createGraphPhysics(message.nodes, message.edges, message.settings, message.restored);
        if (!message.restored) wake();
        break;
      case "configure":
        physics?.configure(message.settings);
        physics?.reheat();
        wake();
        break;
      case "reheat":
        physics?.reheat();
        wake();
        break;
      case "drag": {
        const beginningDrag = !dragging && !message.release;
        sequence = message.sequence;
        dragging = !message.release;
        physics?.drag(message.id, message.x, message.y, message.release);
        if (beginningDrag) {
          if (timer !== null) clearTimeout(timer);
          timer = null;
          startedAt = performance.now();
          step();
        } else wake();
        break;
      }
    }
  } catch {
    emit({ type: "error" });
  }
};
