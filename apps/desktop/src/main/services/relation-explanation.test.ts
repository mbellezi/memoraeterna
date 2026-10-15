import { describe, expect, it } from "vitest";
import { relationExplanationLimits, relationExplanationOrder } from "@app/domain";

import { defaultPromptPin, promptAudit, withPromptPin } from "./prompt-runtime.js";
import {
  acceptRelationExplanation,
  buildRelationExplanationPrompt,
  buildRelationExplanationRepairPrompt,
  parseRelationExplanation,
  resolveRelationExplanationReferences
} from "./relation-explanation.js";

const ids = {
  a: "00000000-0000-4000-8000-0000000000aa",
  b: "00000000-0000-4000-8000-0000000000bb",
  c: "00000000-0000-4000-8000-0000000000cc"
};
const retrieval = {
  title: "Retrieval",
  ideaStatement: "Retrieval with feedback improved delayed recall.",
  passage: "In a fictional study, retrieval with feedback improved recall."
};
const spacing = {
  title: "Spacing",
  ideaStatement: "Spaced practice strengthens long-term memory.",
  passage: "Practice on separate days improved recall a week later."
};

function promptFor(type: string, a: string, b: string, semanticSourceId: string | null) {
  const order = relationExplanationOrder({
    type,
    semanticSourceId,
    a: { id: a, ...retrieval },
    b: { id: b, ...spacing }
  });
  return withPromptPin(defaultPromptPin(), () =>
    buildRelationExplanationPrompt({
      type,
      direction: order.direction,
      first: order.first,
      second: order.second
    })
  );
}

