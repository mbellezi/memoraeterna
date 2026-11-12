import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchingValueControlIds,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  defaultKnowledgeControls
} from "@app/domain";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  appSettingsSchema,
  defaultAppSettings,
  defaultStorageSettings,
  storageSettingsSchema
} from "../shared/ipc";
import {
  persistedStateRegistry,
  resetAdapterIds,
  retiredSettingKeys,
  settingSlug,
  settingsRegistryV2,
  settingsSectionIds,
  visibleAutomationEntries,
  type DefaultRef,
  type PersistedStateEntry,
  type SettingEntryV2,
  type StoreRef
} from "../shared/settings-registry";

// The settings registry v2 (F5 T159, D17), checked statically. Every persisted setting has an
// entry; each entry's reader is a symbol whose body reads the key (part 1), in a file that is not a
// schema, a test, a fixture or tooling (part 2), that an app entry point reaches through imports
// (part 3). A setting no code reads is removed, so a retired key is read by nothing.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const diskSource: Source = {
  read: (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null)
};
const read = (path: string) => readFileSync(join(root, path), "utf8");
const word = (needle: string) => new RegExp(`(?<![A-Za-z0-9_])${needle}(?![A-Za-z0-9_])`, "u");

/** The files the checker reads: a path relative to the repository root gives its text or null. */
interface Source {
  read(path: string): string | null;
}

// --- the checker ---------------------------------------------------------------------------------

/** The entry points of the application's three processes (the reachability roots). */
const entryPoints = [
  "apps/desktop/src/main/index.ts",
  "apps/desktop/src/renderer/main.tsx",
  "apps/desktop/src/preload/index.ts"
];

/**
 * A reader may not be a schema, a test, a fixture, a script, the tooling that pins a value, the
 * settings writer, the reset or the Settings screen (D17): a file that touches every key says
 * nothing about whether the product reads one.
 */
const denyList: readonly RegExp[] = [
  /\.(test|spec)\.tsx?$/u,
  /\.d\.ts$/u,
  /(^|\/)(__fixtures__|__tests__|fixtures|scripts|e2e)\//u,
  /(^|\/)verify-[^/]*$/u,
  /(^|\/)(golden|matching-benchmark|matching-pilot)[^/]*$/u,
  /(^|\/)services\/dev\//u,
  // The registry and the schemas of the shared IPC: `ipc.ts` and the area files `ipc-<area>.ts` (D30).
  /^apps\/desktop\/src\/shared\/(ipc|settings-registry)(-[^/]*)?\.ts$/u,
  // The settings writer and the reset (T160).
  /^apps\/desktop\/src\/main\/services\/settings-service\.ts$/u,
  /(^|\/)settings-reset[^/]*$/u,
  // The Settings screen: v2 (`R/settings/**`, T161) and the v1 components it replaces (T166).
  /^apps\/desktop\/src\/renderer\/(components\/)?settings\//u,
  /\.(json|md)$/u
];
const denied = (file: string) => denyList.some((pattern) => pattern.test(file));

/**
 * The entries whose reader is a denied file, each with the proof that the product reads the value
 * anyway. `import.lastDirectory` is read by the writer's own getter, which `M/ipc.ts` calls to open
 * the import dialog where the person last was; the test below pins that call.
 */
const deniedReaderExceptions: Readonly<
  Record<string, { file: string; consumer: { file: string; text: string } }>
> = {
  "import.lastDirectory": {
    file: "apps/desktop/src/main/services/settings-service.ts",
    consumer: { file: "apps/desktop/src/main/ipc.ts", text: "settingsService.getImportDirectory()" }
  }
};

/**
 * Entries D17 would call unread, named instead of passed (X11). Removing a setting, or its feature,
 * is the owner's call, so the test lists each with why. It fails when one gains a reader, and the
 * entry then leaves this list.
 */
const knownUnread: Readonly<Record<string, string>> = {
  // The saved matching presets and the selected one only draw the preset selector (Q4) and are
  // re-derived by the settings loader; no other code reads them.
  activeMatchingPresetId: "read only by the Settings screen and the settings loader",
  // `clearCompletedOrFailed` records the cutoff; the one SQL that would read it back,
  // `taskHistoryVisibleSql`, has no caller (the jobs carry `dashboardDismissedAt` instead).
  "jobs.history.dismissed-through.v1":
    "written by the Clear action, read by a function nothing calls"
};

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** The declaration a reader symbol names: a function, a const, a class, `Class.member`, or the module. */
function findSymbol(file: ts.SourceFile, symbol: string): ts.Node | null {
  if (symbol === "<module>") return file;
  const [name, member] = symbol.split(".") as [string, string | undefined];
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && !member)
      return statement;
    if (ts.isVariableStatement(statement) && !member) {
      const declaration = statement.declarationList.declarations.find(
        (candidate) => candidate.name.getText(file) === name
      );
      if (declaration) return declaration;
    }
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      if (!member) return statement;
      const found = statement.members.find((candidate) => candidate.name?.getText(file) === member);
      if (found) return found;
    }
  }
  return null;
}

/** A constant a key can be spelled by: `const NAME = "text"`, `= ["a", "b"]`, `= A`, `= { prop: "text" }`. */
function constantValues(sources: Source, files: readonly string[]): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  const aliases: Array<[string, string]> = [];
  const add = (name: string, value: string) =>
    values.set(name, (values.get(name) ?? new Set<string>()).add(value));
  const unwrap = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    )
      current = current.expression;
    return current;
  };
  for (const file of files) {
    const text = sources.read(file);
    if (!text || !/\bconst\b/u.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const name = declaration.name.text;
        const initializer = unwrap(declaration.initializer);
        if (ts.isStringLiteralLike(initializer)) add(name, initializer.text);
        else if (ts.isIdentifier(initializer)) aliases.push([name, initializer.text]);
        else if (ts.isArrayLiteralExpression(initializer)) {
          for (const item of initializer.elements)
            if (ts.isStringLiteralLike(item)) add(name, item.text);
        } else if (ts.isObjectLiteralExpression(initializer)) {
          for (const property of initializer.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
            const value = unwrap(property.initializer);
            if (ts.isStringLiteralLike(value)) add(`${name}.${property.name.text}`, value.text);
          }
        }
      }
    }
  }
  for (const [name, alias] of aliases)
    for (const value of values.get(alias) ?? []) add(name, value);
  return values;
}

