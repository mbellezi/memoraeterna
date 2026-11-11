import { describe, expect, it } from "vitest";

import {
  createAnswerStreamReader,
  evidenceHandleOrdinal,
  type StreamedAnswerParagraph
} from "./consultation-stream.js";

const contextId = "6b1e6f0e-0c7a-4f3e-9d5e-0f9a8f5f2a11";

/** Three answers shaped like the ones the Ask prompt gets back, as their runtimes write them. */
const answers: Array<{ name: string; text: string; expected: StreamedAnswerParagraph[] }> = [
  {
    // A remote runtime under the strict schema: `change` null first, every member written, compact.
    name: "a strict answer with a null change, context links and gaps",
    text: JSON.stringify({
      change: null,
      paragraphs: [
        {
          markdown: 'Memory is "reconstructive" [e1], not a recording [e2].',
          citations: ["e1", "e2"],
          contextIds: [contextId]
        },
        {
          markdown: "Sleep consolidates traces [e3].\n\nSecond line of the same paragraph.",
          citations: ["e3"],
          contextIds: []
        }
      ],
      gaps: ["No passage covers infants."]
    }),
    expected: [
      {
        markdown: 'Memory is "reconstructive" [e1], not a recording [e2].',
        citations: ["e1", "e2"]
      },
      {
        markdown: "Sleep consolidates traces [e3].\n\nSecond line of the same paragraph.",
        citations: ["e3"]
      }
    ]
  },
  {
    // A local runtime without a grammar: a code fence, an investigation's `change` object, text
    // that looks like JSON inside strings, escapes, an emoji as a pair and as `\u` escapes.
    name: "a fenced answer with a change object, braces and escapes inside the text",
    text: [
      "```json",
      JSON.stringify(
        {
          change: { meaningful: true, explanation: ['The claim moved from [1, 2] to {"a": 3}.'] },
          paragraphs: [
            {
              markdown:
                "  Caf\u00e9 \u2014 caf\u00e9 \ud83d\ude00 and a literal brace } or ] in text [e1].  ",
              citations: ["e1"],
              contextIds: []
            },
            {
              markdown: 'Path C:\\\\data and a quote " and a tab\tand \u2028 end [e2][e4].',
              citations: ["e2", "e4"],
              contextIds: [contextId]
            },
            { markdown: "Short [e12].", citations: ["e12"], contextIds: [] }
          ],
          gaps: []
        },
        null,
        2
      ),
      "```"
    ].join("\n"),
    expected: [
      {
        markdown: "Café — café \u{1F600} and a literal brace } or ] in text [e1].",
        citations: ["e1"]
      },
      {
        markdown: 'Path C:\\\\data and a quote " and a tab\tand \u2028 end [e2][e4].',
        citations: ["e2", "e4"]
      },
      { markdown: "Short [e12].", citations: ["e12"] }
    ]
  },
  {
    // Members in another order, the paragraph's citations before its markdown, a repeated handle,
    // and `\u` escapes spelled out in the wire text (a surrogate pair among them).
    name: "an answer with members in another order and escapes spelled in the wire text",
    text:
      '{"gaps":[],"paragraphs":[{"contextIds":[],"citations":["e1","e1","e5"],' +
      '"markdown":"Escapes: \\u00e9 \\ud83d\\ude00 \\u0041 and \\/ slash [e1][e5]."},' +
      '{"citations":["e2"],"markdown":"Last one [e2].","contextIds":["' +
      contextId +
      '"]}],"change":null}',
    expected: [
      { markdown: "Escapes: é \u{1F600} A and / slash [e1][e5].", citations: ["e1", "e5"] },
      { markdown: "Last one [e2].", citations: ["e2"] }
    ]
  }
];

function readAll(pieces: readonly string[]) {
  const reader = createAnswerStreamReader();
  let state = reader.state();
  for (const piece of pieces) state = reader.push(piece);
  return state;
}