describe("relation explanation prompt", () => {
  it("is a function of content: other IDs give the same prompt, and no ID reaches it", () => {
    for (const type of ["supports", "contrasts"]) {
      const first = promptFor(type, ids.a, ids.b, null);
      expect(promptFor(type, ids.c, ids.b, null)).toBe(first);
      expect(promptFor(type, ids.b, ids.a, null)).toBe(first);
      expect(first).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
    const directed = promptFor("supports", ids.a, ids.b, ids.a);
    expect(promptFor("supports", ids.c, ids.b, ids.c)).toBe(directed);
  });

  it("states the type, the direction, the limit and both notes with their passages", () => {
    const prompt = promptFor("supports", ids.a, ids.b, ids.b);
    expect(prompt).toContain("its type is supports and its direction is n1_to_n2");
    expect(prompt).toContain(`at most ${relationExplanationLimits.modelCharacters} characters`);
    // The decided subject (spacing) is n1.
    expect(prompt.indexOf(spacing.ideaStatement)).toBeLessThan(
      prompt.indexOf(retrieval.ideaStatement)
    );
    expect(prompt).toContain('"note":"n1"');
    expect(prompt).toContain(spacing.passage);
    expect(promptFor("supports", ids.a, ids.b, null)).toContain("its direction is unknown");
    expect(promptFor("similar_to", ids.a, ids.b, ids.a)).toContain("its direction is symmetric");
  });

  it("omits a passage that is gone instead of inventing one", () => {
    const prompt = withPromptPin(defaultPromptPin(), () =>
      buildRelationExplanationPrompt({
        type: "related",
        direction: "symmetric",
        first: { ideaStatement: "A", passage: null },
        second: { ideaStatement: "B", passage: "Only this passage." }
      })
    );
    expect(prompt).toContain('{"note":"n1","idea":"A"}');
    expect(prompt).toContain("Only this passage.");
  });

  it("records the catalog prompts it was rendered from, repair included", () => {
    withPromptPin(defaultPromptPin(), () => {
      const prompt = buildRelationExplanationPrompt({
        type: "supports",
        direction: "n1_to_n2",
        first: { ideaStatement: retrieval.ideaStatement, passage: retrieval.passage },
        second: { ideaStatement: spacing.ideaStatement, passage: null }
      });
      expect(promptAudit(prompt).map((entry) => entry.promptId)).toContain("relations.explain");
      const repair = buildRelationExplanationRepairPrompt(prompt);
      expect(repair.startsWith(prompt)).toBe(true);
      expect(promptAudit(repair).map((entry) => entry.promptId)).toEqual(
        expect.arrayContaining(["relations.explain", "relations.explain.repair"])
      );
    });
  });
});

describe("relation explanation output", () => {
  it("accepts short plain text that names the notes as n1 and n2", () => {
    expect(parseRelationExplanation("  n1 explains why n2 holds.  ")).toBe(
      "n1 explains why n2 holds."
    );
    expect(parseRelationExplanation('"n1 and n2 agree."')).toBe("n1 and n2 agree.");
    expect(parseRelationExplanation("“n1 qualifies n2.”")).toBe("n1 qualifies n2.");
    expect(parseRelationExplanation("Both describe\n\nrecall.")).toBe("Both describe recall.");
  });

  it("refuses empty, long, tagged or out-of-contract text", () => {
    for (const output of [
      null,
      { text: "n1" },
      "",
      "   ",
      "x".repeat(relationExplanationLimits.modelCharacters + 1),
      `n1 supports <note-ref id="${ids.a}" />.`,
      "n1 supports <b>n2</b>."
    ])
      expect(parseRelationExplanation(output)).toBeNull();
    expect(
      parseRelationExplanation("x".repeat(relationExplanationLimits.modelCharacters))
    ).not.toBeNull();
  });

  it("keeps content tokens such as N400, N95 and N2 sleep: only n1 and n2 name the notes", () => {
    for (const text of [
      "n1 reports the N400 effect that n2 extends.",
      "n1 says N95 masks filter aerosols, which n2 relies on.",
      "n1 and n2 both describe N3 slow-wave sleep.",
      "n1 and n2 both reach JLPT N1 level.",
      "N2 sleep follows from what n1 reports about n2.",
      "n1 links n3 fatty acids to n2.",
      "n1 supports n3 and N7 is unrelated."
    ])
      expect(parseRelationExplanation(text)).toBe(text);
  });

  it("strips quotes only when they wrap the whole answer", () => {
    expect(parseRelationExplanation("'n1 supports n2.'")).toBe("n1 supports n2.");
    expect(parseRelationExplanation("«n1 supports n2.»")).toBe("n1 supports n2.");
    expect(parseRelationExplanation("`n1 supports n2.`")).toBe("n1 supports n2.");
    // An apostrophe inside a word is not a quote.
    expect(parseRelationExplanation("'n1 doesn't support n2.'")).toBe("n1 doesn't support n2.");
    // Quoted phrases at both ends are content, not a wrapper.
    for (const text of [
      '"Yes" n1 says "yes" to n2.',
      "“Yes” n1 says “yes” to n2.",
      '"n1 supports n2.',
      'n1 supports "n2".'
    ])
      expect(parseRelationExplanation(text)).toBe(text);
  });

  it("turns the aliases into canonical references, and only the backend does", () => {
    expect(
      resolveRelationExplanationReferences("n1 extends n2, as n1 shows.", {
        first: ids.a,
        second: ids.b
      })
    ).toBe(
      `<note-ref id="${ids.a}" /> extends <note-ref id="${ids.b}" />, as <note-ref id="${ids.a}" /> shows.`
    );
  });
});

describe("relation explanation references", () => {
  const resolve = (text: string) =>
    resolveRelationExplanationReferences(text, { first: ids.a, second: ids.b });
  const ref = (id: string) => `<note-ref id="${id}" />`;

  it("resolves the exact aliases n1 and n2 standing alone, whatever punctuation follows", () => {
    expect(resolve("n1, n2.")).toBe(`${ref(ids.a)}, ${ref(ids.b)}.`);
    expect(resolve("(n1) and n2's claim; n1-n2")).toBe(
      `(${ref(ids.a)}) and ${ref(ids.b)}'s claim; ${ref(ids.a)}-${ref(ids.b)}`
    );
  });

  it("leaves every other token as content", () => {
    for (const text of [
      "N400 and N95 masks",
      "N1 supports N2.",
      "n3 fatty acids and n12",
      "an1 and n1x and n1_to_n2",
      "version n1.5 and range n2-3"
    ])
      expect(resolve(text)).toBe(text);
  });
});

describe("relation explanation length", () => {
  const stored = { first: ids.a, second: ids.b };
  /** `count` aliases and filler: the longest answer the model may write in its own terms. */
  const aliases = (count: number) => {
    const joined = Array<string>(count).fill("n1").join(" ");
    return `${joined} ${"x".repeat(relationExplanationLimits.modelCharacters - joined.length - 1)}`;
  };

  it("validates the length after the aliases became references, against the stored bound", () => {
    const tooMany = aliases(72);
    expect(tooMany).toHaveLength(relationExplanationLimits.modelCharacters);
    // It passes the model's own limit, and would break the 4000-character check at the insert.
    expect(parseRelationExplanation(tooMany)).toBe(tooMany);
    expect(acceptRelationExplanation(tooMany, stored)).toBeNull();
    expect(acceptRelationExplanation(Array(100).fill("n1").join(" "), stored)).toBeNull();
    const longest = acceptRelationExplanation(aliases(71), stored);
    expect(longest).not.toBeNull();
    expect(longest!.length).toBeLessThanOrEqual(relationExplanationLimits.storedCharacters);
  });

  it("accepts an ordinary answer resolved, and refuses what the parser refuses", () => {
    expect(acceptRelationExplanation("n1 qualifies n2.", stored)).toBe(
      `<note-ref id="${ids.a}" /> qualifies <note-ref id="${ids.b}" />.`
    );
    expect(acceptRelationExplanation("n1 supports <b>n2</b>.", stored)).toBeNull();
    expect(acceptRelationExplanation(null, stored)).toBeNull();
  });
});
