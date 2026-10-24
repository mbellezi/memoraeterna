import {
  AiProviderError,
  type AiModelAdapter,
  type AiTaskRequest,
  type AiTaskResult
} from "@app/ai";
import { describe, expect, it } from "vitest";

import { currentSoakCallContext } from "./soak-call-context.js";
import { MemoryEventSink } from "./soak-records.js";
import {
  HarnessCapRefusal,
  HarnessTokenCap,
  composeAdapterDecorators,
  estimateCallTokens,
  harnessCapMarker,
  tokensOfFailure,
  tokensOfResult
} from "./soak-token-cap.js";

const request = (text = "x".repeat(300), maxTokens = 900): AiTaskRequest => ({
  taskType: "structured-output",
  input: text,
  requiredCapabilities: [],
  parameters: { maxTokens },
  metadata: {}
});
// 300 bytes of input as a JSON string is 302 bytes: 101 tokens at three bytes each, plus 900.
const estimate = estimateCallTokens(request());

const result = (inputTokens?: number, outputTokens?: number): AiTaskResult => ({
  taskType: "structured-output",
  output: "ok",
  providerId: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  durationMs: 5,
  ...(inputTokens === undefined ? {} : { inputTokens }),
  ...(outputTokens === undefined ? {} : { outputTokens })
});

function newCap(capTokens: number) {
  const sink = new MemoryEventSink();
  const exhausted: unknown[] = [];
  const cap = new HarnessTokenCap({
    capTokens,
    sink,
    now: () => Date.parse("2026-10-28T00:00:00Z"),
    onExhausted: (snapshot) => exhausted.push(snapshot)
  });
  return { cap, sink, exhausted };
}

