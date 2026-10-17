import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

/**
 * Static reading of the product code for the tests that guard the workload classes (F3 D34): which
 * calls reach the AI service, what class and priority each states, and which operations exist. It
 * is not product code; only the two static tests import it.
 */

export const workspaceRoot = resolve(import.meta.dirname, "../../../../..");

/** Product sources of the main process: not tests, not the proof scripts that run real models. */
export function productFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\0")
    .filter(
      (file) =>
        /^apps\/desktop\/src\/main\/.*\.ts$/u.test(file) &&
        !/\.test\.ts$/u.test(file) &&
        !/\/verify-[^/]*\.ts$/u.test(file) &&
        !/\/workload-class-sites\.ts$/u.test(file)
    )
    .sort();
}

export function sourceOf(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(resolve(workspaceRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

/** Methods that run an AI call, with the position of the argument that holds the call's context. */
export const callMethods = {
  runDefaultTask: { context: 2 },
  tryRunDefaultTask: { context: 3 },
  runOrganizationTask: { context: 2 },
  rank: { context: 0 },
  rankPairs: { context: 0 },
  embedMany: { context: 1 }
} as const;
export type CallMethod = keyof typeof callMethods;

const rankReceivers = new Set(["ai", "aiService", "service"]);
const sourceItemHelpers = new Set(["withAiSourceItems", "withSourceItems"]);

export interface StatedContext {
  /** Names of the properties the context states, spreads that resolve included. */
  properties: Set<string>;
  /** String values of the properties that are string literals (or conditionals of them). */
  values: Map<string, string[]>;
  /** A spread or a value the reading could not follow. */
  unresolved: boolean;
}

export interface CallSite {
  file: string;
  line: number;
  method: CallMethod;
  /** The task type of `runDefaultTask`, when it is a literal. */
  task: string | null;
  /** The enclosing function or method, for the allowlist of pass-through wrappers. */
  enclosing: string;
  context: StatedContext | null;
}

/** Top-level `const NAME = "literal"` and `const NAME = { key: "literal" } as const` of a file set. */
export function constantValues(
  files: readonly string[]
): Map<string, string | Map<string, string>> {
  const values = new Map<string, string | Map<string, string>>();
  for (const file of files) {
    for (const statement of sourceOf(file).statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initializer = stripWrappers(declaration.initializer);
        if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
          values.set(declaration.name.text, initializer.text);
        else if (ts.isObjectLiteralExpression(initializer)) {
          const members = new Map<string, string>();
          for (const property of initializer.properties)
            if (
              ts.isPropertyAssignment(property) &&
              ts.isIdentifier(property.name) &&
              (ts.isStringLiteral(property.initializer) ||
                ts.isNoSubstitutionTemplateLiteral(property.initializer))
            )
              members.set(property.name.text, property.initializer.text);
          if (members.size > 0) values.set(declaration.name.text, members);
        }
      }
    }
  }
  return values;
}

function stripWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

/**
 * The string values an expression can take: literals, a template (its substitutions become `*`),
 * a known constant, a member of a known constant object, or either branch of a conditional.
 */
export function stringValues(
  expression: ts.Expression,
  constants: ReadonlyMap<string, string | Map<string, string>>
): string[] | null {
  const node = stripWrappers(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node))
    return [node.head.text + node.templateSpans.map((span) => `*${span.literal.text}`).join("")];
  if (ts.isIdentifier(node)) {
    const value = constants.get(node.text);
    return typeof value === "string" ? [value] : null;
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ts.isIdentifier(node.name)
  ) {
    const object = constants.get(node.expression.text);
    const value = object instanceof Map ? object.get(node.name.text) : undefined;
    return value === undefined ? null : [value];
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = stringValues(node.whenTrue, constants);
    const whenFalse = stringValues(node.whenFalse, constants);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  return null;
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/** Follows an identifier to the object literal a `const` of the same function or file gives it. */
function declarationOf(
  identifier: ts.Identifier,
  from: ts.Node
): ts.Expression | "parameter" | null {
  let scope: ts.Node | undefined = from;
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      const statements = ts.isBlock(scope) ? scope.statements : scope.statements;
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations)
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === identifier.text &&
            declaration.initializer
          )
            return declaration.initializer;
      }
    }
    if (
      (ts.isFunctionLike(scope) || ts.isArrowFunction(scope)) &&
      scope.parameters.some(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text
      )
    )
      return "parameter";
    scope = scope.parent;
  }
  return null;
}

