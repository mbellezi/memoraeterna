import { describe, expect, it } from "vitest";

import { renderPromptTemplate } from "./prompt-catalog.js";
import { candidatePromptBodies } from "./prompt-defaults.js";
import { promptCandidate, promptCandidates, promptDefinition } from "./prompt-definitions.js";

describe("the typer's revisions (plan decision 29)", () => {
  const shipped = promptDefinition("relations.type");
  const shippedBody = shipped.fields.find((field) => field.id === "body")!.template;
  const previous = promptCandidate("relations.type", "candidate-shipped-1");

  it("ship revision 2 with the panel's strict relatedness question", () => {
    expect(shipped.defaultVersion).toBe("2");
    expect(shippedBody).toContain(
      "one note makes a claim about the same mechanism, rule or phenomenon as the other, supported by both texts"
    );
    expect(shippedBody).toContain(
      "Shared names, topics, places or dates, similar vocabulary, or being about the same broad subject are not enough"
    );
    expect(shippedBody).toContain("- none: the notes are not related by the test above.");
  });

  it("keep revision 1 as a candidate that differs only by the relatedness test", () => {
    const shippedLines = new Set(shippedBody.split("\n"));
    const previousLines = previous.fields.body.split("\n");
    // Revision 1 drops the test paragraph (and the blank line after it) and has its own `none` line.
    expect(previousLines.filter((line) => !shippedLines.has(line))).toEqual([
      expect.stringMatching(/^- none: the notes are not related in any of these ways\./u)
    ]);
    const removed = shippedBody.split("\n").filter((line) => !previousLines.includes(line));
    expect(removed).toHaveLength(2);
    expect(removed[0]).toMatch(/^First decide whether the two notes are related:/u);
    expect(removed[1]).toMatch(/^- none: the notes are not related by the test above\./u);
  });

  it("are never the default and an unknown one is refused", () => {
    expect(promptCandidates.map(({ id, revisionId }) => [id, revisionId])).toEqual(
      candidatePromptBodies.map(({ id, revisionId }) => [id, revisionId])
    );
    expect(previous.fields.body).not.toBe(shippedBody);
    expect(() => promptCandidate("relations.type", "candidate-strict-related")).toThrow(
      "prompts.errors.unknown"
    );
    expect(() => promptCandidate("relations.explain", "candidate-shipped-1")).toThrow(
      "prompts.errors.unknown"
    );
  });

  it("render with the prompt's own variables and output contract, from content only", () => {
    const contract = shipped.fields.find((field) => field.id === "output_contract")!.template;
    for (const body of [shippedBody, previous.fields.body]) {
      const rendered = renderPromptTemplate(
        body,
        shipped.variables,
        {
          relation_pairs: [{ p: "p1", a: "Title: A\nIdea: one", b: "Title: B\nIdea: two" }],
          output_contract: contract
        },
        ["output_contract"]
      );
      expect(rendered).toContain(contract);
      expect(rendered).toContain('"p":"p1"');
      expect(rendered).not.toMatch(/%[a-z_]+%/u);
    }
  });
});
