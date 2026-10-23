import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// electron-vite injects its CommonJS shims after the last match of this expression in each
// main-process chunk (node_modules/electron-vite, `ESMStaticImportRe`). Prose such as "an import's
// own job" in a comment matches it too, and the shims then land inside the comment: the worker
// bundle fails to build and the app does not start. Only real import statements may match.
const shimImportExpression =
  /(?<=\s|^|;)import\s*([\s"']*(?<imports>[\p{L}\p{M}\w\t\n\r $*,/{}@.]+)from\s*)?["']\s*(?<specifier>(?<="\s*)[^"]*[^\s"](?=\s*")|(?<='\s*)[^']*[^\s'](?=\s*'))\s*["'][\s;]*/gmu;

const repoRoot = resolve(__dirname, "../../../..");
const bundledRoots = [
  "apps/desktop/src/main",
  "apps/desktop/src/preload",
  "apps/desktop/src/shared",
  "packages/ai/src",
  "packages/db/src",
  "packages/domain/src",
  "packages/i18n/src"
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx|mts)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("CommonJS shim placement", () => {
  it("lets only real import statements match electron-vite's import expression", () => {
    const strays: string[] = [];
    for (const root of bundledRoots) {
      for (const file of sourceFiles(join(repoRoot, root))) {
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(shimImportExpression)) {
          const lineStart = text.lastIndexOf("\n", (match.index ?? 0) - 1) + 1;
          if (text.slice(lineStart, match.index).trim() !== "") {
            const line = text.slice(0, match.index).split("\n").length;
            strays.push(`${relative(repoRoot, file)}:${line}`);
          }
        }
      }
    }
    expect(strays).toEqual([]);
  });
});