describe("the answer stream reader", () => {
  for (const { name, text, expected } of answers) {
    describe(name, () => {
      it("reads the whole text as one piece", () => {
        const state = readAll([text]);
        expect(state.paragraphs).toEqual(expected);
        expect(state.finished).toBe(true);
        expect(state.partial).toBeNull();
      });

      it("reads the same paragraphs at every split of the text into two pieces", () => {
        for (let offset = 0; offset <= text.length; offset++) {
          const state = readAll([text.slice(0, offset), text.slice(offset)]);
          expect(state.paragraphs, `split at ${offset}`).toEqual(expected);
          expect(state.finished).toBe(true);
        }
      });

      it("reads the same paragraphs at every split of the text's UTF-8 bytes", () => {
        const bytes = Buffer.from(text, "utf8");
        for (let offset = 0; offset <= bytes.length; offset++) {
          const decoder = new TextDecoder("utf-8");
          const pieces = [
            decoder.decode(bytes.subarray(0, offset), { stream: true }),
            decoder.decode(bytes.subarray(offset), { stream: true })
          ];
          expect(readAll(pieces).paragraphs, `byte split at ${offset}`).toEqual(expected);
        }
      });

      it("reads the same paragraphs one character at a time and shows only finished work", () => {
        const reader = createAnswerStreamReader();
        let previous: readonly StreamedAnswerParagraph[] = reader.state().paragraphs;
        for (const character of text) {
          const state = reader.push(character);
          // Paragraphs only ever grow, each is whole, and the array changes only when one completes.
          expect(state.paragraphs.length).toBeGreaterThanOrEqual(previous.length);
          expect(state.paragraphs.slice(0, previous.length)).toEqual(previous);
          if (state.paragraphs.length === previous.length) expect(state.paragraphs).toBe(previous);
          state.paragraphs.forEach((paragraph, index) =>
            expect(paragraph).toEqual(expected[index])
          );
          // The paragraph being written shows its markdown so far and never a citation.
          if (state.partial) {
            expect(Object.keys(state.partial)).toEqual(["markdown"]);
            const target = expected[state.paragraphs.length];
            expect(target?.markdown.startsWith(state.partial.markdown.trim())).toBe(true);
          }
          previous = state.paragraphs;
        }
        expect(previous).toEqual(expected);
      });

      it("counts a paragraph only once its object has closed", () => {
        const first = text.indexOf("paragraphs");
        const reader = createAnswerStreamReader();
        reader.push(text.slice(0, first));
        let counts: number[] = [];
        for (const character of text.slice(first))
          counts.push(reader.push(character).paragraphs.length);
        counts = [...new Set(counts)];
        expect(counts).toEqual(Array.from({ length: expected.length + 1 }, (_, index) => index));
      });
    });
  }

  it("ignores a citation that has not closed and keeps the paragraph out until it does", () => {
    const reader = createAnswerStreamReader();
    reader.push('{"paragraphs":[{"markdown":"Done [e1]","citations":["e1","e');
    expect(reader.state().paragraphs).toEqual([]);
    expect(reader.state().partial).toEqual({ markdown: "Done [e1]" });
    reader.push('2"],"contextIds":[]}');
    expect(reader.state().paragraphs).toEqual([{ markdown: "Done [e1]", citations: ["e1", "e2"] }]);
    expect(reader.state().partial).toBeNull();
  });

  it("starts again after a reset and forgets the earlier attempt", () => {
    const reader = createAnswerStreamReader();
    reader.push(answers[0]!.text);
    expect(reader.state().finished).toBe(true);
    reader.reset();
    expect(reader.state()).toEqual({ paragraphs: [], partial: null, finished: false });
    expect(reader.push(answers[2]!.text).paragraphs).toEqual(answers[2]!.expected);
  });

  it("takes nothing after the answer's closing brace", () => {
    const reader = createAnswerStreamReader();
    reader.push(answers[0]!.text);
    const after = reader.push(
      '{"paragraphs":[{"markdown":"Extra","citations":[],"contextIds":[]}]}'
    );
    expect(after.paragraphs).toEqual(answers[0]!.expected);
  });

  it("does not throw on text that is not an answer and keeps what was complete", () => {
    expect(() => readAll(["I cannot answer that.", ' {{{ ]]] "', "\\u12"])).not.toThrow();
    const state = readAll([
      '{"paragraphs":[{"markdown":"Kept [e1]","citations":["e1"]},',
      "garbage ]]]}}"
    ]);
    expect(state.paragraphs).toEqual([{ markdown: "Kept [e1]", citations: ["e1"] }]);
  });

  it("skips a paragraph with no text", () => {
    const state = readAll([
      '{"paragraphs":[{"markdown":"  ","citations":[]},{"markdown":"Real","citations":[]}]}'
    ]);
    expect(state.paragraphs).toEqual([{ markdown: "Real", citations: [] }]);
  });

  it("names the ordinal an evidence handle stands for", () => {
    expect(evidenceHandleOrdinal("e1")).toBe(1);
    expect(evidenceHandleOrdinal("e12")).toBe(12);
    expect(evidenceHandleOrdinal("e0")).toBeNull();
    expect(evidenceHandleOrdinal("x1")).toBeNull();
    expect(evidenceHandleOrdinal("e1000")).toBeNull();
  });
});
