import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The first-run harness is DEV tooling (D1): it sits under `src/main` but no product module imports
 * it, so a change here cannot change what the app does. It is reached only through the root
 * `npm run firstrun:e2e` script (`tsx .../firstrun-e2e/cli.ts`); the app's bundles start from
 * `src/main/index.ts`, the worker host and the preload, and none of them reaches this folder.
 */
const workspace = resolve(import.meta.dirname, "../../../../../..");
const desktopSrc = join(workspace, "apps/desktop/src");
const harness = join(desktopSrc, "main/services/firstrun-e2e");

const isSource = (name: string) => /\.(?:ts|tsx|mts)$/u.test(name) && !name.endsWith(".d.ts");
const isTest = (name: string) => /\.test\.tsx?$/u.test(name);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory())
      return name === "node_modules" || name === "dist" ? [] : sourceFiles(path);
    return isSource(name) && !isTest(name) ? [path] : [];
  });
}

const specifierPattern =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/gu;

/** The local files a module imports (relative and `@desktop/` specifiers), resolved to sources. */
function localImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(specifierPattern)].flatMap((match) => {
    const specifier = match[1]!;
    const base = specifier.startsWith(".")
      ? resolve(dirname(file), specifier)
      : specifier.startsWith("@desktop/")
        ? join(desktopSrc, specifier.slice("@desktop/".length))
        : null;
    if (!base) return [];
    const stem = base.replace(/\.(?:js|mjs|cjs|ts|tsx)$/u, "");
    const found = [`${stem}.ts`, `${stem}.tsx`, join(base, "index.ts"), base].find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile()
    );
    return found ? [found] : [];
  });
}

const insideHarness = (path: string) => path === harness || path.startsWith(`${harness}${sep}`);

describe("the first-run harness stays out of the product (D1)", () => {
  it("is imported by no module outside its folder, in the desktop app or in any package", () => {
    const productFiles = [
      ...sourceFiles(desktopSrc).filter((file) => !insideHarness(file)),
      ...readdirSync(join(workspace, "packages"))
        .map((name) => join(workspace, "packages", name, "src"))
        .filter((directory) => existsSync(directory))
        .flatMap(sourceFiles)
    ];
    expect(productFiles.length).toBeGreaterThan(300);
    const importers = productFiles.filter(
      (file) =>
        localImports(file).some(insideHarness) ||
        readFileSync(file, "utf8").includes("firstrun-e2e/")
    );
    expect(importers.map((file) => relative(workspace, file))).toEqual([]);
  });

  it("is reached by none of the app's bundle entries", () => {
    const entries = [
      join(desktopSrc, "main/index.ts"),
      join(desktopSrc, "main/workers/worker-host.ts"),
      join(desktopSrc, "preload/index.ts")
    ];
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...localImports(file));
    }
    // The walk does reach the product's services, the job supervisor the harness drives included.
    expect(seen.has(join(desktopSrc, "main/services/job-supervisor.ts"))).toBe(true);
    expect(seen.size).toBeGreaterThan(200);
    expect([...seen].filter(insideHarness).map((file) => relative(workspace, file))).toEqual([]);
  });

  it("is started only by the root firstrun:e2e script, through its command line", () => {
    const scripts = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    const reaching = Object.entries(scripts).filter(([, command]) =>
      command.includes("firstrun-e2e")
    );
    expect(reaching).toEqual([
      ["firstrun:e2e", "tsx apps/desktop/src/main/services/firstrun-e2e/cli.ts"]
    ]);
  });
});
