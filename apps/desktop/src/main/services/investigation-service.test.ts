import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WikiPageContentSchema, type AutomaticMaintenanceRun } from "@app/domain";
import type { PgPool } from "@app/db";

import { ActiveDeadline } from "./ai-execution-queue.js";
import type { ConsultationService } from "./consultation-service.js";
import { InvestigationService, investigationTimeoutMs } from "./investigation-service.js";

const mocks = vi.hoisted(() => ({
  investigations: {
    recover: vi.fn(),
    candidates: vi.fn(),
    get: vi.fn(),
    assertScope: vi.fn(),
    highWater: vi.fn(),
    noEvidence: vi.fn(),
    inspectionFailed: vi.fn(),
    begin: vi.fn(),
    failed: vi.fn(),
    acknowledge: vi.fn()
  },
  curator: { policy: vi.fn() },
  wiki: { get: vi.fn() },
  maintenance: { heartbeat: vi.fn(), capacity: vi.fn(), reserve: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createInvestigationRepository: () => mocks.investigations,
  createWikiCuratorRepository: () => mocks.curator,
  createWikiRepository: () => mocks.wiki,
  createAutomaticMaintenanceRepository: () => mocks.maintenance
}));

const occurrence = {
  id: "occurrence",
  snapshot: {
    policy: { policyId: "policy" },
    profile: { provider: "test", modelId: "model" },
    promptPin: null,
    contentLanguage: "en"
  }
} as unknown as AutomaticMaintenanceRun;
const snapshot = () => ({
  baseContent: { title: "What does spacing do?" },
  evidence: [],
  contexts: [],
  relations: [],
  contentLanguage: "en",
  profile: { parameters: {}, identityHash: "profile-hash", provider: "test" },
  promptPin: null
});

/** What the service hands to the consultation: the signal of each call. */
function consultation() {
  const seen: { prepare?: AbortSignal; generate?: AbortSignal } = {};
  const calls = {
    prepare: vi.fn(async (_input: unknown, signal: AbortSignal) => {
      seen.prepare = signal;
      return { snapshot: snapshot(), metadata: {} };
    }),
    generate: vi.fn(
      async (_snapshot: unknown, _question: string, _previous: unknown, signal: AbortSignal) => {
        seen.generate = signal;
        throw new Error("organization.errors.failed");
      }
    )
  };
  return { seen, calls, service: calls as unknown as ConsultationService };
}

function investigation(c: ReturnType<typeof consultation>) {
  return new InvestigationService({
    getPool: () => ({}) as PgPool,
    consultation: c.service,
    wake: vi.fn()
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.investigations.candidates.mockResolvedValue(["investigation"]);
  mocks.investigations.get.mockResolvedValue({
    id: "investigation",
    attention: null,
    policyId: "policy",
    policyRevisionId: "policy-revision",
    revision: 3,
    question: "What does spacing do?",
    input: {
      requestId: "00000000-0000-4000-8000-000000000001",
      question: "What does spacing do?",
      mode: "text",
      sourceIds: []
    },
    lastInputFingerprint: "an earlier fingerprint",
    answerPageId: "page",
    current: { answer: "An earlier answer." }
  });
  mocks.curator.policy.mockResolvedValue({
    state: "enabled",
    revisionId: "policy-revision",
    operations: ["refresh_investigation"]
  });
  mocks.investigations.assertScope.mockResolvedValue([]);
  mocks.investigations.highWater.mockResolvedValue(0);
  mocks.investigations.begin.mockResolvedValue({
    existing: false,
    id: "evaluation",
    run_id: "run"
  });
  mocks.wiki.get.mockResolvedValue({
    ...WikiPageContentSchema.parse({ title: "What does spacing do?", kind: "synthesis" }),
    revisionId: "page-revision"
  });
  mocks.maintenance.heartbeat.mockResolvedValue(Number.MAX_SAFE_INTEGER);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a followed question's time limit", () => {
  it("counts the time it works, not the time it waits behind other AI work", async () => {
    const c = consultation();
    // The evaluation waits in the AI queue for longer than the limit before each call runs.
    const waitInQueue = async (signal: AbortSignal) => {
      const deadline = ActiveDeadline.of(signal);
      expect(deadline, "the signal belongs to an active deadline").toBeDefined();
      deadline!.pause();
      await vi.advanceTimersByTimeAsync(investigationTimeoutMs * 3);
      expect(signal.aborted).toBe(false);
      deadline!.resume();
    };
    c.calls.prepare.mockImplementation(async (_input, signal) => {
      c.seen.prepare = signal;
      await waitInQueue(signal);
      return { snapshot: snapshot(), metadata: {} };
    });
    c.calls.generate.mockImplementation(async (_snapshot, _question, _previous, signal) => {
      c.seen.generate = signal;
      await waitInQueue(signal);
      throw new Error("organization.errors.failed");
    });

    await investigation(c).tick(occurrence);

    expect(c.calls.generate).toHaveBeenCalledOnce();
    // The queue wait ended the evaluation neither in the preparation nor in the answer.
    expect(mocks.investigations.failed).toHaveBeenCalledWith(
      "evaluation",
      "run",
      "organization.errors.failed",
      false
    );
    expect(mocks.investigations.inspectionFailed).not.toHaveBeenCalled();
  });

  it("is one limit for preparing and answering, found from both signals", async () => {
    const c = consultation();
    await investigation(c).tick(occurrence);
    const prepared = ActiveDeadline.of(c.seen.prepare);
    expect(prepared).toBeDefined();
    // The answer's signal also ends with the maintenance clock, yet keeps the same deadline.
    expect(c.seen.generate).not.toBe(c.seen.prepare);
    expect(ActiveDeadline.of(c.seen.generate)).toBe(prepared);
  });

  it("ends the evaluation once the active time of the limit is used up", async () => {
    const c = consultation();
    c.calls.prepare.mockImplementation(async (_input, signal) => {
      c.seen.prepare = signal;
      await vi.advanceTimersByTimeAsync(investigationTimeoutMs - 1);
      expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject({ name: "TimeoutError" });
      throw signal.reason;
    });

    await investigation(c).tick(occurrence);

    expect(c.calls.generate).not.toHaveBeenCalled();
    expect(mocks.investigations.inspectionFailed).toHaveBeenCalledOnce();
  });

  it("follows the cancellation of the service and leaves no timer behind", async () => {
    const c = consultation();
    const service = investigation(c);
    c.calls.prepare.mockImplementation(async (_input, signal) => {
      c.seen.prepare = signal;
      service.shutdown();
      expect(signal.aborted).toBe(true);
      throw signal.reason;
    });

    await service.tick(occurrence);

    expect(c.calls.generate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    // The same holds when the evaluation ends normally.
    const finished = consultation();
    await investigation(finished).tick(occurrence);
    expect(vi.getTimerCount()).toBe(0);
  });
});
