import { describe, expect, it } from "vitest";

import {
  aiPlace,
  applyDelta,
  applyStatus,
  citationAddress,
  citedObjectCount,
  emptyStream,
  failureKey,
  foundNothing,
  numberCitations,
  plainText,
  shownAnswer,
  splitParagraph,
  streamFor,
  type AnswerParagraph,
  type StreamState
} from "./answer-model";
import { askFixture, citationAddresses, deltaParagraphs, questionFixture } from "./ask-fixtures";

const request = askFixture.requestId;
const other = "00000000-0000-4000-8000-0000000000ff";
const delta = (count: number, restart = false, requestId = request) => ({
  requestId,
  paragraphs: deltaParagraphs(count),
  restart
});

describe("merging the stream", () => {
  it("replaces the paragraphs with each delta, and applying one twice changes nothing", () => {
    const one = applyDelta(streamFor(request), delta(1));
    expect(one.paragraphs).toHaveLength(1);
    expect(one.stage).toBe("answering");
    const two = applyDelta(one, delta(2));
    expect(two.paragraphs).toHaveLength(2);
    expect(applyDelta(two, delta(2))).toBe(two);
  });

  it("drops an older delta that arrives late, and a restart voids what was shown", () => {
    const two = applyDelta(streamFor(request), delta(2));
    expect(applyDelta(two, delta(1))).toBe(two);
    const restarted = applyDelta(two, { requestId: request, paragraphs: [], restart: true });
    expect(restarted.paragraphs).toEqual([]);
    expect(restarted.stage).toBe("answering");
    expect(applyDelta(restarted, delta(1)).paragraphs).toHaveLength(1);
  });

  it("follows the stages and never goes back from answering to retrieving", () => {
    let state: StreamState = emptyStream;
    state = applyStatus(state, { requestId: request, stage: "retrieving" });
    expect(state.stage).toBe("retrieving");
    state = applyStatus(state, { requestId: request, stage: "answering" });
    state = applyStatus(state, { requestId: request, stage: "retrieving" });
    expect(state.stage).toBe("answering");
    state = applyStatus(state, { requestId: request, stage: "waitingForProvider" });
    expect(state.stage).toBe("waitingForProvider");
    // The provider answered again: the next delta means the answer is being written.
    state = applyDelta(state, delta(1));
    expect(state.stage).toBe("answering");
  });

  it("keeps an end stage, and a request that is not the live one is not this stream's", () => {
    const live = applyDelta(streamFor(request), delta(1));
    expect(applyDelta(live, delta(2, false, other))).toBe(live);
    expect(applyStatus(live, { requestId: other, stage: "done" })).toBe(live);
    const done = applyStatus(live, { requestId: request, stage: "done" });
    expect(done.stage).toBe("done");
    expect(applyDelta(done, delta(2))).toBe(done);
    expect(applyStatus(done, { requestId: request, stage: "answering" })).toBe(done);
    // A new request (Ask again) after the end starts its own run.
    const again = applyStatus(done, { requestId: other, stage: "retrieving" });
    expect(again).toMatchObject({ requestId: other, stage: "retrieving", paragraphs: [] });
  });

  it("carries the failure's words", () => {
    const failed = applyStatus(streamFor(request), {
      requestId: request,
      stage: "failed",
      error: "consultation.errors.rateLimited"
    });
    expect(failed.error).toBe("consultation.errors.rateLimited");
    expect(failureKey(failed.error)).toBe("consultation.errors.rateLimited");
    expect(failureKey("provider said 500")).toBeNull();
    expect(failureKey(undefined)).toBeNull();
  });
});

