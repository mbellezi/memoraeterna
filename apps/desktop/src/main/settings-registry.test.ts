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

/** A reader may not be a schema, a test, a fixture, a script or the tooling that pins a value. */
const denyList: readonly RegExp[] = [
  /\.(test|spec)\.tsx?$/u,
  /\.d\.ts$/u,
  /(^|\/)(__fixtures__|__tests__|fixtures|scripts|e2e)\//u,
  /(^|\/)verify-[^/]*$/u,
  /(^|\/)(golden|matching-benchmark|matching-pilot)[^/]*$/u,
  /(^|\/)services\/dev\//u,
  /^apps\/desktop\/src\/shared\/(ipc|settings-registry)\.ts$/u,
  /\.(json|md)$/u
];
const denied = (file: string) => denyList.some((pattern) => pattern.test(file));

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

interface Names {
  identifiers: Set<string>;
  literals: Set<string>;
}

/** What a body mentions: identifiers that are not a key being written, and string literals. */
function namesIn(node: ts.Node): Names {
  const identifiers = new Set<string>();
  const literals = new Set<string>();
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current)) {
      const parent = current.parent;
      const writtenKey =
        (ts.isPropertyAssignment(parent) && parent.name === current) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent);
      if (!writtenKey) identifiers.add(current.text);
    } else if (ts.isStringLiteralLike(current)) literals.add(current.text);
    else if (ts.isTemplateHead(current)) literals.add(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return { identifiers, literals };
}

/** `const NAME = "text"`, `const NAME = ["a", "b"]` and `const A = B` of the production sources. */
function constantValues(sources: Source, files: readonly string[]): Map<string, Set<string>> {
  const values = new Map<string, Set<string>>();
  const aliases: Array<[string, string]> = [];
  for (const file of files) {
    const text = sources.read(file);
    if (!text) continue;
    for (const match of text.matchAll(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:"([^"\n]*)"|\[([^\]]*)\]|([A-Za-z_$][\w$]*)\s*;)/gu
    )) {
      const [, name, text1, list, alias] = match as unknown as [
        string,
        string,
        string | undefined,
        string | undefined,
        string | undefined
      ];
      const set = values.get(name) ?? new Set<string>();
      if (text1 !== undefined) set.add(text1);
      if (list !== undefined) for (const item of list.matchAll(/"([^"\n]*)"/gu)) set.add(item[1]!);
      if (alias !== undefined) aliases.push([name, alias]);
      values.set(name, set);
    }
  }
  for (const [name, alias] of aliases)
    for (const value of values.get(alias) ?? []) values.get(name)!.add(value);
  return values;
}

/** The ways a key is spelled in code, by where it is stored. */
function spellings(
  store: StoreRef["kind"],
  key: string
): { accessors: string[]; literals: string[] } {
  const last = key.split(/[.:]/u).at(-1)!;
  if (key.startsWith("knowledge.controls.v1.")) return { accessors: [last], literals: [] };
  switch (store) {
    case "app.preferences":
    case "storage_settings":
      return { accessors: [last], literals: [last] };
    case "route":
      return { accessors: [], literals: [key, last] };
    case "credential":
      return { accessors: [last], literals: [key, last] };
    default:
      return { accessors: [], literals: [key] };
  }
}

