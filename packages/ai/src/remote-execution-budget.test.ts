import { describe, expect, it, vi } from "vitest";

import { AiProviderError } from "./provider-error.js";
import {
  attemptAdmissionOf,
  bindAttemptAdmission,
  failedAttemptObserverOf,
  remoteCallReport,
  resolveAiRuntimeConfig,
  runRemoteCall,
  type FailedRemoteAttempt
} from "./remote-execution.js";

/**
 * The attempt admission of the remote retry loop (F4 D14, T76): the RemoteBudget reserves every
 * attempt before it is sent, the first included, and a refusal ends the call without a retry.
 */
const config = resolveAiRuntimeConfig({ retry: { baseDelayMs: 1, maxDelayMs: 1 } });
const context = { config, random: () => 0 };
const busy = () => new AiProviderError("busy", { kind: "http", transient: true, status: 503 });

class Refused extends Error {}

describe("the attempt admission of a remote call", () => {
  it("is asked before every attempt, the first included, with its number", async () => {
    const asked: number[] = [];
    let sent = 0;
    const value = await runRemoteCall(
      context,
      {
        streaming: false,
        taskType: "summarization",
        beforeAttempt: (attempt) => {
          asked.push(attempt);
        }
      },
      async () => {
        sent += 1;
        if (sent < 3) throw busy();
        return "ok";
      }
    );
    expect(value).toBe("ok");
    expect(asked).toEqual([1, 2, 3]);
  });

  it("ends a retried call at a refused attempt: nothing more is sent and it is not counted", async () => {
    const attempt = vi.fn(async () => {
      throw busy();
    });
    const refusal = new Refused("cap");
    const failure = await runRemoteCall(
      context,
      {
        streaming: false,
        taskType: "summarization",
        beforeAttempt: (number) => {
          if (number === 2) throw refusal;
        }
      },
      attempt
    ).catch((error: unknown) => error);
    expect(failure).toBe(refusal);
    expect(attempt).toHaveBeenCalledTimes(1);
    // One attempt was sent and billed; the refused one never started.
    expect(remoteCallReport(failure)?.attempts).toBe(1);
  });

  it("refuses the first attempt before anything is sent", async () => {
    const attempt = vi.fn(async () => "never");
    const refusal = new Refused("cap");
    const failure = await runRemoteCall(
      context,
      {
        streaming: false,
        taskType: "summarization",
        beforeAttempt: () => Promise.reject(refusal)
      },
      attempt
    ).catch((error: unknown) => error);
    expect(failure).toBe(refusal);
    expect(attempt).not.toHaveBeenCalled();
    expect(remoteCallReport(failure)?.attempts).toBe(0);
  });

  it("reads the admission bound to the caller's signal; an explicit one wins", async () => {
    const signal = new AbortController().signal;
    const bound: number[] = [];
    bindAttemptAdmission(signal, (attempt) => {
      bound.push(attempt);
    });
    expect(attemptAdmissionOf(signal)).toBeDefined();
    expect(attemptAdmissionOf(new AbortController().signal)).toBeUndefined();
    expect(attemptAdmissionOf(undefined)).toBeUndefined();
    await runRemoteCall(context, { streaming: false, signal }, async () => "ok");
    expect(bound).toEqual([1]);
    const explicit: number[] = [];
    await runRemoteCall(
      context,
      {
        streaming: false,
        signal,
        beforeAttempt: (attempt) => {
          explicit.push(attempt);
        }
      },
      async () => "ok"
    );
    expect(explicit).toEqual([1]);
    expect(bound).toEqual([1]);
  });

  it("tells which failed attempts the provider accepted without reporting their usage", async () => {
    const failed: FailedRemoteAttempt[] = [];
    const respond = (status: number) =>
      (async () => new Response("{}", { status })) as typeof fetch;
    let number = 0;
    const value = await runRemoteCall(
      {
        config: resolveAiRuntimeConfig({
          retry: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 4 }
        }),
        random: () => 0
      },
      {
        streaming: false,
        taskType: "summarization",
        beforeAttempt: () => undefined,
        afterFailedAttempt: (attempt) => failed.push(attempt)
      },
      async (call) => {
        number += 1;
        if (number === 1) {
          // An error status: the provider answered and did not accept the request.
          await call.fetch(respond(503), "https://api.example.test/v1", {});
          throw busy();
        }
        if (number === 2) {
          // Accepted, then lost before its usage (a stall after deltas): it may have been billed.
          await call.fetch(respond(200), "https://api.example.test/v1", {});
          throw new AiProviderError("stalled", { kind: "stalled", transient: true });
        }
        if (number === 3) {
          // Accepted and reported both counts before it failed.
          await call.fetch(respond(200), "https://api.example.test/v1", {});
          call.reportUsage({ inputTokens: 10, outputTokens: 2 });
          throw new AiProviderError("stalled", { kind: "stalled", transient: true });
        }
        return "ok";
      }
    );
    expect(value).toBe("ok");
    expect(failed).toEqual([
      { attempt: 1, usage: {}, unreported: false, unsent: false },
      { attempt: 2, usage: {}, unreported: true, unsent: false },
      { attempt: 3, usage: { inputTokens: 10, outputTokens: 2 }, unreported: false, unsent: false }
    ]);
  });

  it("tells which failed attempts never reached the provider: their connection failed (F4 D7)", async () => {
    const failed: FailedRemoteAttempt[] = [];
    const transport = (code: string) =>
      (async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
      }) as typeof fetch;
    const respond = (status: number) =>
      (async () => new Response("{}", { status })) as typeof fetch;
    let number = 0;
    const value = await runRemoteCall(
      {
        config: resolveAiRuntimeConfig({
          retry: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 5 }
        }),
        random: () => 0
      },
      {
        streaming: false,
        taskType: "summarization",
        beforeAttempt: () => undefined,
        afterFailedAttempt: (attempt) => failed.push(attempt)
      },
      async (call) => {
        number += 1;
        // DNS, then a refused connection: nothing was sent.
        if (number === 1) return call.fetch(transport("ENOTFOUND"), "https://api.example.test", {});
        if (number === 2)
          return call.fetch(transport("ECONNREFUSED"), "https://api.example.test", {});
        // A reset may come after the request was sent.
        if (number === 3)
          return call.fetch(transport("ECONNRESET"), "https://api.example.test", {});
        if (number === 4) {
          // Answered with an error status, then a fallback request that could not connect: the
          // provider saw the first one.
          await call.fetch(respond(503), "https://api.example.test", {});
          return call.fetch(transport("ECONNREFUSED"), "https://api.example.test", {});
        }
        return "ok";
      }
    );
    expect(value).toBe("ok");
    expect(failed.map((attempt) => [attempt.attempt, attempt.unsent])).toEqual([
      [1, true],
      [2, true],
      [3, false],
      [4, false]
    ]);
  });

  it("binds the observer of failed attempts with the admission to the caller's signal", async () => {
    const signal = new AbortController().signal;
    const failed: number[] = [];
    bindAttemptAdmission(
      signal,
      () => undefined,
      (attempt) => failed.push(attempt.attempt)
    );
    expect(failedAttemptObserverOf(signal)).toBeDefined();
    let number = 0;
    await runRemoteCall(context, { streaming: false, signal }, async () => {
      number += 1;
      if (number === 1) throw busy();
      return "ok";
    });
    expect(failed).toEqual([1]);
  });

  it("does not send an attempt once the caller canceled during its admission", async () => {
    const controller = new AbortController();
    const attempt = vi.fn(async () => "never");
    const failure = await runRemoteCall(
      context,
      {
        streaming: false,
        signal: controller.signal,
        beforeAttempt: () => {
          controller.abort(new Error("canceled"));
        }
      },
      attempt
    ).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("canceled");
    expect(attempt).not.toHaveBeenCalled();
  });
});