/** A Codex adapter whose calls the test finishes by hand, so calls are in flight together. */
function manualAdapter(overrides: { providerId?: string; modelId?: string } = {}) {
  const pending: Array<{
    resolve: (value: AiTaskResult) => void;
    reject: (error: unknown) => void;
    context: ReturnType<typeof currentSoakCallContext>;
  }> = [];
  const adapter: AiModelAdapter = {
    describe: () => ({
      providerId: overrides.providerId ?? "openai-codex",
      modelId: overrides.modelId ?? "gpt-test",
      runtime: "remote",
      capabilities: ["structured-output"],
      parameterCapabilities: {},
      limits: {},
      requirements: {}
    }),
    canHandle: () => true,
    run: () =>
      new Promise<AiTaskResult>((resolve, reject) => {
        pending.push({ resolve, reject, context: currentSoakCallContext() });
      })
  };
  return { adapter, pending };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the harness token cap", () => {
  it("estimates a call from its input bytes and its output ceiling", () => {
    expect(estimate).toBe(101 + 900);
    expect(estimateCallTokens({ ...request(), parameters: {} })).toBe(101 + 8_192);
  });

  it("admits a call only while spent, reserved and its own estimate fit the cap", () => {
    const { cap } = newCap(100);
    const a = cap.reserve(40);
    const b = cap.reserve(40);
    // Two in flight: the third would pass the cap even if both end at zero tokens.
    expect(() => cap.reserve(40)).toThrow(HarnessCapRefusal);
    cap.settle(a, 30);
    expect(cap.snapshot()).toMatchObject({ spentTokens: 30, reservedTokens: 40, calls: 1 });
    expect(() => cap.reserve(40)).toThrow(/would pass the harness token cap/u);
    cap.settle(b, 45);
    const d = cap.reserve(25);
    cap.settle(d, 25);
    expect(cap.snapshot()).toMatchObject({
      spentTokens: 100,
      reservedTokens: 0,
      largestCallTokens: 45,
      refusals: 2
    });
  });

  it("holds two calls in flight at the Codex lane's concurrency and refuses the third by reservation", async () => {
    const { cap } = newCap(2_500);
    const { adapter, pending } = manualAdapter();
    const wrapped = cap.adapterDecorator(adapter);
    const first = wrapped.run(request());
    const second = wrapped.run(request());
    await tick();
    expect(pending).toHaveLength(2);
    expect(cap.snapshot().reservedTokens).toBe(2 * estimate);
    // 2 x 1,001 reserved leaves 498 of 2,500: a third call of 1,001 is refused before it starts.
    await expect(wrapped.run(request())).rejects.toBeInstanceOf(HarnessCapRefusal);
    expect(pending).toHaveLength(2);
    pending[0]!.resolve(result(150, 90));
    pending[1]!.resolve(result(150, 90));
    await Promise.all([first, second]);
    expect(cap.snapshot()).toMatchObject({ spentTokens: 480, reservedTokens: 0, calls: 2 });
    // The two settled for less than they reserved, so a third call fits now.
    const third = wrapped.run(request());
    await tick();
    pending[2]!.resolve(result(150, 90));
    await third;
    expect(cap.snapshot().spentTokens).toBe(720);
  });

  it("never passes the cap by more than one call once it is lowered to spent plus 1.5 calls (E4 a)", async () => {
    const { cap } = newCap(1_000_000);
    const { adapter, pending } = manualAdapter();
    const wrapped = cap.adapterDecorator(adapter);
    // Calibration: four calls, each really using as many tokens as it estimated.
    for (let index = 0; index < 4; index += 1) {
      const call = wrapped.run(request());
      await tick();
      pending[index]!.resolve(result(101, 900));
      await call;
    }
    const spentBefore = cap.snapshot().spentTokens;
    const lowered = cap.lowerToSpentPlus(1.5);
    expect(lowered).toBe(spentBefore + Math.round(1.5 * estimate));
    // Two calls arrive together: one fits (1,001 of 1,502), the other would pass the cap.
    const a = wrapped.run(request());
    const b = wrapped.run(request());
    const ended: string[] = [];
    a.then(
      () => ended.push("a ok"),
      () => ended.push("a refused")
    );
    b.then(
      () => ended.push("b ok"),
      () => ended.push("b refused")
    );
    await tick();
    expect(ended).toEqual(["b refused"]);
    expect(pending).toHaveLength(5);
    pending[4]!.resolve(result(101, 900));
    await a;
    const after = cap.snapshot();
    expect(after.spentTokens - lowered).toBeLessThanOrEqual(after.largestCallTokens);
    expect(after.spentTokens).toBeLessThanOrEqual(lowered + after.largestCallTokens);
    // Ending the window restores the frozen cap; the lowered one is never raised by lowerTo.
    expect(cap.lowerTo(lowered + 1_000_000)).toBe(false);
    cap.restore();
    expect(cap.snapshot().capTokens).toBe(1_000_000);
  });

  it("ends the remote leg only when a call is refused at the hard cap, not at a lowered one", () => {
    const { cap, exhausted, sink } = newCap(100);
    cap.lowerTo(50);
    expect(() => cap.reserve(60)).toThrow(HarnessCapRefusal);
    expect(exhausted).toHaveLength(0);
    cap.restore();
    expect(() => cap.reserve(150)).toThrow(HarnessCapRefusal);
    expect(exhausted).toHaveLength(1);
    expect(() => cap.reserve(150)).toThrow(HarnessCapRefusal);
    expect(exhausted).toHaveLength(1);
    expect(
      sink.events
        .filter((event) => event.type === "cap")
        .map((event) => event.type === "cap" && event.action)
    ).toEqual(["set", "lower", "refused", "set", "refused", "exhausted", "refused"]);
  });

  it("tags the refusal so the report sets it aside, and makes it permanent", () => {
    const { cap } = newCap(10);
    try {
      cap.reserve(11);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain(harnessCapMarker);
      expect((error as AiProviderError).transient).toBe(false);
    }
  });
});