/** The ways a key is spelled in code, by where it is stored. */
function spellings(
  store: StoreRef["kind"],
  key: string
): { accessors: string[]; literals: string[]; builders: string[] } {
  const last = key.split(/[.:]/u).at(-1)!;
  if (key.startsWith("knowledge.controls.v1."))
    return { accessors: [last], literals: [], builders: [] };
  switch (store) {
    case "app.preferences":
    case "storage_settings":
      return { accessors: [last], literals: [last], builders: [] };
    case "route":
      // A task route is looked up by the key a builder spells: `class:<class>` or an operation.
      return {
        accessors: [],
        literals: [key, last],
        builders: [key.startsWith("class:") ? "workloadClassRouteKey" : "operationRouteKey"]
      };
    case "credential":
      return { accessors: [last], literals: [key, last], builders: [] };
    default:
      return { accessors: [], literals: [key], builders: [] };
  }
}

/** A call that writes (`set`, `save`, `delete`...) does not read what it is given. */
const writeVerb =
  /^(set|put|write|save|store|delete|remove|upsert|update|insert|assign|clear|reset)/iu;

function calleeName(call: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression) {
  const callee = ts.isTaggedTemplateExpression(call) ? call.tag : call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return ts.isIdentifier(callee) ? callee.text : "";
}

/** The node is the target of an assignment, a `delete` or an increment: it is written, not read. */
function isWritten(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && parent.left === node)
    return (
      parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    );
  if (ts.isDeleteExpression(parent)) return true;
  return (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

/**
 * A key spelled as a value sits where it is read when it ends up as an argument of a call that does
 * not write (`repository.get(KEY)`, `query("... 'key' ...")`, `read({ key })`) or as an index
 * (`settings["themeMode"]`). A declaration's initializer, a comparison, a return value and a type
 * are not reads.
 */
function inReadPosition(node: ts.Node): boolean {
  let child = node;
  for (;;) {
    const parent = child.parent;
    if (!parent) return false;
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent))
      return parent.expression !== child && !writeVerb.test(calleeName(parent));
    if (ts.isTaggedTemplateExpression(parent))
      return parent.template === child && !writeVerb.test(calleeName(parent));
    if (ts.isElementAccessExpression(parent))
      return parent.argumentExpression === child && !isWritten(parent);
    const passes =
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isTemplateExpression(parent) ||
      ts.isTemplateSpan(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isShorthandPropertyAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === child) ||
      (ts.isConditionalExpression(parent) && parent.condition !== child) ||
      (ts.isBinaryExpression(parent) &&
        [
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken
        ].includes(parent.operatorToken.kind));
    if (!passes) return false;
    child = parent;
  }
}

/**
 * Whether the declaration reads `key` (D17 part 1): a property access of its last segment on the
 * loaded object (not an assignment target), a destructured binding of it, or its spelling (a
 * literal, or a constant that holds it) in a read position. A declaration, a comparison, a write or
 * a type that only mentions the key does not read it.
 */
function readsKey(
  declaration: ts.Node,
  store: StoreRef["kind"],
  key: string,
  constants: Map<string, Set<string>>
): boolean {
  const { accessors, literals, builders } = spellings(store, key);
  const spelled = (text: string) =>
    literals.some(
      (literal) =>
        text === literal ||
        // A key family (`obsidian.layout.presence.<client>`) is spelled by its prefix.
        text.startsWith(`${key}.`) ||
        // A key spelled inside a SQL statement.
        (store === "settings" && text.includes(`'${key}'`))
    );
  const heldBy = (name: string) => [...(constants.get(name) ?? [])].some(spelled);
  // A local that holds the key (`const settingKey = options.settingKey ?? KEY`) is the key too.
  const aliases = new Set<string>();
  const carries = (node: ts.Expression): boolean => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return carries(node.expression);
    if (ts.isBinaryExpression(node)) return carries(node.left) || carries(node.right);
    if (ts.isConditionalExpression(node)) return carries(node.whenTrue) || carries(node.whenFalse);
    if (ts.isStringLiteralLike(node)) return spelled(node.text);
    if (ts.isIdentifier(node)) return aliases.has(node.text) || heldBy(node.text);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
      return heldBy(`${node.expression.text}.${node.name.text}`);
    return false;
  };
  for (let pass = 0; pass < 2; pass += 1) {
    const collect = (current: ts.Node): void => {
      if (
        ts.isVariableDeclaration(current) &&
        ts.isIdentifier(current.name) &&
        current.initializer &&
        carries(current.initializer)
      )
        aliases.add(current.name.text);
      ts.forEachChild(current, collect);
    };
    collect(declaration);
  }
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(current)) {
      if (accessors.includes(current.name.text) && !isWritten(current)) found = true;
      else if (
        ts.isIdentifier(current.expression) &&
        heldBy(`${current.expression.text}.${current.name.text}`) &&
        inReadPosition(current)
      )
        found = true;
    } else if (ts.isBindingElement(current)) {
      const name = current.propertyName ?? current.name;
      if (ts.isIdentifier(name) && accessors.includes(name.text)) found = true;
    } else if (ts.isStringLiteralLike(current) || ts.isTemplateHead(current)) {
      if (spelled(current.text) && inReadPosition(current)) found = true;
    } else if (ts.isIdentifier(current)) {
      if ((aliases.has(current.text) || heldBy(current.text)) && inReadPosition(current))
        found = true;
    } else if (ts.isCallExpression(current)) {
      if (builders.includes(calleeName(current)) && inReadPosition(current)) found = true;
    }
    ts.forEachChild(current, visit);
  };
  visit(declaration);
  return found;
}

