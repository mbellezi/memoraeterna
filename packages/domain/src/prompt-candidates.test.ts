import { describe, expect, it } from "vitest";

import { renderPromptTemplate } from "./prompt-catalog.js";
import { candidatePromptBodies } from "./prompt-defaults.js";
import { promptCandidate, promptCandidates, promptDefinition } from "./prompt-definitions.js";

describe("candidate revisions (plan decision 29)", () => {
  const shipped = promptDefinition("relations.type");
  const shippedBody = shipped.fields.find((field) => field.id === "body")!.template;
  const strict = promptCandidate("relations.type", "candidate-strict-related");

  it("are never the default and an unknown one is refused", () => {
    expect(promptCandidates.map(({ id, revisionId }) => [id, revisionId])).toEqual(
      candidatePromptBodies.map(({ id, revisionId }) => [id, revisionId])
    );
    expect(strict.fields.body).not.toBe(shippedBody);
    expect(shipped.defaultVersion).toBe("1");
    expect(() => promptCandidate("relations.type", "candidate-missing")).toThrow(
      "prompts.errors.unknown"
    );
    expect(() => promptCandidate("relations.explain", "candidate-strict-related")).toThrow(
      "prompts.errors.unknown"
    );
  });

  it("keep the typer's shipped lines and add only the panel's strict related criterion", () => {
    const candidateLines = new Set(strict.fields.body.split("\n"));
    const changed = shippedBody.split("\n").filter((line) => !candidateLines.has(line));
    // The `none` line is the only shipped line the candidate rewrites.
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatch(/^- none: the notes are not related in any of these ways\./u);
    expect(strict.fields.body).toContain(
      "one note makes a claim about the same mechanism, rule or phenomenon as the other, supported by both texts"
    );
    expect(strict.fields.body).toContain(
      "Shared names, topics, places or dates, similar vocabulary, or being about the same broad subject are not enough"
    );
    expect(strict.fields.body).toContain("- none: the notes are not related by the test above.");
  });

  it("render with the prompt's own variables and output contract, from content only", () => {
    const contract = shipped.fields.find((field) => field.id === "output_contract")!.template;
    const rendered = renderPromptTemplate(
      strict.fields.body,
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
  });
});