describe("what a call settles with", () => {
  const reservation = { id: 1, estimateTokens: 1_000 };
  const forwarded = { forwardedRequests: 1, injectedRequests: 0 };
  const injectedOnly = { forwardedRequests: 0, injectedRequests: 3 };

  it("uses the provider's count, a failed attempt's usage included", () => {
    expect(tokensOfResult(result(120, 30), forwarded, reservation)).toBe(150);
    expect(tokensOfResult(result(undefined, 30), forwarded, reservation)).toBe(30);
    expect(
      tokensOfResult({ ...result(), tokenUsage: { totalTokens: 77 } }, forwarded, reservation)
    ).toBe(77);
  });

  it("keeps the estimate as spend when the provider reported nothing for a call it received", () => {
    expect(tokensOfResult(result(), forwarded, reservation)).toBe(1_000);
    expect(tokensOfResult(result(), injectedOnly, reservation)).toBe(0);
  });

  it("charges a failed call nothing when no attempt reached the provider", () => {
    const timeout = new AiProviderError("first byte", { kind: "timeout", transient: true });
    expect(tokensOfFailure(timeout, injectedOnly, reservation)).toBe(0);
  });

  it("charges the estimate for a stall or a broken stream after the request went out, nothing for an HTTP error", () => {
    const stall = new AiProviderError("stalled", { kind: "stalled", transient: true });
    const http = new AiProviderError("429", { kind: "http", transient: true, status: 429 });
    const network = new AiProviderError("refused", { kind: "network", transient: true });
    expect(tokensOfFailure(stall, forwarded, reservation)).toBe(1_000);
    expect(tokensOfFailure(new SyntaxError("bad sse"), forwarded, reservation)).toBe(1_000);
    expect(tokensOfFailure(http, forwarded, reservation)).toBe(0);
    expect(tokensOfFailure(network, forwarded, reservation)).toBe(0);
  });

  it("settles through the decorator with what the fetch layer told the call's context", async () => {
    const { cap } = newCap(100_000);
    const { adapter, pending } = manualAdapter();
    const wrapped = cap.adapterDecorator(adapter);
    const call = wrapped.run(request());
    await tick();
    // The fetch layer answered every attempt itself: nothing was forwarded.
    pending[0]!.context!.injectedRequests += 1;
    pending[0]!.reject(
      new AiProviderError("injected 503", { kind: "http", transient: false, status: 503 })
    );
    await expect(call).rejects.toThrow("injected 503");
    expect(cap.snapshot()).toMatchObject({ spentTokens: 0, reservedTokens: 0, calls: 1 });
    const stalled = wrapped.run(request());
    await tick();
    pending[1]!.context!.forwardedRequests += 1;
    pending[1]!.reject(new AiProviderError("stalled", { kind: "stalled", transient: true }));
    await expect(stalled).rejects.toThrow("stalled");
    expect(cap.snapshot().spentTokens).toBe(estimate);
  });
});

describe("the composed decorator", () => {
  it("lets only the real Codex writer through the cap, and the others through untouched", () => {
    const { cap } = newCap(1_000);
    const decorator = composeAdapterDecorators(cap.adapterDecorator);
    const real = manualAdapter().adapter;
    const fake = manualAdapter({ modelId: "dev-fake-explain-1" }).adapter;
    const other = manualAdapter({ providerId: "openai-compatible" }).adapter;
    expect(decorator(real)).not.toBe(real);
    expect(decorator(fake)).toBe(fake);
    expect(decorator(other)).toBe(other);
  });

  it("runs every decorator in order, skipping the absent ones", () => {
    const seen: string[] = [];
    const named = (name: string) => (adapter: AiModelAdapter) => {
      seen.push(name);
      return adapter;
    };
    const adapter = manualAdapter().adapter;
    composeAdapterDecorators(named("gguf"), null, named("cap"), undefined)(adapter);
    expect(seen).toEqual(["gguf", "cap"]);
  });
});