describe("what the page shows", () => {
  it("shows the stream while the Question runs, and the stored version once it does not", () => {
    const stream = applyDelta(streamFor(request), delta(2));
    const running = shownAnswer(questionFixture("running"), stream);
    expect(running).toMatchObject({ stage: "answering", live: true, version: 0 });
    expect(running.paragraphs).toHaveLength(2);
    const done = shownAnswer(questionFixture("done"), stream);
    expect(done).toMatchObject({ stage: "done", live: false, version: 1, versions: 1 });
    expect(done.paragraphs).toHaveLength(3);
  });

  it("keeps the stream's paragraphs until the stored answer is read after the Ask ended", () => {
    const ended = applyStatus(applyDelta(streamFor(request), delta(3)), {
      requestId: request,
      stage: "done"
    });
    const shown = shownAnswer(questionFixture("running"), ended);
    expect(shown).toMatchObject({ stage: "done", live: false });
    expect(shown.paragraphs).toHaveLength(3);
  });

  it("says retrieving before any event, and that a stored answer may be outdated", () => {
    expect(shownAnswer(questionFixture("running"), emptyStream)).toMatchObject({
      stage: "retrieving",
      live: true,
      paragraphs: []
    });
    expect(shownAnswer(questionFixture("stale"), emptyStream).stale).toBe(true);
    expect(shownAnswer(questionFixture("done"), emptyStream).stale).toBe(false);
  });

  it("reads a stopped or failed Question with what it holds", () => {
    const canceled = shownAnswer(questionFixture("canceled"), emptyStream);
    expect(canceled).toMatchObject({ stage: "canceled", live: false });
    expect(canceled.paragraphs).toHaveLength(2);
    const failed = shownAnswer(questionFixture("failed"), emptyStream);
    expect(failed).toMatchObject({ stage: "failed", error: "consultation.errors.rateLimited" });
    // A failure after some paragraphs arrived keeps them.
    const partial = shownAnswer(
      questionFixture("failed"),
      applyDelta(streamFor(request), delta(1))
    );
    expect(partial.paragraphs).toHaveLength(1);
  });

  it("finds nothing to rest on when the Ask failed with a no-evidence key and wrote nothing", () => {
    const stored = shownAnswer(questionFixture("noGrounding"), emptyStream);
    expect(stored).toMatchObject({ stage: "failed", paragraphs: [] });
    expect(foundNothing(stored)).toBe(true);
    // The stream's failure says the same before the stored Question is read.
    const streamed = shownAnswer(
      questionFixture("running"),
      applyStatus(streamFor(request), {
        requestId: request,
        stage: "failed",
        error: "consultation.errors.noTopicEvidence"
      })
    );
    expect(foundNothing(streamed)).toBe(true);
    // Another failure, or a failure that kept paragraphs, is a failure.
    expect(foundNothing(shownAnswer(questionFixture("failed"), emptyStream))).toBe(false);
    expect(foundNothing(shownAnswer(questionFixture("done"), emptyStream))).toBe(false);
  });

  it("picks an older version, which is not stale and has no error", () => {
    const question = questionFixture("done");
    const first = question.answers[0];
    if (!first) throw new Error("fixture has an answer");
    const two = {
      ...question,
      status: "complete" as const,
      answers: [
        { ...first, stale: true },
        { ...first, version: 2 }
      ]
    };
    expect(shownAnswer(two, emptyStream)).toMatchObject({ version: 2, versions: 2, stale: false });
    expect(shownAnswer(two, emptyStream, 1)).toMatchObject({ version: 1, stale: true });
    expect(shownAnswer(two, emptyStream, 9).version).toBe(2);
  });
});

describe("the citations in reading order", () => {
  const paragraph = (markdown: string, ordinals: number[]): AnswerParagraph => ({
    markdown,
    citations: ordinals.map((ordinal) => ({
      ordinal,
      address: citationAddresses[(ordinal - 1) % 3] as string,
      unavailable: false,
      stale: false
    }))
  });

  it("numbers a citation by the first marker the text reaches, one number per citation", () => {
    const { sources, numberOf } = numberCitations([
      paragraph("First [e3] then [e1].", [1, 3]),
      paragraph("Again [e3], and [e2].", [2, 3])
    ]);
    expect(sources.map((entry) => [entry.number, entry.citation.ordinal])).toEqual([
      [1, 3],
      [2, 1],
      [3, 2]
    ]);
    expect(numberOf.get(3)).toBe(1);
  });

  it("lists a citation its text never marks after the marked ones of that paragraph", () => {
    const { sources } = numberCitations([paragraph("Only [e2].", [1, 2])]);
    expect(sources.map((entry) => entry.citation.ordinal)).toEqual([2, 1]);
  });

  it("breaks a paragraph into words and chips, a chip attached to the word before it", () => {
    const text = paragraph("Acid helps [e1]; salt too [e2].", [1, 2]);
    const { numberOf } = numberCitations([text]);
    expect(splitParagraph(text, numberOf)).toEqual([
      { type: "text", text: "Acid helps" },
      { type: "cite", ordinal: 1, number: 1, attached: true },
      { type: "text", text: "; salt too" },
      { type: "cite", ordinal: 2, number: 2, attached: true },
      { type: "text", text: "." }
    ]);
  });

  it("drops a marker whose citation did not resolve, and counts the distinct sources", () => {
    const text = paragraph("A claim [e1] and another [e9].", [1]);
    const { sources, numberOf } = numberCitations([text]);
    const pieces = splitParagraph(text, numberOf);
    expect(pieces.filter((piece) => piece.type === "cite")).toHaveLength(1);
    expect(pieces.at(-1)).toEqual({ type: "text", text: "." });
    expect(citedObjectCount(sources)).toBe(1);
    const both = numberCitations([paragraph("[e1] [e2] [e3]", [1, 2, 3])]);
    // Passages 1 and 2 are in one source, passage 3 in another.
    expect(citedObjectCount(both.sources)).toBe(2);
  });

  it("opens a citation at its passage and span, and a removed one at nothing", () => {
    expect(
      citationAddress({ ordinal: 1, address: null, unavailable: true, stale: false })
    ).toBeNull();
    const address = citationAddress({
      ordinal: 1,
      address: citationAddresses[0] as string,
      unavailable: false,
      stale: false
    });
    expect(address).toBe(citationAddresses[0]);
  });

  it("reads a paragraph with no chips and no marks for the compact form", () => {
    expect(plainText("The **acid** helps [e1] and `pH` [text](memora://note/x).")).toBe(
      "The acid helps and pH text."
    );
  });
});

describe("where the model ran", () => {
  it("says local for a local lane and cloud for a provider, and nothing until the route is known", () => {
    expect(aiPlace({ lane: "local-mlx" })).toBe("local");
    expect(aiPlace({ provider: "openai" })).toBe("cloud");
    // The stored privacy column never says where a model ran: with no provenance there is no answer.
    expect(aiPlace(undefined)).toBeNull();
    expect(aiPlace({})).toBeNull();
  });
});
