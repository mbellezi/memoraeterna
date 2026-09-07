import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeGraphLayout } from "./knowledge-graph-layout";
import { defaultGraphForceSettings } from "./knowledge-graph-layout-contract";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent<unknown>); }
}

describe("graph worker lifecycle", () => {
  beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal("Worker", FakeWorker); });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps network updates flowing during continuous drag while preserving the latest pointer position", () => {
    const update = vi.fn();
    const error = vi.fn();
    const layout = new KnowledgeGraphLayout([{ id: "a", x: 5, y: 6 }, { id: "b", x: 10, y: 10 }], [], defaultGraphForceSettings, true, update, error);
    const worker = FakeWorker.instances[0]!;
    expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: "init", restored: true });
    layout.drag("a", 80, 90, false);
    layout.drag("a", 100, 120, true);
    worker.emit({ type: "positions", positions: new Float32Array([80, 90, 15, 20]), running: true, sequence: 1 });
    expect(Array.from(update.mock.calls[0]![0])).toEqual([100, 120, 15, 20]);
    worker.emit({ type: "positions", positions: new Float32Array([99, 119, 16, 21]), running: false, sequence: 2 });
    expect(Array.from(update.mock.calls[1]![0])).toEqual([99, 119, 16, 21]);
    for (let i = 3; i < 30; i += 1) {
      layout.drag("a", i, i, false);
      worker.emit({ type: "positions", positions: new Float32Array([i - 1, i - 1, i * 2, i * 3]), running: true, sequence: i - 1 });
      expect(Array.from(update.mock.lastCall![0])).toEqual([i, i, i * 2, i * 3]);
    }
    expect(error).not.toHaveBeenCalled();
    layout.kill();
    const callCount = update.mock.calls.length;
    worker.emit({ type: "positions", positions: new Float32Array([0, 0, 0, 0]), running: true, sequence: 30 });
    expect(update).toHaveBeenCalledTimes(callCount);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([new Float32Array([1]), new Float32Array([Infinity, 0])])("stops on malformed worker positions", (positions) => {
    const error = vi.fn();
    const update = vi.fn();
    new KnowledgeGraphLayout([{ id: "a", x: 0, y: 0 }], [], defaultGraphForceSettings, false, update, error);
    const worker = FakeWorker.instances[0]!;
    worker.emit({ type: "positions", positions, running: true, sequence: 0 });
    expect(error).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });
});
