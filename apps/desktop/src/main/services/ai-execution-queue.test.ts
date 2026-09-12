import { describe, expect, it, vi } from "vitest";
import { AiExecutionQueue } from "./ai-execution-queue.js";
import { AiService } from "./ai-service.js";

describe("AI execution queue", () => {
  it("runs requests in FIFO order with only one active execution", async () => {
    const queue = new AiExecutionQueue();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const order: number[] = [];
    let active = 0, maximum = 0;
    const results = [1,2,3].map((id) => queue.run(async () => {
      order.push(id); active++; maximum = Math.max(maximum,active);
      if (id === 1) { started.resolve(); await gate.promise; }
      active--; return id;
    }));
    await started.promise;
    expect(order).toEqual([1]);
    gate.resolve();
    expect(await Promise.all(results)).toEqual([1,2,3]);
    expect(order).toEqual([1,2,3]);
    expect(maximum).toBe(1);
  });

  it("cancels waiting work promptly without invoking it or releasing the active slot", async () => {
    const queue = new AiExecutionQueue();
    const gate = Promise.withResolvers<void>();
    const first = queue.run(() => gate.promise);
    const controller = new AbortController();
    const canceled = vi.fn(async () => 2), next = vi.fn(async () => 3);
    const second = queue.run(canceled,controller.signal);
    const rejected = expect(second).rejects.toThrow("cancel waiting");
    const third = queue.run(next);
    controller.abort(new Error("cancel waiting"));
    await rejected;
    expect(canceled).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    gate.resolve();
    await first; expect(await third).toBe(3);
    expect(canceled).not.toHaveBeenCalled();
  });

  it("waits for active cancellation to settle before starting another call", async () => {
    const queue = new AiExecutionQueue();
    const controller = new AbortController();
    const started = Promise.withResolvers<void>(), stopped = Promise.withResolvers<void>();
    const first = queue.run(async () => { started.resolve(); await stopped.promise; controller.signal.throwIfAborted(); },controller.signal);
    const rejected = expect(first).rejects.toThrow("cancel active");
    await started.promise;
    const next = vi.fn(async () => 2), second = queue.run(next);
    controller.abort(new Error("cancel active"));
    await Promise.resolve(); expect(next).not.toHaveBeenCalled();
    stopped.resolve(); await rejected; expect(await second).toBe(2);
  });

  it("continues after synchronous failures and rejects already canceled requests", async () => {
    const queue = new AiExecutionQueue();
    const first = queue.run(() => { throw new Error("failed"); });
    const second = queue.run(async () => 2);
    await expect(first).rejects.toThrow("failed"); expect(await second).toBe(2);
    const execute = vi.fn(async () => 3);
    await expect(queue.run(execute,AbortSignal.abort(new Error("already canceled")))).rejects.toThrow("already canceled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("shares one queue between service instances, routed tasks and local-model tests", async () => {
    const makeService = () => new AiService({userDataPath:"/tmp/ai-queue-test",workspaceRoot:"/tmp",resourcesPath:"/tmp",isPackaged:false,getPool:() => null});
    const firstService = makeService(), secondService = makeService();
    type Executors = {preparePromptAdmission:()=>Promise<any>;executeDefaultTask: (task: string) => Promise<null>; executeLocalModelTest: () => Promise<string>};
    const first = firstService as unknown as Executors, second = secondService as unknown as Executors;
    vi.spyOn(first,"preparePromptAdmission").mockResolvedValue({selection:{},compositions:[],input:"one"});
    vi.spyOn(second,"preparePromptAdmission").mockResolvedValue({selection:{},compositions:[],input:"next"});
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    const order: string[] = [];
    vi.spyOn(first,"executeDefaultTask").mockImplementation(async (task) => {order.push(task);started.resolve();await gate.promise;return null;});
    vi.spyOn(second,"executeDefaultTask").mockImplementation(async (task) => {order.push(task);return null;});
    vi.spyOn(second,"executeLocalModelTest").mockImplementation(async () => {order.push("local-test");return "OK";});
    const calls = [firstService.runDefaultTask("summarization","one"),secondService.runDefaultTask("reranking","two"),
      secondService.testLocalModel("local"),secondService.runDefaultTask("embedding","three")];
    await started.promise; expect(order).toEqual(["summarization"]);
    gate.resolve(); await Promise.all(calls);
    expect(order).toEqual(["summarization","reranking","local-test","embedding"]);
  });
});
