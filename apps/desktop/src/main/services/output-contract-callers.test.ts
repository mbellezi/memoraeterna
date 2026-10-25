import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  constantValues,
  productFiles,
  sourceOf,
  statedContext,
  stringValues
} from "./workload-class-sites.js";

/**
 * F4 D23: every caller of a structured answer states its output contract in the call's context, so
 * the AI service can derive the schema each runtime is sent (strict for a remote adapter, a grammar
 * for a runtime that takes a schema). Read from the source: a catalog call added or renamed without
 * its contract fails here, and so does a contract whose caller disappeared.
 *
 * The calls are found by the operation they state in a context that also states the prompt version
 * (a route lookup states an operation too, and calls nothing). Contexts that name no operation of
 * their own (the overview's repair spreads the first ask's) inherit the contract with the rest.
 */
const files = productFiles();
const constants = constantValues(files);

/** The operations of the catalog's callers, with the contract each one answers (the contract's name). */
const catalogOperations: ReadonlyArray<{ operation: string; contract: string; caller: string }> = [
  {
    operation: "relation_typing",
    contract: "relation_typing",
    caller: "relations/relation-typing.ts"
  },
  {
    operation: "relation_typing_repair",
    contract: "relation_typing",
    caller: "relations/relation-typing.ts"
  },
  { operation: "topic_name", contract: "topic_naming", caller: "topic-tree/topic-naming.ts" },
  { operation: "topic_areas", contract: "topic_areas", caller: "topic-tree/topic-areas.ts" },
  {
    operation: "topic_overview",
    contract: "topic_overview",
    caller: "topic-tree/topic-overview.ts"
  },
  { operation: "graph_*", contract: "knowledge_graph", caller: "knowledge-processing.ts" },
  { operation: "graph_*_repair", contract: "knowledge_graph", caller: "knowledge-processing.ts" },
  {
    operation: "atomic_note_generation",
    contract: "atomic_notes",
    caller: "knowledge-processing.ts"
  },
  { operation: "atomic_note_repair", contract: "atomic_notes", caller: "knowledge-processing.ts" },
  {
    operation: "entity_identity_resolution",
    contract: "entity_identity",
    caller: "relation-type-resolution.ts"
  },
  {
    operation: "relation_type_resolution",
    contract: "relation_identity",
    caller: "relation-type-resolution.ts"
  },
  // Stated for remote runtimes only since the owner's 10-25 decision (strict terms, no grammar).
  {
    operation: "wiki-consultation",
    contract: "consultation_answer",
    caller: "consultation-service.ts"
  },
  {
    operation: "source_relation_matching",
    contract: "source_judge",
    caller: "source-relation-processing.ts"
  }
];
const operationNames = new Set(catalogOperations.map((entry) => entry.operation));

interface Statement {
  file: string;
  line: number;
  operations: string[];
  /** The object literal that states the operation also states `outputContract`. */
  statesContract: boolean;
  /** The text of the `outputContract` value, when stated. */
  contractValue: string | null;
}

/** Every object literal of the product code that states a catalog operation. */
function catalogStatements(): Statement[] {
  const found: Statement[] = [];
  for (const file of files) {
    const source = sourceOf(file);
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "operation" &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const values = stringValues(node.initializer, constants) ?? [];
        const operations = values.filter((value) => operationNames.has(value));
        const isCallContext = statedContext(node.parent, constants).properties.has("promptVersion");
        if (operations.length > 0 && isCallContext) {
          const contract = node.parent.properties.find(
            (property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              property.name.text === "outputContract"
          );
          found.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
            operations,
            statesContract: statedContext(node.parent, constants).properties.has("outputContract"),
            contractValue: contract ? contract.initializer.getText(source) : null
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

const statements = catalogStatements();

describe("the callers of the structured-output catalog state their contract (D23)", () => {
  it("finds every catalog operation in the product code", () => {
    const seen = new Set(statements.flatMap((statement) => statement.operations));
    expect([...operationNames].filter((operation) => !seen.has(operation))).toEqual([]);
  });

  it("finds each operation in the file that owns its caller", () => {
    const misplaced = catalogOperations.filter(
      (entry) =>
        !statements.some(
          (statement) =>
            statement.operations.includes(entry.operation) && statement.file.endsWith(entry.caller)
        )
    );
    expect(misplaced).toEqual([]);
  });

  it("states outputContract wherever a catalog operation is stated", () => {
    const missing = statements
      .filter((statement) => !statement.statesContract)
      .map((statement) => `${statement.file}:${statement.line} ${statement.operations.join(", ")}`);
    expect(missing).toEqual([]);
  });

  it("states a contract the caller owns, never an inline schema", () => {
    // A name or a member of a module: the contract lives beside its prompt and its validation.
    const inline = statements.filter(
      (statement) => statement.contractValue && /^(\{|z\.)/u.test(statement.contractValue)
    );
    expect(inline.map((statement) => `${statement.file}:${statement.line}`)).toEqual([]);
  });

  it("states no wire schema of its own in a call's limits or context", () => {
    // `outputSchema` belongs to the AI service (derived per runtime) and to the DEV probe.
    const stated: string[] = [];
    for (const file of files) {
      if (file.endsWith("/ai-service.ts") || file.endsWith("/schema-probe.ts")) continue;
      const source = sourceOf(file);
      const visit = (node: ts.Node) => {
        if (
          (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "outputSchema" &&
          ts.isObjectLiteralExpression(node.parent)
        )
          stated.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(stated).toEqual([]);
  });
});
