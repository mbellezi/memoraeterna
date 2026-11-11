import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnswerStreamReader } from "@app/domain";

import { AppEventBus } from "../app-events.js";
import { consultationEvidence, consultationSnapshot } from "../consultation-fixture.js";
import { consultationPrompt, parseConsultationAnswer } from "../consultation-service.js";
import type { AppEvent } from "../../../shared/app-events.js";
import { fixedLatency, plannedMs, type FakeHttpRequest } from "./fake-remote-core.js";
import {
  askAnswer,
  askAnswerPieces,
  defaultAskStreamPlan,
  evidenceHandles,
  malformedAskAnswer,
  openAiCompatibleKind
} from "./fake-remote-provider.js";

/**
 * The fake remote's Ask answer (F5 D14, J6): three paragraphs with citations, streamed over at
 * least 600 ms in at least 6 pieces, so the paragraph completions arrive well apart and past the
 * 50 ms window of `consultation.delta`.
 */

const snapshotOf = (count: number) =>
  consultationSnapshot({
    evidence: Array.from({ length: count }, (_unused, index) => consultationEvidence(index + 1))
  });
const promptOf = (count: number) => consultationPrompt(snapshotOf(count), "What improves recall?");

const kind = (latencyMs = 60) =>
  openAiCompatibleKind({ seed: 1, latency: fixedLatency(latencyMs) });
const streamRequest = (prompt: string, stream = true): FakeHttpRequest => ({
  method: "POST",
  path: "/v1/chat/completions",
  headers: {},
  body: JSON.stringify({ stream, messages: [{ role: "user", content: prompt }] })
});

/** The answer text each piece of a streamed reply carries, with the time it arrives. */
function timedText(script: ReturnType<ReturnType<typeof kind>["reply"]>) {
  let at = 0;
  const pieces: Array<{ at: number; text: string }> = [];
  for (const part of script.parts) {
    at += part.delayMs;
    if (!part.text) continue;
    const payload = JSON.parse(part.data.replace(/^data: /u, "")) as {
      choices: Array<{ delta: { content?: string } }>;
    };
    pieces.push({ at, text: payload.choices[0]!.delta.content ?? "" });
  }
  return pieces;
}

describe("the fake Ask answer", () => {
  it("has three paragraphs that cite the prompt's passages in order and pass the consultation parser", () => {
    const prompt = promptOf(3);
    expect(evidenceHandles(prompt)).toEqual(["e1", "e2", "e3"]);
    const answer = parseConsultationAnswer(askAnswer(prompt), snapshotOf(3));
    expect(answer.paragraphs.map((paragraph) => paragraph.citations)).toEqual([
      ["e1"],
      ["e2"],
      ["e3"]
    ]);
    for (const paragraph of answer.paragraphs) {
      const [handle] = paragraph.citations;
      expect(paragraph.markdown).toContain(`[${handle}]`);
    }
    expect(answer.paragraphs[0]!.markdown).toBe("The first passage addresses the question [e1].");
  });

  it("reuses the passages it has when the prompt offers fewer than three", () => {
    const two = parseConsultationAnswer(askAnswer(promptOf(2)), snapshotOf(2));
    expect(two.paragraphs.map((paragraph) => paragraph.citations)).toEqual([
      ["e1"],
      ["e2"],
      ["e1"]
    ]);
    const one = parseConsultationAnswer(askAnswer(promptOf(1)), snapshotOf(1));
    expect(one.paragraphs.map((paragraph) => paragraph.citations)).toEqual([
      ["e1"],
      ["e1"],
      ["e1"]
    ]);
  });

  it("is plain text for a prompt with no passages, and still cut off when malformed", () => {
    expect(askAnswer("Summarize this.")).toBe("OK");
    expect(() => JSON.parse(malformedAskAnswer)).toThrow();
  });
});