/** The files an import specifier can mean, from the importing file. */
function resolveImport(sources: Source, from: string, specifier: string): string | null {
  let target: string;
  if (specifier.startsWith(".")) target = join(dirname(from), specifier);
  else if (specifier.startsWith("@app/")) {
    const [, pkg, ...rest] = specifier.split("/");
    target = `packages/${pkg}/src${rest.length ? `/${rest.join("/")}` : ""}`;
  } else return null;
  target = target.replace(/\\/gu, "/");
  const stem = target.replace(/\.(js|jsx)$/u, "");
  for (const candidate of [
    `${stem}.ts`,
    `${stem}.tsx`,
    target,
    `${stem}/index.ts`,
    `${stem}/index.tsx`
  ])
    if (/\.(ts|tsx)$/u.test(candidate) && sources.read(candidate) !== null) return candidate;
  return null;
}

/** Runtime imports of a file: type-only imports do not make a file reachable. */
function importsOf(text: string): string[] {
  const runtime = text.replace(/\b(?:import|export)\s+type\b[^;]*?\bfrom\s*["'][^"']+["']/gu, "");
  const found = new Set<string>();
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
    /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/gu
  ])
    for (const match of runtime.matchAll(pattern)) found.add(match[1]!);
  return [...found];
}

function reachableFiles(sources: Source, roots: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = roots.filter((file) => sources.read(file) !== null);
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(sources.read(file)!)) {
      const target = resolveImport(sources, file, specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/** The three parts of D17's reader test; returns what is wrong, or nothing. */
function checkReader(
  sources: Source,
  roots: readonly string[],
  reach: Set<string>,
  constants: Map<string, Set<string>>,
  reader: { file: string; symbol: string },
  store: StoreRef
): string[] {
  const problems: string[] = [];
  if (denied(reader.file))
    problems.push(
      `${reader.file} is on the reader deny-list (schema, test, fixture, tooling, writer, reset or Settings screen)`
    );
  const text = sources.read(reader.file);
  if (text === null) return [...problems, `${reader.file} does not exist`];
  if (!reach.has(reader.file))
    problems.push(`${reader.file} is not reachable from ${roots.join(", ")}`);
  const declaration = findSymbol(parse(reader.file, text), reader.symbol);
  if (!declaration) return [...problems, `${reader.file} has no symbol ${reader.symbol}`];
  if (store.kind !== "none") {
    for (const key of store.keys)
      if (!readsKey(declaration, store.kind, key, constants))
        problems.push(`${reader.symbol} does not read ${key}`);
  }
  return problems;
}

/** The keys of the settings repository the sources spell: `settings.get(KEY)`, `.set("a.b", value)`. */
function repositoryKeys(
  sources: Source,
  paths: readonly string[],
  known: Map<string, Set<string>>
): Map<string, string> {
  const spelled = new Map<string, string>();
  const keyOf = (node: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isIdentifier(node)) return [...(known.get(node.text) ?? [])];
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression))
      return [...(known.get(`${node.expression.text}.${node.name.text}`) ?? [])];
    return [];
  };
  const isRepository = (node: ts.Node): boolean =>
    ts.isCallExpression(node) && calleeName(node) === "createSettingsRepository";
  for (const path of paths) {
    const text = sources.read(path);
    if (!text?.includes("createSettingsRepository")) continue;
    const source = parse(path, text);
    const holders = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
        if (isRepository(node.initializer)) holders.add(node.name.text);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        isRepository(node.right)
      )
        holders.add(node.left.name.text);
      ts.forEachChild(node, collect);
    };
    collect(source);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["get", "set"].includes(node.expression.name.text) &&
        node.arguments[0]
      ) {
        const receiver = node.expression.expression;
        const holds =
          isRepository(receiver) ||
          (ts.isIdentifier(receiver) && holders.has(receiver.text)) ||
          (ts.isPropertyAccessExpression(receiver) && holders.has(receiver.name.text));
        if (holds) for (const key of keyOf(node.arguments[0])) spelled.set(key, path);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return spelled;
}

/** Production sources under `apps/*` and `packages/*` (no tests, no scripts, no build output). */
/** The sources a constant may come from: with `withoutDenied`, only the files a reader may be. */
function productionSources(withoutDenied = true): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(join(root, directory))) {
      const path = `${directory}/${name}`;
      if (name === "node_modules" || name === "dist" || name === "out" || name === "scripts")
        continue;
      if (statSync(join(root, path)).isDirectory()) visit(path);
      else if (
        /\.(ts|tsx)$/u.test(name) &&
        (withoutDenied
          ? !denied(path)
          : !denyList.slice(0, 4).some((pattern) => pattern.test(path)))
      )
        found.push(path);
    }
  };
  for (const workspace of ["apps", "packages"])
    for (const name of readdirSync(join(root, workspace))) {
      const source = `${workspace}/${name}/src`;
      if (existsSync(join(root, source))) visit(source);
    }
  return found;
}

const files = productionSources();
const reach = reachableFiles(diskSource, entryPoints);
const repositoryFiles = productionSources(false);
const constants = constantValues(diskSource, repositoryFiles);
const allStores = [
  ...settingsRegistryV2.map((entry) => ({
    id: entry.id,
    reader: entry.reader,
    store: entry.store
  })),
  ...persistedStateRegistry
];

// --- the registry's shape --------------------------------------------------------------------------

