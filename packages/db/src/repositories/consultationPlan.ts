/**
 * Reading an `EXPLAIN (VERBOSE, FORMAT JSON)` plan of the candidates statement of Ask (F4 T79, D22),
 * for the plan-shape guard, `db:ask-text:verify` and the measurement of `scripts/ask`: which
 * expressions still parse the text of a passage or a note, and which scans run once per statement
 * (in a CTE of their own) or again for every row (in a SubPlan). Pure: it reads a plan and no table.
 */

/** One node of an `EXPLAIN (FORMAT JSON)` plan; verbose plans carry the expressions as strings. */
export interface PlanNode {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Subplan Name"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Alias?: string;
  Output?: string[];
  Plans?: PlanNode[];
  [field: string]: unknown;
}

/** Every node of a plan with the nodes above it, outermost first. */
export function planNodes(
  node: PlanNode,
  above: PlanNode[] = []
): { node: PlanNode; above: PlanNode[] }[] {
  return [
    { node, above },
    ...(node.Plans ?? []).flatMap((child) => planNodes(child, [...above, node]))
  ];
}

/** The plan runs this node once, as a CTE, whatever the number of rows that read it. */
export const isCteNode = (node: PlanNode): boolean =>
  node["Parent Relationship"] === "InitPlan" && node["Subplan Name"]?.startsWith("CTE ") === true;

/** The plan runs this node again for every row of the node that holds it. */
export const isPerRowNode = (node: PlanNode): boolean => node["Parent Relationship"] === "SubPlan";

/** Where a scan of `relation` runs: the CTE that holds it, and whether a SubPlan sits in between. */
export function scanPlacements(
  root: PlanNode,
  relation: string,
  alias?: string
): { cte: string | undefined; inSubPlan: boolean; index: string | undefined }[] {
  return planNodes(root)
    .filter(
      ({ node }) =>
        node["Relation Name"] === relation && (alias === undefined || node.Alias === alias)
    )
    .map(({ node, above }) => {
      const chain = [...above, node];
      return {
        cte: chain.toReversed().find(isCteNode)?.["Subplan Name"],
        inSubPlan: chain.some(isPerRowNode),
        index: node["Index Name"]
      };
    });
}

/** Every string of the plan that holds an expression (Output, Filter, Index Cond and so on). */
export function planExpressions(root: PlanNode): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      if (key !== "Node Type" && key !== "Relation Name" && key !== "Alias") found.push(value);
    } else if (Array.isArray(value)) for (const item of value) visit(item, key);
  };
  for (const { node } of planNodes(root))
    for (const [key, value] of Object.entries(node)) if (key !== "Plans") visit(value, key);
  return found;
}

/** The argument text of every `to_tsvector(` call in an expression (balanced parentheses). */
export function tsvectorCalls(expression: string): string[] {
  const calls: string[] = [];
  for (const match of expression.matchAll(/to_tsvector\(/gu)) {
    let depth = 1;
    let quoted = false;
    let end = match.index + match[0].length;
    for (; end < expression.length && depth > 0; end += 1) {
      const character = expression[end];
      if (character === "'") quoted = !quoted;
      else if (!quoted && character === "(") depth += 1;
      else if (!quoted && character === ")") depth -= 1;
    }
    calls.push(expression.slice(match.index + match[0].length, end - 1));
  }
  return calls;
}

/** The text a stored vector now holds for the statement: a passage's content or a note's idea and body. */
const contentColumn = /\b(?:content|body_markdown|idea_statement)\b/u;

/**
 * The `to_tsvector(` calls of the plan that parse the text of a passage or a note, which the
 * statement must not make: it reads `chunks.search_tsv` and `atomic_notes.ask_tsv` instead. The
 * titles, entity names and concepts it still parses are small and computed once per statement.
 */
export function contentTsvectorCalls(root: PlanNode): string[] {
  return planExpressions(root)
    .flatMap(tsvectorCalls)
    .filter((call) => contentColumn.test(call));
}

/**
 * Whether a scan of `chunks` outputs `search_tsv` and a scan of `atomic_notes` outputs `ask_tsv`: the
 * statement reads the stored vectors. The notes' other vector (`atomic_notes.search_tsv`, 0058) shows
 * in plans that read other things, so only the scan of the table that owns each column counts.
 */
export function storedVectorReads(root: PlanNode): { passages: boolean; notes: boolean } {
  const outputs = (relation: string, column: string) =>
    planNodes(root).some(
      ({ node }) =>
        node["Relation Name"] === relation &&
        (node.Output ?? []).some((expression) => expression.endsWith(`.${column}`))
    );
  return {
    passages: outputs("chunks", "search_tsv"),
    notes: outputs("atomic_notes", "ask_tsv")
  };
}
