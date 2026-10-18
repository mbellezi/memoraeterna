import { describe, expect, it, vi } from "vitest";

import { relationExplanationLimits } from "@app/domain";

import { DeltaCoalescer, RelationExplanationStream } from "./relation-explanation-stream.js";

const ids = {
  first: "00000000-0000-4000-8000-0000000000aa",
  second: "00000000-0000-4000-8000-0000000000bb"
};
const ref = (id: string) => `<note-ref id="${id}" />`;

/** The preview after each piece, for the pieces of one answer. */
function previews(pieces: string[]): Array<string | null> {
  const stream = new RelationExplanationStream(ids);
  return pieces.map((piece) => {
    stream.push(piece);
    return stream.visible();
  });
}

describe("the preview of a streamed explanation", () => {
  it("holds the first 16 characters, then shows the text so far", () => {
    expect(previews(["Both notes", " say", " it twice."])).toEqual([
      null,
      null,
      "Both notes say it twice."
    ]);
    expect(previews(["Exactly sixteen c", "hars and more."])[0]).toBe("Exactly sixteen c");
    // Fifteen characters are not enough, sixteen are.
    expect(previews(["123456789012345"])).toEqual([null]);
    expect(previews(["1234567890123456"])).toEqual(["1234567890123456"]);
  });

  it("counts the characters the validator will read: no leading space, one space per run", () => {
    expect(previews(["   \n  Both  notes\n\nsay", " it"])).toEqual([null, "Both notes say it"]);
  });

  it("never shows an answer that begins with the sentinel, whatever surrounds it", () => {
    for (const answer of [
      "NOT_RELATED",
      "NOT_RELATED because the notes only share a word.",
      '"NOT_RELATED" because the notes only share a word.',
      "`not_related` because the notes only share a word.",
      "**NOT_RELATED** because the notes only share a word."
    ])
      expect(previews([answer.slice(0, 5), answer.slice(5)])).toEqual([null, null]);
    // An answer that merely resembles it is shown.
    expect(previews(["Not related at first sight, but yes."])[0]).toBe(
      "Not related at first sight, but yes."
    );
  });

  it("turns complete aliases into canonical references and only those", () => {
    const [text] = previews(["Note n1 supports what n2 reports, as the N400 and n12 show."]);
    expect(text).toBe(
      `Note ${ref(ids.first)} supports what ${ref(ids.second)} reports, as the N400 and n12 show.`
    );
  });

  it("holds a trailing partial alias until the next piece resolves it", () => {
    const shown = previews([
      "Both notes agree that n",
      "1",
      " and n",
      "2.",
      "5 differ, as n1-",
      "n2 do."
    ]);
    expect(shown).toEqual([
      // "n" may become "n1".
      "Both notes agree that ",
      // "n1" may become "n12" or "n1_x".
      "Both notes agree that ",
      `Both notes agree that ${ref(ids.first)} and `,
      // "n2." may become "n2.5": a number, which is content.
      `Both notes agree that ${ref(ids.first)} and `,
      `Both notes agree that ${ref(ids.first)} and n2.5 differ, as `,
      `Both notes agree that ${ref(ids.first)} and n2.5 differ, as ${ref(ids.first)}-${ref(ids.second)} do.`
    ]);
  });

  it("does not hold a word that merely ends in n", () => {
    expect(previews(["The notes can then explain"])[0]).toBe("The notes can then explain");
    expect(previews(["The notes can then"])[0]).toBe("The notes can then");
    expect(previews(["The first note says it again"])[0]).toBe("The first note says it again");
  });

  it("stops at a tag, which the validator will refuse", () => {
    expect(previews(["The first note supports <b>the", " second</b> one."])).toEqual([
      "The first note supports ",
      "The first note supports "
    ]);
    expect(previews(["The first note supports <", "note-ref id='x' />"])).toEqual([
      "The first note supports ",
      "The first note supports "
    ]);
    // A less-than sign that is not a tag is text.
    expect(previews(["Recall is below 5 < the expected rate."])[0]).toBe(
      "Recall is below 5 < the expected rate."
    );
  });

  it("stops growing at the model's bound", () => {
    const [text] = previews(["word ".repeat(200)]);
    expect(text!.length).toBeLessThanOrEqual(relationExplanationLimits.modelCharacters);
  });

  it("only grows, until a retried attempt restarts the answer", () => {
    const stream = new RelationExplanationStream(ids);
    stream.push("The first attempt writes");
    expect(stream.visible()).toBe("The first attempt writes");
    stream.push(" more");
    expect(stream.visible()).toBe("The first attempt writes more");
    // The first piece of the second attempt is void text that was shown: the card goes back to writing.
    stream.push("The second", true);
    expect(stream.visible()).toBe("");
    stream.push(" attempt writes it again.");
    expect(stream.visible()).toBe("The second attempt writes it again.");
    stream.clear();
    expect(stream.visible()).toBe("");
  });

  it("shows nothing at all for an answer that never became visible", () => {
    const stream = new RelationExplanationStream(ids);
    stream.push("Short.", true);
    expect(stream.visible()).toBeNull();
  });
});

describe("the coalescing of text messages", () => {
  const harness = () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const coalescer = new DeltaCoalescer((text) => sent.push(text));
    return { sent, coalescer };
  };

  it("sends the first text at once and at most one message per 50 ms after that", async () => {
    try {
      const { sent, coalescer } = harness();
      coalescer.update("A");
      coalescer.update("AB");
      coalescer.update("ABC");
      expect(sent).toEqual(["A"]);
      await vi.advanceTimersByTimeAsync(49);
      expect(sent).toEqual(["A"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual(["A", "ABC"]);
      // A quiet window is over: the next text leaves at once again.
      await vi.advanceTimersByTimeAsync(80);
      coalescer.update("ABCD");
      expect(sent).toEqual(["A", "ABC", "ABCD"]);
      coalescer.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing twice, and a flush sends the last text now", async () => {
    try {
      const { sent, coalescer } = harness();
      coalescer.update("A");
      coalescer.update("A");
      coalescer.update("AB");
      coalescer.update("A");
      await vi.advanceTimersByTimeAsync(60);
      expect(sent).toEqual(["A"]);
      // A text that arrives after a quiet window leaves at once; the next one waits and is flushed.
      coalescer.update("AB");
      coalescer.update("ABC");
      expect(sent).toEqual(["A", "AB"]);
      coalescer.flush();
      expect(sent).toEqual(["A", "AB", "ABC"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends nothing after it was disposed, and leaves no timer", async () => {
    try {
      const { sent, coalescer } = harness();
      coalescer.update("A");
      coalescer.update("AB");
      coalescer.dispose();
      coalescer.update("ABC");
      coalescer.flush();
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toEqual(["A"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
