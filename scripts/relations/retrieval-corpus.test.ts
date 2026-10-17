import { describe, expect, it } from "vitest";

import { dot, RetrievalCorpus, vectorLiteral } from "./retrieval-corpus.js";
import { syntheticNoteState } from "./retrieval-seed.js";

describe("the retrieval corpus", () => {
  const corpus = new RetrievalCorpus({ seed: 7 });

  it("is a pure function of the seed and the index", () => {
    const again = new RetrievalCorpus({ seed: 7 });
    expect(again.note(41)).toEqual(corpus.note(41));
    expect(Array.from(again.vector(41, 256))).toEqual(Array.from(corpus.vector(41, 256)));
    expect(new RetrievalCorpus({ seed: 8 }).note(41)).not.toEqual(corpus.note(41));
    expect(corpus.note(41)).not.toEqual(corpus.note(42));
  });

  it("writes titles, ideas and bodies of a note's size, in two languages", () => {
    const notes = Array.from({ length: 300 }, (_, index) => corpus.note(index + 1));
    const portuguese = notes.filter((note) => note.language === "pt").length;
    expect(portuguese).toBeGreaterThan(60);
    expect(portuguese).toBeLessThan(150);
    for (const note of notes) {
      expect(note.title.split(" ").length).toBeGreaterThanOrEqual(3);
      expect(note.idea.endsWith(".")).toBe(true);
      expect(note.body.length).toBeGreaterThan(100);
      expect(note.body.length).toBeLessThan(4_000);
    }
    // Accents occur, so the unaccenting of the index has work to do.
    expect(notes.some((note) => /[áãçê]/u.test(`${note.title} ${note.idea} ${note.body}`))).toBe(
      true
    );
  });

  it("embeds a note as a unit vector whose neighbours share its topic", () => {
    const vector = corpus.vector(1, 256);
    expect(vector).toHaveLength(256);
    expect(dot(vector, vector)).toBeCloseTo(1, 4);
    expect(vectorLiteral(new Float32Array([0.5, -0.25]))).toBe("[0.500000,-0.250000]");
    // Notes of one primary topic are nearer each other than notes of different topics.
    const few = new RetrievalCorpus({ seed: 7, topics: 10 });
    const sameTopic: number[] = [];
    const otherTopic: number[] = [];
    const first = few.note(1);
    const firstVector = few.vector(1, 256);
    for (let index = 2; index <= 400; index += 1) {
      const similarity = dot(firstVector, few.vector(index, 256));
      (few.note(index).topic === first.topic ? sameTopic : otherTopic).push(similarity);
    }
    const average = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
    expect(sameTopic.length).toBeGreaterThan(0);
    expect(average(sameTopic)).toBeGreaterThan(average(otherTopic) + 0.1);
  });

  it("marks about a tenth of the notes as not eligible for matching", () => {
    const states = Array.from({ length: 1_000 }, (_, index) => syntheticNoteState(index + 1));
    const excluded = states.filter(
      (state) => state.status !== "active" || state.supersession !== "current"
    );
    expect(excluded).toHaveLength(80);
    expect(states.filter((state) => state.status === "rejected")).toHaveLength(20);
    expect(states.filter((state) => state.supersession === "superseded")).toHaveLength(30);
  });
});
