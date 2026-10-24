import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the harness's two layers around a real Codex call tell each other (F4 T89). The token cap
 * wraps the adapter (one admission per call) and the fault injector wraps its `fetch` (one exchange
 * per request); the call's async context carries the facts between them, so the cap settles a call
 * with what really reached the provider: an attempt the injector answered itself forwarded nothing
 * and cost no token, however the adapter then failed, while every request the provider accepted may
 * have been billed, even when the attempt then failed (a stall) and a retry answered the call.
 */

export interface SoakCallContext {
  /** Requests the call sent to the provider (the fetch layer counts the ones it forwarded). */
  forwardedRequests: number;
  /** Forwarded requests the provider refused with an HTTP error: they bill no token. */
  refusedRequests: number;
  /** Requests the fetch layer answered itself or failed, which never reached the provider. */
  injectedRequests: number;
  /**
   * Called by the fetch layer before it forwards a request; throws to keep it from the provider
   * (the cap admits every request after the call's first by reservation).
   */
  beforeForward?: () => void;
}

const storage = new AsyncLocalStorage<SoakCallContext>();

/** Runs `work` with a fresh call context and returns it with the work's outcome. */
export async function withSoakCallContext<T>(
  work: () => Promise<T>,
  hooks: Pick<SoakCallContext, "beforeForward"> = {}
): Promise<{ context: SoakCallContext; outcome: { value: T } | { error: unknown } }> {
  const context: SoakCallContext = {
    forwardedRequests: 0,
    refusedRequests: 0,
    injectedRequests: 0,
    ...hooks
  };
  try {
    return { context, outcome: { value: await storage.run(context, work) } };
  } catch (error) {
    return { context, outcome: { error } };
  }
}

/** The context of the call the current exchange belongs to; undefined outside a metered call. */
export function currentSoakCallContext(): SoakCallContext | undefined {
  return storage.getStore();
}

/** Forwarded requests the provider did not refuse: each may have been billed. */
export function billableRequests(context: SoakCallContext): number {
  return Math.max(0, context.forwardedRequests - context.refusedRequests);
}