describe("the registry's shape", () => {
  it("has at most seven sections, at most twelve groups in each, and a unique id per entry", () => {
    expect(settingsSectionIds.length).toBeLessThanOrEqual(7);
    const sections = new Set<string>(settingsSectionIds);
    const groups = new Map<string, Set<string>>();
    for (const entry of settingsRegistryV2) {
      expect(sections.has(entry.section), entry.id).toBe(true);
      groups.set(entry.section, (groups.get(entry.section) ?? new Set()).add(entry.group));
    }
    for (const [section, set] of groups) expect(set.size, section).toBeLessThanOrEqual(12);
    for (const section of settingsSectionIds) expect(groups.has(section), section).toBe(true);
    expect(new Set(settingsRegistryV2.map((entry) => entry.id)).size).toBe(
      settingsRegistryV2.length
    );
    const stateIds = persistedStateRegistry.map((entry) => entry.id);
    expect(new Set(stateIds).size).toBe(stateIds.length);
  });

  it("names every entry's copy once: a unique flat slug, a label and a help key", () => {
    const slugs = settingsRegistryV2.map((entry) => settingSlug(entry.id));
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const entry of settingsRegistryV2) {
      expect(entry.labelKey).toBe(`settingsRegistry.${settingSlug(entry.id)}.label`);
      expect(entry.helpKey).toBe(`settingsRegistry.${settingSlug(entry.id)}.help`);
      expect(Array.isArray(entry.keywords), entry.id).toBe(true);
    }
  });

  it("has no entry for what the owner removed or no code reads, and none for the two dead columns", () => {
    const ids = new Set([
      ...settingsRegistryV2.map((entry) => entry.id),
      ...allStores.flatMap((entry) => entry.store.keys)
    ]);
    for (const key of retiredSettingKeys) expect(ids.has(key), key).toBe(false);
    // Not entries (S13, Q31): density, open-in and reduced motion are not settings in F5; the two
    // profile columns have no control and no reader that branches (D17, T172).
    for (const slug of ["density", "openIn", "reducedMotion", "privacyMode", "fallbackPolicy"])
      expect(
        settingsRegistryV2.map((entry) => settingSlug(entry.id)),
        slug
      ).not.toContain(slug);
  });

  it("uses only the reset adapters T160 implements, and none for what stores nothing", () => {
    const adapters: readonly string[] = resetAdapterIds;
    for (const entry of settingsRegistryV2) {
      expect(adapters, entry.id).toContain(entry.reset);
      if (entry.store.kind === "none") expect(entry.reset, entry.id).toBe("none");
      else if (entry.id !== "processingPresets") expect(entry.reset, entry.id).not.toBe("none");
      expect(entry.store.keys.length === 0, entry.id).toBe(entry.store.kind === "none");
    }
  });

  it("gives every page entry its page and no other entry one", () => {
    for (const entry of settingsRegistryV2)
      expect(entry.control === "page", entry.id).toBe(entry.page !== undefined);
  });
});

describe("E7: the settings that change what the app does by itself", () => {
  it("shows at most six outside Advanced, and they are the Knowledge controls", () => {
    const visible = visibleAutomationEntries();
    expect(visible.length).toBeLessThanOrEqual(6);
    expect(visible.map((entry) => entry.id).sort()).toEqual(
      Object.keys(defaultKnowledgeControls)
        .map((field) => `knowledge.controls.v1.${field}`)
        .sort()
    );
    for (const entry of visible) expect(entry.section, entry.id).toBe("knowledge");
  });

  it("keeps every other automation setting in Advanced: the 17 matching ones, three values and the decider", () => {
    const hidden = settingsRegistryV2.filter(
      (entry) => entry.category === "automation" && !visibleAutomationEntries().includes(entry)
    );
    expect(hidden.length).toBe(16 + 1 + 1 + 1 + 1);
    for (const entry of hidden) expect(entry.section, entry.id).toBe("advanced");
  });

  it("puts the 16 matching values and the preset selector in Advanced › Matching (Q4)", () => {
    const matching = settingsRegistryV2.filter((entry) => entry.group === "matching");
    expect(matching.map((entry) => entry.id).sort()).toEqual(
      [...matchingValueControlIds, "activeMatchingPresetId"].sort()
    );
    for (const entry of matching) {
      expect(entry.section, entry.id).toBe("advanced");
      expect(entry.category, entry.id).toBe("automation");
    }
    expect(
      settingsRegistryV2.find((entry) => entry.id === "activeMatchingPresetId")?.store.keys
    ).toEqual(["activeMatchingPresetId", "matchingPresets"]);
  });
});

// --- coverage: every persisted key has an entry --------------------------------------------------------

/** The persisted keys of today's registry after T123 (70 rows), less `navigationCollapsed`. */
const persistedKeys = [
  "language",
  "contentLanguage",
  "themeMode",
  "graphWheelZoomSensitivity",
  "debugMode",
  "debugFullCapture",
  "metadataEnrichmentEnabled",
  "bookMetadataProvider",
  "keepLocalEmbeddingModelsLoaded",
  "summaryMinimumWordCount",
  "processingPresets",
  "activeMatchingPresetId",
  "matchingPresets",
  ...matchingValueControlIds,
  "obsidianVaultPath",
  "managedRoot",
  "obsidianSyncEnabled",
  "obsidianSyncPaused",
  "uploadCopiesEnabled",
  "uploadCopiesFolderPath",
  "knowledge.controls.v1.autonomy",
  "knowledge.controls.v1.monthlyCapUsd",
  "knowledge.controls.v1.paused",
  "knowledge.controls.v1.treeShape",
  "knowledge.controls.v1.onlyIdle",
  "knowledge.controls.v1.onlyOnAc",
  "ai.preset.v1",
  "relations.deciderMode",
  "relations.decisions",
  "ai:decisions-openai-platform",
  "metadata:google-books",
  "local-models.repository-token-ref",
  "obsidian.layout",
  "obsidian.wiki.scope",
  ...persistedStateRegistry.map((entry) => entry.id)
];

