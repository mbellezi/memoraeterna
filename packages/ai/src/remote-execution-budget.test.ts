import { describe, expect, it, vi } from "vitest";

import { AiProviderError } from "./provider-error.js";
import {
  attemptAdmissionOf,
  bindAttemptAdmission,
  remoteCallReport,
  resolveAiRuntimeConfig,
  runRemoteCall
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