describe("how the fake plays an Ask answer", () => {
  const script = (latencyMs = 60, count = 3) =>
    kind(latencyMs).reply(streamRequest(promptOf(count)), { seq: 1, elapsedMs: 0 });

  it("takes at least 600 ms, even when the recorded latency is shorter", () => {
    expect(defaultAskStreamPlan).toEqual({ minMs: 600, minPieces: 6 });
    expect(plannedMs(script(60))).toBeGreaterThanOrEqual(600);
    // A longer call keeps its own length.
    expect(plannedMs(script(2_000))).toBeGreaterThanOrEqual(1_990);
  });

  it("streams in at least 6 pieces that add up to the answer", () => {
    const pieces = timedText(script());
    expect(pieces.length).toBeGreaterThanOrEqual(6);
    expect(pieces.map((piece) => piece.text).join("")).toBe(askAnswer(promptOf(3)));
    // Even a prompt with one passage (shorter text) and a cut-off answer keep the minimum.
    expect(timedText(script(60, 1)).length).toBeGreaterThanOrEqual(6);
    expect(askAnswerPieces(malformedAskAnswer, 6).length).toBeGreaterThanOrEqual(6);
  });

  it("completes each paragraph at least 100 ms after the one before", () => {
    const reader = createAnswerStreamReader();
    const completions: number[] = [];
    for (const piece of timedText(script())) {
      const before = reader.state().paragraphs.length;
      const after = reader.push(piece.text).paragraphs.length;
      for (let count = before; count < after; count++) completions.push(piece.at);
    }
    expect(completions).toHaveLength(3);
    for (let index = 1; index < completions.length; index++)
      expect(completions[index]! - completions[index - 1]!).toBeGreaterThanOrEqual(100);
  });

  it("yields at least two deltas under the bus's 50 ms window", () => {
    vi.useFakeTimers();
    try {
      const sent: AppEvent[] = [];
      const bus = new AppEventBus({ send: (event) => sent.push(event) });
      const requestId = "6b1e6f0e-0c7a-4f3e-9d5e-0f9a8f5f2a11";
      const questionId = "6b1e6f0e-0c7a-4f3e-9d5e-0f9a8f5f2a12";
      const reader = createAnswerStreamReader();
      let clock = 0;
      for (const piece of timedText(script())) {
        vi.advanceTimersByTime(piece.at - clock);
        clock = piece.at;
        const before = reader.state().paragraphs.length;
        const { paragraphs } = reader.push(piece.text);
        if (paragraphs.length > before)
          bus.publish({
            type: "consultation.delta",
            requestId,
            questionId,
            paragraphs: paragraphs.map((paragraph) => ({
              markdown: paragraph.markdown,
              citations: []
            })),
            restart: false
          });
      }
      vi.advanceTimersByTime(60);
      const deltas = sent.filter((event) => event.type === "consultation.delta");
      expect(deltas.length).toBeGreaterThanOrEqual(2);
      bus.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies the plan to Ask answers only, and a request that does not stream keeps the whole answer", () => {
    const plain = kind(40).reply(streamRequest("Summarize this."), { seq: 1, elapsedMs: 0 });
    expect(plannedMs(plain)).toBeLessThan(600);
    const whole = kind(40).reply(streamRequest(promptOf(3), false), { seq: 2, elapsedMs: 0 });
    expect(whole.parts).toHaveLength(1);
    expect(plannedMs(whole)).toBeGreaterThanOrEqual(600);
    expect(JSON.parse(whole.parts[0]!.data).choices[0].message.content).toBe(
      askAnswer(promptOf(3))
    );
  });

  it("takes another plan when one is given", () => {
    const quick = openAiCompatibleKind({
      seed: 1,
      latency: fixedLatency(20),
      askStream: { minMs: 0, minPieces: 1 }
    });
    expect(plannedMs(quick.reply(streamRequest(promptOf(3)), { seq: 1, elapsedMs: 0 }))).toBe(20);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