describe("every persisted setting has an entry", () => {
  const covered = new Set(allStores.flatMap((entry) => entry.store.keys));
  const coveredOrNested = (key: string) =>
    covered.has(key) || [...covered].some((id) => id.startsWith(`${key}.`));

  it("lists the keys of today's registry (69 persisted keys after T123 and T135) and the new ones", () => {
    for (const key of persistedKeys) expect(coveredOrNested(key), key).toBe(true);
    expect(persistedKeys.length).toBe(69);
    expect(persistedStateRegistry.length).toBe(20);
  });

  it("covers every key of the stored app preferences and storage settings, less the retired", () => {
    const retired = new Set<string>(retiredSettingKeys);
    for (const key of [
      ...Object.keys(appSettingsSchema.shape),
      ...Object.keys(storageSettingsSchema.shape)
    ])
      if (!retired.has(key)) expect(coveredOrNested(key), key).toBe(true);
    for (const group of [
      "atomicNoteMatchingSettings",
      "canonicalMatchingSettings",
      "sourceRelationSettings"
    ] as const)
      for (const member of Object.keys(recommendedMatchingConfiguration[group]))
        expect(covered.has(`${group}.${member}`), `${group}.${member}`).toBe(true);
  });

  it("registers every versioned settings key the production code spells", () => {
    const spelled = new Set<string>();
    for (const path of files)
      for (const match of read(path).matchAll(/"([a-z][A-Za-z-]*(?:\.[A-Za-z0-9-]+)*\.v\d)"/gu))
        spelled.add(match[1]!);
    const missing = [...spelled].filter((key) => !coveredOrNested(key)).sort();
    expect(missing).toEqual([]);
  });

  it("registers every key the production code gives the settings repository, versioned or not", () => {
    const spelled = repositoryKeys(diskSource, repositoryFiles, constants);
    expect(spelled.size).toBeGreaterThan(15);
    // `app.preferences` is the document that holds the app preferences, entered key by key.
    const missing = [...spelled.keys()]
      .filter((key) => key !== "app.preferences" && !coveredOrNested(key))
      .sort();
    expect(missing).toEqual([]);
  });

  it("has a default that is the one the application stores", () => {
    const stored = { ...defaultAppSettings, ...defaultStorageSettings } as Record<string, unknown>;
    for (const entry of settingsRegistryV2) {
      if (entry.store.keys.length !== 1 || !("value" in entry.default)) continue;
      const key = entry.store.keys[0]!;
      if (entry.store.kind !== "app.preferences" && entry.store.kind !== "storage_settings")
        continue;
      if (key in stored) expect(entry.default.value, entry.id).toEqual(stored[key]);
      else if (key.includes("."))
        expect(entry.default.value, entry.id).toEqual(
          key
            .split(".")
            .reduce<unknown>(
              (value, part) => (value as Record<string, unknown>)[part],
              recommendedMatchingConfiguration
            )
        );
    }
    const byId = (id: string) => settingsRegistryV2.find((entry) => entry.id === id)!;
    expect(byId("activeMatchingPresetId").default).toEqual({ value: recommendedMatchingPresetId });
    for (const field of Object.keys(defaultKnowledgeControls) as Array<
      keyof typeof defaultKnowledgeControls
    >)
      expect(byId(`knowledge.controls.v1.${field}`).default).toEqual({
        value: defaultKnowledgeControls[field]
      });
    // Q35 (D18): the notes' language starts as the macOS language, not "same as the source".
    expect(byId("contentLanguage").default).toEqual({ osLocale: true });
    expect(byId("language").default).toEqual({ osLocale: true });
  });

  it("merges the keys D17 merges and drops the controls S13 and Q31 leave out", () => {
    const byId = (id: string) => settingsRegistryV2.find((entry) => entry.id === id)!;
    expect(byId("uploadCopies").store.keys).toEqual([
      "uploadCopiesEnabled",
      "uploadCopiesFolderPath"
    ]);
    expect(byId("bookLookup").store.keys).toEqual([
      "metadataEnrichmentEnabled",
      "bookMetadataProvider"
    ]);
    expect(byId("obsidianSync").store.keys).toEqual(["obsidianSyncEnabled", "obsidianSyncPaused"]);
    for (const id of ["privacy_mode", "fallback_policy", "privacyMode", "fallbackPolicy"])
      expect(covered.has(id), id).toBe(false);
  });

  it("has an entry for each of the five class routes, the judge and every provider credential", () => {
    const ids = settingsRegistryV2.map((entry) => entry.id);
    for (const name of ["embed", "decide", "write-fast", "write-quality", "answer", "judge"])
      expect(ids).toContain(`ai.route.${name}`);
    for (const provider of ["openai-codex", "openai-compatible", "google"])
      expect(ids).toContain(`ai.provider.${provider}`);
  });
});

// --- the reader test (D17): a body, a file off the deny-list, a path from an entry point -----------------

