import { describe, expect, it } from "vitest";

import { surfaces, type ScreenModule } from "./workspace/surfaces";

// The static half of the four-state check (X5): every surface that exists has a screen module that
// renders it, no screen module writes `data-state`, and nothing that looks like a surface is missing
// from `workspace/surfaces.ts`. `npm run screens -- --check` does the runtime half.

/** Every renderer source file, as the path `surfaces.ts` uses (relative to the renderer, no `./`). */
const present = new Set(
  Object.keys(import.meta.glob(["./**/*.ts", "./**/*.tsx", "!./**/node_modules/**"])).map((path) =>
    path.slice(2)
  )
);
const screenSources = import.meta.glob<string>("./**/*.screen.tsx", {
  query: "?raw",
  import: "default",
  eager: true
});
const screenLoaders = import.meta.glob<ScreenModule>("./**/*.screen.tsx");
const screens = Object.keys(screenSources).map((path) => path.slice(2));
const built = surfaces.filter((entry) => present.has(entry.implementation));

/** The module a relative specifier names, as a path without an extension. */
function resolveImport(file: string, specifier: string): string {
  return new URL(specifier, `http://renderer/${file}`).pathname
    .slice(1)
    .replace(/\.(tsx?|css)$/u, "");
}

/** The relative modules a screen module imports. */
function importedPaths(screen: string): string[] {
  const source = screenSources[`./${screen}`] ?? "";
  return [...source.matchAll(/(?:from|import)\s+["'](\.[^"']*)["']/gu)].map((match) =>
    resolveImport(screen, match[1] ?? "")
  );
}

const withoutExtension = (path: string) => path.replace(/\.tsx?$/u, "");

describe("the surface list", () => {
  it("has unique ids, implementations and screen modules, and a screen module per surface", () => {
    for (const key of ["id", "implementation", "screen"] as const) {
      const values = surfaces.map((entry) => entry[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
    for (const entry of surfaces) expect(entry.screen, entry.id).toMatch(/\.screen\.tsx$/u);
  });

  it("flags the object panels, and only them, with the path ribbon", () => {
    expect(surfaces.filter((entry) => entry.ribbon).map((entry) => entry.id)).toEqual([
      "source",
      "note",
      "topic",
      "entity",
      "question"
    ]);
  });

  it("builds the six hosted screens that exist today", () => {
    expect(built.filter((entry) => entry.kind === "hosted").map((entry) => entry.id)).toEqual([
      "inbox",
      "shape",
      "activity",
      "onboarding",
      "note-page",
      "topic-page"
    ]);
  });
});

describe("every surface that exists has a screen module", () => {
  it.each(built.map((entry) => [entry.id, entry] as const))("%s", (_id, entry) => {
    expect(screens, `${entry.screen} is missing`).toContain(entry.screen);
    expect(
      importedPaths(entry.screen),
      `${entry.screen} must import ${entry.implementation}`
    ).toContain(withoutExtension(entry.implementation));
  });
});

describe("screen modules", () => {
  it("are each the screen of one surface", () => {
    for (const screen of screens)
      expect(
        surfaces.some((entry) => entry.screen === screen),
        `${screen} has no entry in workspace/surfaces.ts`
      ).toBe(true);
  });

  it("never write data-state: the surface's own frame does", () => {
    for (const screen of screens)
      expect(screenSources[`./${screen}`], screen).not.toContain("data-state");
  });

  it.each(built.map((entry) => [entry.id, entry.screen] as const))(
    "%s exports its surface, both fixture sets and render",
    async (id, screen) => {
      const load = screenLoaders[`./${screen}`];
      expect(load, `${screen} is missing`).toBeTypeOf("function");
      const module = await load?.();
      expect(module?.surface).toBe(id);
      expect(module?.fixtures.success).toBeTypeOf("object");
      expect(module?.fixtures.empty).toBeTypeOf("object");
      expect(module?.render).toBeTypeOf("function");
    },
    // The first import of a screen loads its whole component tree.
    60_000
  );
});

describe("nothing that looks like a surface is missing from the list", () => {
  const implementations = new Set(surfaces.map((entry) => entry.implementation));

  it("has an entry for every panel file", () => {
    const panels = [...present].filter((path) =>
      /^workspace\/panels\/[^/]+\.panel\.tsx$/u.test(path)
    );
    for (const panel of panels)
      expect(implementations.has(panel), `${panel} has no entry in workspace/surfaces.ts`).toBe(
        true
      );
  });

  it("has an entry for every destination root", () => {
    const roots = [...present].filter((path) =>
      /^workspace\/destinations\/[^/]+\/[A-Za-z]+Root\.tsx$/u.test(path)
    );
    for (const destination of roots)
      expect(
        implementations.has(destination),
        `${destination} has no entry in workspace/surfaces.ts`
      ).toBe(true);
  });
});