function readsKey(
  names: Names,
  store: StoreRef["kind"],
  key: string,
  constants: Map<string, Set<string>>
): boolean {
  const { accessors, literals } = spellings(store, key);
  if (accessors.some((accessor) => names.identifiers.has(accessor))) return true;
  const literalSet = [...names.literals];
  if (
    literals.some(
      (literal) =>
        names.literals.has(literal) ||
        // A key family (`obsidian.layout.presence.<client>`) is spelled by its prefix.
        literalSet.some(
          (spelled) =>
            spelled.startsWith(`${key}.`) ||
            spelled === key ||
            // A key spelled inside a SQL statement.
            (store === "settings" && spelled.includes(`'${key}'`))
        )
    )
  )
    return true;
  for (const identifier of names.identifiers) {
    const values = constants.get(identifier);
    if (values && literals.some((literal) => values.has(literal))) return true;
  }
  return false;
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
    problems.push(`${reader.file} is a schema, test, fixture or tooling file`);
  const text = sources.read(reader.file);
  if (text === null) return [...problems, `${reader.file} does not exist`];
  if (!reach.has(reader.file))
    problems.push(`${reader.file} is not reachable from ${roots.join(", ")}`);
  const declaration = findSymbol(parse(reader.file, text), reader.symbol);
  if (!declaration) return [...problems, `${reader.file} has no symbol ${reader.symbol}`];
  if (store.kind !== "none") {
    const names = namesIn(declaration);
    for (const key of store.keys)
      if (!readsKey(names, store.kind, key, constants))
        problems.push(`${reader.symbol} does not read ${key}`);
  }
  return problems;
}

/** Production sources under `apps/*` and `packages/*` (no tests, no scripts, no build output). */
function productionSources(): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(join(root, directory))) {
      const path = `${directory}/${name}`;
      if (name === "node_modules" || name === "dist" || name === "out" || name === "scripts")
        continue;
      if (statSync(join(root, path)).isDirectory()) visit(path);
      else if (/\.(ts|tsx)$/u.test(name) && !denied(path)) found.push(path);
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
const constants = constantValues(diskSource, files);
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
  it("names a symbol whose body reads the key, in an allowed file that an app entry point reaches", () => {
    const problems = allStores.flatMap((entry) =>
      checkReader(diskSource, entryPoints, reach, constants, entry.reader, entry.store).map(
        (problem) => `${entry.id}: ${problem}`
      )
    );
    expect(problems).toEqual([]);
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
    expect(check("apps/desktop/src/main/reader.test.ts", "t").join()).toContain("schema, test");
    expect(check("apps/desktop/src/shared/ipc.ts", "schema").join()).toContain("schema, test");
    expect(check("apps/desktop/src/main/absent.ts", "x").join()).toContain("does not exist");
    // A page or an action stores nothing: it needs a symbol and a path, not a key.
    expect(
      check("apps/desktop/src/main/reader.ts", "Reader.other", { kind: "none", keys: [] })
    ).toEqual([]);
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
    const names = namesIn(
      parse("a.ts", `export const f = (repository: any) => repository.get(someSettingKey);`)
    );
    const known = new Map([["someSettingKey", new Set(["some.setting.v1"])]]);
    expect(readsKey(names, "settings", "some.setting.v1", known)).toBe(true);
    expect(readsKey(names, "settings", "other.setting.v1", known)).toBe(false);
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

describe("the copy of every entry", () => {
  it("exists in all five locales once the settingsRegistry namespace does (T175)", () => {
    const locales = ["en", "pt-BR", "it", "fr", "es"] as const;
    const catalogs = Object.fromEntries(
      locales.map((locale) => [
        locale,
        JSON.parse(read(`packages/i18n/src/locales/${locale}.json`)) as Record<string, unknown>
      ])
    );
    const english = catalogs.en!["settingsRegistry"] as
      Record<string, Record<string, string>> | undefined;
    // T159 declares the keys; T175 writes them. Until the namespace exists the test has nothing to
    // compare; from the first key on it demands every key in every locale.
    if (!english) return;
    for (const locale of locales) {
      const namespace = (catalogs[locale]!["settingsRegistry"] ?? {}) as Record<
        string,
        Record<string, string>
      >;
      for (const entry of settingsRegistryV2) {
        const slug = settingSlug(entry.id);
        expect(namespace[slug]?.label, `${locale}: ${entry.labelKey}`).toEqual(expect.any(String));
        expect(namespace[slug]?.help, `${locale}: ${entry.helpKey}`).toEqual(expect.any(String));
      }
    }
  });
});

// --- the inventory (docs/settings-inventory.md section 15) ---------------------------------------------

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

  it("names the keys that are dropped and says no code reads them", () => {
    for (const key of retiredSettingKeys) expect(section, key).toContain(`\`${key}\``);
  });
});