describe("the reader of every entry (D17)", () => {
  const problemsOf = (entry: (typeof allStores)[number]) =>
    checkReader(diskSource, entryPoints, reach, constants, entry.reader, entry.store);

  it("names a symbol whose body reads the key, in an allowed file that an app entry point reaches", () => {
    const problems = allStores
      .filter((entry) => !(entry.id in knownUnread))
      .flatMap((entry) =>
        problemsOf(entry)
          // The one deny-listed file taken for an entry is the writer's own getter (pinned below).
          .filter(
            (problem) =>
              deniedReaderExceptions[entry.id]?.file !== entry.reader.file ||
              !problem.includes("deny-list")
          )
          .map((problem) => `${entry.id}: ${problem}`)
      );
    expect(problems).toEqual([]);
  });

  it("gives each page, action and panel its own symbol: a function, a method or a class", () => {
    const tools = settingsRegistryV2.filter((entry) => entry.store.kind === "none");
    const symbols = tools.map((entry) => `${entry.reader.file}#${entry.reader.symbol}`);
    expect(symbols.filter((symbol, index) => symbols.indexOf(symbol) !== index)).toEqual([]);
    for (const entry of tools) {
      expect(entry.reader.symbol, entry.id).not.toBe("<module>");
      const declaration = findSymbol(
        parse(entry.reader.file, read(entry.reader.file)),
        entry.reader.symbol
      );
      expect(declaration, entry.id).not.toBeNull();
      const callable =
        ts.isFunctionDeclaration(declaration!) ||
        ts.isMethodDeclaration(declaration!) ||
        ts.isClassDeclaration(declaration!) ||
        (ts.isVariableDeclaration(declaration!) &&
          declaration.initializer !== undefined &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)));
      expect(callable, `${entry.id}: ${entry.reader.symbol} is not callable`).toBe(true);
    }
  });

  it("takes a deny-listed reader only where the product calls the getter it names", () => {
    for (const [id, exception] of Object.entries(deniedReaderExceptions)) {
      const found = allStores.find((entry) => entry.id === id);
      expect(found?.reader.file, id).toBe(exception.file);
      expect(read(exception.consumer.file), id).toContain(exception.consumer.text);
      expect(reach.has(exception.consumer.file), id).toBe(true);
    }
  });

  it("names the settings no code outside the Settings screen reads, and fails once one has a reader", () => {
    for (const id of Object.keys(knownUnread)) {
      const found = allStores.find((entry) => entry.id === id);
      expect(found, id).toBeDefined();
      expect(problemsOf(found!), id).not.toEqual([]);
    }
  });

  it("fails an entry whose reader is a test, a schema, unreachable, bodiless or missing", () => {
    const sources: Source = {
      read: (path) =>
        ({
          "apps/desktop/src/main/index.ts": `import { Reader } from "./reader.js"; export const run = () => new Reader();`,
          "apps/desktop/src/main/reader.ts": `export class Reader { value(settings: { themeMode: string }) { return settings.themeMode; } other() { return 1; } }
            export const standalone = (store: any) => store.get("kv.key.v1");`,
          "apps/desktop/src/main/orphan.ts": `export const orphan = (s: { themeMode: string }) => s.themeMode;`,
          "apps/desktop/src/main/reader.test.ts": `export const t = (s: { themeMode: string }) => s.themeMode;`,
          "apps/desktop/src/shared/ipc.ts": `export const schema = { themeMode: "x" };`
        })[path] ?? null
    };
    const roots = ["apps/desktop/src/main/index.ts"];
    const reachable = reachableFiles(sources, roots);
    const prefs: StoreRef = { kind: "app.preferences", keys: ["themeMode"] };
    const check = (file: string, symbol: string, store: StoreRef = prefs) =>
      checkReader(sources, roots, reachable, new Map(), { file, symbol }, store);
    expect(check("apps/desktop/src/main/reader.ts", "Reader.value")).toEqual([]);
    expect(
      check("apps/desktop/src/main/reader.ts", "standalone", {
        kind: "settings",
        keys: ["kv.key.v1"]
      })
    ).toEqual([]);
    expect(check("apps/desktop/src/main/reader.ts", "Reader.other").join()).toContain(
      "does not read themeMode"
    );
    expect(check("apps/desktop/src/main/reader.ts", "Reader.missing").join()).toContain(
      "no symbol"
    );
    expect(check("apps/desktop/src/main/orphan.ts", "orphan").join()).toContain("not reachable");
    expect(check("apps/desktop/src/main/reader.test.ts", "t").join()).toContain("deny-list");
    expect(check("apps/desktop/src/shared/ipc.ts", "schema").join()).toContain("deny-list");
    expect(check("apps/desktop/src/main/absent.ts", "x").join()).toContain("does not exist");
    // A page or an action stores nothing: it needs a symbol and a path, not a key.
    expect(
      check("apps/desktop/src/main/reader.ts", "Reader.other", { kind: "none", keys: [] })
    ).toEqual([]);
  });

  it("does not accept a key that is only declared, compared, written or skipped (X11)", () => {
    const sources: Source = {
      read: (path) =>
        ({
          "apps/desktop/src/main/index.ts": `import "./keys.js";`,
          "apps/desktop/src/main/keys.ts": `
            export const SOME_KEY = "kv.key.v1";
            export const config = { dailyKey: "kv.key.v1", other: 1 } as const;
            export function skips(key: string) { if (key === "kv.key.v1") return null; return key; }
            export function skipsPref(key: string) { if (key === "themeMode") return null; return key; }
            export function writes(store: any, settings: { themeMode: string }) {
              settings.themeMode = "dark";
              return store.set("kv.key.v1", 1);
            }
            export function types(): "kv.key.v1" { return "kv.key.v1"; }
            export const reads = (store: any) => store.get(SOME_KEY);
            export const readsThroughObject = (store: any) => store.get(config.dailyKey);
            export function readsPref(settings: { themeMode: string }) { return settings.themeMode; }
            export function destructures(settings: { themeMode: string }) { const { themeMode } = settings; return themeMode; }
            export const readsLiteral = (store: any) => store.query("select 1 where key = 'kv.key.v1'");`
        })[path] ?? null
    };
    const roots = ["apps/desktop/src/main/index.ts"];
    const reachable = reachableFiles(sources, roots);
    const known = new Map([
      ["SOME_KEY", new Set(["kv.key.v1"])],
      ["config.dailyKey", new Set(["kv.key.v1"])]
    ]);
    const kv: StoreRef = { kind: "settings", keys: ["kv.key.v1"] };
    const prefs: StoreRef = { kind: "app.preferences", keys: ["themeMode"] };
    const check = (symbol: string, store: StoreRef) =>
      checkReader(
        sources,
        roots,
        reachable,
        known,
        { file: "apps/desktop/src/main/keys.ts", symbol },
        store
      );
    for (const symbol of ["SOME_KEY", "config", "skips", "writes", "types"])
      expect(check(symbol, kv).join(), symbol).toContain("does not read kv.key.v1");
    expect(check("skipsPref", prefs).join()).toContain("does not read themeMode");
    expect(check("writes", prefs).join()).toContain("does not read themeMode");
    for (const symbol of ["reads", "readsThroughObject", "readsLiteral"])
      expect(check(symbol, kv), symbol).toEqual([]);
    for (const symbol of ["readsPref", "destructures"])
      expect(check(symbol, prefs), symbol).toEqual([]);
  });

  it("follows a key through a local, and through the builder of a route key", () => {
    const sources: Source = {
      read: (path) =>
        ({
          "apps/desktop/src/main/index.ts": `import "./keys.js";`,
          "apps/desktop/src/main/keys.ts": `
            export function throughLocal(db: any, options: { key?: string }) {
              const key = options.key ?? SOME_KEY;
              return db.query("select value from settings where key = $1", [key]);
            }
            export function unusedLocal(options: { key?: string }) {
              const key = options.key ?? SOME_KEY;
              return options;
            }
            export function byBuilder(routes: Map<string, string>, id: string) {
              return routes.get(workloadClassRouteKey(id));
            }
            export function onlyBuilds(id: string) { return workloadClassRouteKey(id); }`
        })[path] ?? null
    };
    const roots = ["apps/desktop/src/main/index.ts"];
    const reachable = reachableFiles(sources, roots);
    const known = new Map([["SOME_KEY", new Set(["kv.key.v1"])]]);
    const check = (symbol: string, store: StoreRef) =>
      checkReader(
        sources,
        roots,
        reachable,
        known,
        { file: "apps/desktop/src/main/keys.ts", symbol },
        store
      );
    const kv: StoreRef = { kind: "settings", keys: ["kv.key.v1"] };
    const route: StoreRef = { kind: "route", keys: ["class:embed"] };
    expect(check("throughLocal", kv)).toEqual([]);
    expect(check("unusedLocal", kv).join()).toContain("does not read kv.key.v1");
    expect(check("byBuilder", route)).toEqual([]);
    expect(check("onlyBuilds", route).join()).toContain("does not read class:embed");
  });

  it("denies the writer, the area schemas, the reset and the Settings screen as readers (D17)", () => {
    for (const file of [
      "apps/desktop/src/main/services/settings-service.ts",
      "apps/desktop/src/main/services/settings-reset.ts",
      "apps/desktop/src/shared/ipc.ts",
      "apps/desktop/src/shared/ipc-library.ts",
      "apps/desktop/src/shared/settings-registry.ts",
      "apps/desktop/src/renderer/settings/SettingRow.tsx",
      "apps/desktop/src/renderer/components/settings/MatchingSettingsGroup.tsx"
    ])
      expect(denied(file), file).toBe(true);
    for (const file of [
      "apps/desktop/src/main/index.ts",
      "apps/desktop/src/main/services/job-supervisor.ts",
      "apps/desktop/src/renderer/App.tsx",
      "apps/desktop/src/shared/app-events.ts"
    ])
      expect(denied(file), file).toBe(false);
  });

  it("finds the keys given to the settings repository, versioned or not", () => {
    const sources: Source = {
      read: (path) =>
        path === "a.ts"
          ? `const unversioned = "feature.flag";
             export async function f(pool: unknown) {
               const settings = createSettingsRepository(pool);
               await settings.get(unversioned);
               await createSettingsRepository(pool).set("other.thing", 1);
               await cache.get("not.a.setting");
             }`
          : null
    };
    const known = constantValues(sources, ["a.ts"]);
    expect([...repositoryKeys(sources, ["a.ts"], known).keys()].sort()).toEqual([
      "feature.flag",
      "other.thing"
    ]);
  });

  it("does not count a type-only import as a path", () => {
    const sources: Source = {
      read: (path) =>
        ({
          "apps/desktop/src/main/index.ts": `import type { A } from "./types.js"; export const x = 1;`,
          "apps/desktop/src/main/types.ts": `export type A = 1;`
        })[path] ?? null
    };
    expect([...reachableFiles(sources, ["apps/desktop/src/main/index.ts"])]).toEqual([
      "apps/desktop/src/main/index.ts"
    ]);
  });

  it("reads a key spelled by a constant of another file", () => {
    const declaration = parse(
      "a.ts",
      `export const f = (repository: any) => repository.get(someSettingKey);`
    );
    const known = new Map([["someSettingKey", new Set(["some.setting.v1"])]]);
    expect(readsKey(declaration, "settings", "some.setting.v1", known)).toBe(true);
    expect(readsKey(declaration, "settings", "other.setting.v1", known)).toBe(false);
  });

  it("is reachable: the roots exist and reach the services", () => {
    for (const file of entryPoints) expect(existsSync(join(root, file)), file).toBe(true);
    expect(reach.size).toBeGreaterThan(500);
  });
});