export function statedContext(
  expression: ts.Expression | undefined,
  constants: ReadonlyMap<string, string | Map<string, string>>,
  depth = 0
): StatedContext {
  const result: StatedContext = { properties: new Set(), values: new Map(), unresolved: false };
  if (!expression || depth > 4) {
    result.unresolved = true;
    return result;
  }
  const node = stripWrappers(expression);
  const merge = (other: StatedContext) => {
    for (const property of other.properties) result.properties.add(property);
    for (const [key, values] of other.values) result.values.set(key, values);
    if (other.unresolved) result.unresolved = true;
  };
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isSpreadAssignment(property)) {
        merge(statedContext(property.expression, constants, depth + 1));
        continue;
      }
      const name = property.name ? propertyName(property.name) : null;
      if (!name) continue;
      result.properties.add(name);
      if (ts.isPropertyAssignment(property)) {
        const values = stringValues(property.initializer, constants);
        if (values) result.values.set(name, values);
      }
    }
    return result;
  }
  if (ts.isIdentifier(node)) {
    const declared = declarationOf(node, node);
    if (declared === null || declared === "parameter") {
      result.unresolved = true;
      return result;
    }
    merge(statedContext(declared, constants, depth + 1));
    return result;
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    // A helper that adds source IDs to a context and returns the same context (the knowledge
    // service's and the relation matcher's).
    if (sourceItemHelpers.has(node.expression.text) && node.arguments[0]) {
      merge(statedContext(node.arguments[0], constants, depth + 1));
      return result;
    }
  }
  result.unresolved = true;
  return result;
}

function enclosingName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name)
      return ts.isIdentifier(current.name) ? current.name.text : "";
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer &&
      (ts.isArrowFunction(current.initializer) || ts.isFunctionExpression(current.initializer))
    )
      return current.name.text;
  }
  return "";
}

/** Every call of the AI service that runs a task, in the product files. */
export function callSites(
  files: readonly string[],
  constants: ReadonlyMap<string, string | Map<string, string>>
): CallSite[] {
  const sites: CallSite[] = [];
  for (const file of files) {
    const source = sourceOf(file);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (Object.hasOwn(callMethods, method)) {
          const receiver = node.expression.expression;
          const receiverName = ts.isPropertyAccessExpression(receiver)
            ? receiver.name.text
            : ts.isIdentifier(receiver)
              ? receiver.text
              : "";
          // `rank`, `rankPairs` and `embedMany` are common names (an adapter has the last): only the
          // AI service's own receivers count.
          const watched =
            (method !== "rank" && method !== "rankPairs" && method !== "embedMany") ||
            rankReceivers.has(receiverName);
          if (watched) {
            const argument = node.arguments[callMethods[method as CallMethod].context];
            const first = node.arguments[0];
            sites.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              method: method as CallMethod,
              task:
                method === "runDefaultTask" && first && ts.isStringLiteralLike(first)
                  ? first.text
                  : null,
              enclosing: enclosingName(node),
              context: statedContext(argument, constants)
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

/** Every `operation:` the product code states, with the values it can take (null: not followed). */
export function operationStatements(
  files: readonly string[],
  constants: ReadonlyMap<string, string | Map<string, string>>
): Array<{ file: string; line: number; values: string[] | null }> {
  const found: Array<{ file: string; line: number; values: string[] | null }> = [];
  for (const file of files) {
    const source = sourceOf(file);
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "operation" &&
        !ts.isTypeLiteralNode(node.parent)
      )
        found.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          values: stringValues(node.initializer, constants)
        });
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