describe("no retired key is still read", () => {
  it("has no production reader for a retired key but the stored schema that still lists it", () => {
    const stored = new Set([
      ...Object.keys(appSettingsSchema.shape),
      ...Object.keys(storageSettingsSchema.shape)
    ]);
    for (const dead of retiredSettingKeys) {
      // The stored schema (`S/ipc.ts`, off the production list) still declares `navigationCollapsed`
      // until the owner of that chain file drops it; nothing else spells any retired key.
      expect(
        files.filter((path) => word(dead).test(read(path))),
        dead
      ).toEqual([]);
    }
    for (const dead of ["wikiTreeWidth", "deletionPolicy"])
      expect(stored.has(dead), dead).toBe(false);
    // The copy of the removed delete-policy control went with it, in every locale.
    for (const locale of ["en", "pt-BR", "it", "fr", "es"]) {
      const copy = read(`packages/i18n/src/locales/${locale}.json`);
      expect(copy, locale).not.toContain("deletePolicies");
      expect(copy, locale).not.toContain("obsidianDeletePolicy");
    }
  });
});

// --- the copy (T175 writes it) --------------------------------------------------------------------------

type Catalog = Record<string, unknown>;

/** What a locale's `settingsRegistry` namespace lacks: each entry's label and help, each group's name. */
function missingCopy(namespace: unknown, entries: readonly SettingEntryV2[]): string[] {
  const copy = (namespace ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const text = (value: unknown) => typeof value === "string" && value.length > 0;
  const missing: string[] = [];
  for (const entry of entries) {
    const slug = settingSlug(entry.id);
    if (!text(copy[slug]?.["label"])) missing.push(entry.labelKey);
    if (!text(copy[slug]?.["help"])) missing.push(entry.helpKey);
  }
  const groups = (copy["groups"] ?? {}) as Record<string, Record<string, unknown> | undefined>;
  for (const entry of entries)
    if (!text(groups[entry.section]?.[entry.group]))
      missing.push(`settingsRegistry.groups.${entry.section}.${entry.group}`);
  return [...new Set(missing)];
}

describe("the copy of every entry", () => {
  it("exists in all five locales once the settingsRegistry namespace does (T175)", () => {
    const locales = ["en", "pt-BR", "it", "fr", "es"] as const;
    const catalogs = Object.fromEntries(
      locales.map((locale) => [
        locale,
        JSON.parse(read(`packages/i18n/src/locales/${locale}.json`)) as Catalog
      ])
    );
    // T159 declares the keys; T175 writes them. Until the namespace exists in English there is
    // nothing to compare (the checker itself is exercised below); from the first key on, every
    // locale needs every label, every help and every group name.
    if (!catalogs.en!["settingsRegistry"]) {
      for (const locale of locales)
        expect(catalogs[locale]!["settingsRegistry"], locale).toBeUndefined();
      return;
    }
    for (const locale of locales)
      expect(
        missingCopy(catalogs[locale]!["settingsRegistry"], settingsRegistryV2),
        locale
      ).toEqual([]);
  });

  it("finds a missing label, help or group name", () => {
    const entries = settingsRegistryV2.slice(0, 2);
    const first = entries[0]!;
    const groups: Record<string, Record<string, string>> = {};
    for (const entry of entries) (groups[entry.section] ??= {})[entry.group] = "g";
    const complete = {
      [settingSlug(first.id)]: { label: "x", help: "y" },
      [settingSlug(entries[1]!.id)]: { label: "x", help: "y" },
      groups
    };
    expect(missingCopy(complete, entries)).toEqual([]);
    expect(missingCopy({ ...complete, groups: undefined }, entries)).toContain(
      `settingsRegistry.groups.${first.section}.${first.group}`
    );
    expect(missingCopy({ ...complete, [settingSlug(first.id)]: { label: "x" } }, entries)).toEqual([
      first.helpKey
    ]);
    expect(missingCopy(undefined, entries)).toContain(first.labelKey);
  });
});

/** The inventory's spelling of a path: `M/` main, `R/` renderer, `S/` shared, `P/` preload, `D/` domain, `DB/` db. */
const shorten = (file: string) =>
  file
    .replace("apps/desktop/src/main/", "M/")
    .replace("apps/desktop/src/renderer/", "R/")
    .replace("apps/desktop/src/shared/", "S/")
    .replace("apps/desktop/src/preload/", "P/")
    .replace("packages/domain/src/", "D/")
    .replace("packages/db/src/", "DB/");
const storeCell = (ref: StoreRef) =>
  ref.kind === "none" ? "none" : `${ref.kind}: ${ref.keys.map((key) => `\`${key}\``).join(", ")}`;
const defaultCell = (value: DefaultRef) =>
  "value" in value
    ? `\`${JSON.stringify(value.value)}\``
    : "osLocale" in value
      ? "macOS language"
      : "unset" in value
        ? "unset"
        : `computed (${value.computed})`;
const readerCell = (reader: { file: string; symbol: string }) =>
  `\`${shorten(reader.file)}\` ${reader.symbol}`;
/** The row of section 15 an entry must have, every column of it. */
const entryRow = (entry: SettingEntryV2) =>
  `| \`${entry.id}\` | ${entry.section} › ${entry.group} | ${entry.control} | ${storeCell(entry.store)} | ${defaultCell(entry.default)} | ${entry.reset} | ${readerCell(entry.reader)} |`;
const stateRow = (entry: PersistedStateEntry) =>
  `| \`${entry.id}\` | ${storeCell(entry.store)} | ${readerCell(entry.reader)} |`;

describe("docs/settings-inventory.md", () => {
  const inventory = read("docs/settings-inventory.md");
  const section = inventory.slice(inventory.indexOf("## 15. Registry v2"));
  const rows = [...section.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]!);

  it("lists every registry entry and every persisted state key of section 15, and nothing else", () => {
    expect(section.length).toBeGreaterThan(0);
    const expected = [
      ...settingsRegistryV2.map((entry) => entry.id),
      ...persistedStateRegistry.map((entry) => entry.id)
    ];
    expect([...rows].sort()).toEqual([...expected].sort());
  });

  it("says in every row what the registry says: section, group, control, store, default, reset and reader", () => {
    const rowsOf = [...section.split("\n")].filter((line) => /^\| `[^`]+` \|/u.test(line));
    const expected = [...settingsRegistryV2.map(entryRow), ...persistedStateRegistry.map(stateRow)];
    expect(rowsOf.sort()).toEqual(expected.sort());
  });

  it("names the keys that are dropped and says no code reads them", () => {
    for (const key of retiredSettingKeys) expect(section, key).toContain(`\`${key}\``);
  });
});
