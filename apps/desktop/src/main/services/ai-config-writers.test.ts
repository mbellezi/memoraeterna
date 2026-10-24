import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { aiConfigRepositoryWriters, localModelRepositoryWriters } from "@app/db";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { workspaceRoot } from "./workload-class-sites.js";

/**
 * F3 D38: the hot path caches what it reads of the AI configuration for one generation of it, so
 * every writer of that configuration must report itself. The repositories bump the generation (a
 * test enumerates their methods), the credential service bumps it, and these guards read the source
 * for the two ways a writer could still slip past: SQL that bypasses the repositories, and an AI
 * service method that writes through one without dropping its own cache.
 */
const tracked = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  }
)
  .split("\0")
  .filter(Boolean);

const configTables = [
  "ai_provider_configs",
  "ai_profile_sets",
  "ai_profile_tasks",
  "ai_task_profile_routes",
  "local_models",
  "ai_model_capabilities"
];
const sqlWrite = new RegExp(
  `(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?"?(${configTables.join("|")})\\b`,
  "iu"
);

/**
 * The one writer outside the repositories. The scripted soak setup (`MEMORA_SOAK_SETUP=1`) makes a
 * profile the only default one, and no repository method does that (`createProfile` makes a new
 * profile). It is DEV-only: `readSoakSetupKnob` refuses it in a packaged build, beside any other
 * DEV knob and outside a clone under `.cache/profiles/`, and it bumps the configuration generation
 * itself, so the hot path's cache is dropped like after any other write.
 */
const devOnlyWriters = [
  // The 7-day soak's ranker window takes the reranking capability away and back (F4 T89).
  "apps/desktop/src/main/services/dev/soak-hooks.ts",
  "apps/desktop/src/main/services/dev/soak-setup.ts"
];

describe("who writes the AI configuration tables", () => {
  it("only the two repositories do, and a DEV-only soak setup, outside migrations, the baseline and the proof scripts", () => {
    const writers = tracked
      .filter(
        (file) =>
          /\.(ts|tsx|mjs|js)$/u.test(file) &&
          !/\.test\.[cm]?[jt]sx?$/u.test(file) &&
          !/(^|\/)verify[^/]*\.ts$/u.test(file) &&
          !file.includes("/scripts/") &&
          !file.startsWith("scripts/") &&
          !file.startsWith("packages/db/drizzle/") &&
          !file.startsWith("packages/db/seed/")
      )
      .filter((file) => sqlWrite.test(readFileSync(resolve(workspaceRoot, file), "utf8")))
      .toSorted();
    expect(writers).toEqual([
      ...devOnlyWriters,
      "packages/db/src/repositories/aiConfigRepository.ts",
      "packages/db/src/repositories/localModelRepository.ts"
    ]);
  });

  it("keeps the DEV-only writer refused when packaged and reporting its own write", () => {
    for (const file of devOnlyWriters) {
      const text = readFileSync(resolve(workspaceRoot, file), "utf8");
      expect(text).toContain("if (options.isPackaged)");
      expect(text).toContain("bumpAiConfigGeneration()");
    }
  });
});

describe("the AI service drops its cache after every write of the configuration", () => {
  const file = "apps/desktop/src/main/services/ai-service.ts";
  const source = ts.createSourceFile(
    file,
    readFileSync(resolve(workspaceRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const writers = new Set<string>([...aiConfigRepositoryWriters, ...localModelRepositoryWriters]);

  /** Methods of the service that call a repository writer, with whether they report it. */
  function writingMethods(): Array<{ name: string; invalidates: boolean }> {
    const found: Array<{ name: string; invalidates: boolean }> = [];
    const visitClass = (node: ts.Node) => {
      if (!ts.isClassDeclaration(node) || node.name?.text !== "AiService") {
        ts.forEachChild(node, visitClass);
        return;
      }
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name))
          continue;
        let writes = false;
        const visit = (inner: ts.Node) => {
          if (
            ts.isCallExpression(inner) &&
            ts.isPropertyAccessExpression(inner.expression) &&
            writers.has(inner.expression.name.text)
          ) {
            // `this.setTaskRoute(...)` is the service's own method, not the repository's.
            const receiver = inner.expression.expression.getText(source);
            if (!receiver.startsWith("this.") && !receiver.startsWith("input.")) writes = true;
          }
          ts.forEachChild(inner, visit);
        };
        visit(member.body);
        if (writes)
          found.push({
            name: member.name.text,
            invalidates: member.body.getText(source).includes("this.configCache.invalidate()")
          });
      }
    };
    visitClass(source);
    return found;
  }

  it("finds the methods that write", () => {
    expect(writingMethods().map((method) => method.name)).toEqual(
      expect.arrayContaining([
        "deleteProvider",
        "saveProvider",
        "createProfile",
        "updateProfile",
        "cloneProfile",
        "deleteProfile",
        "setTaskRoute",
        "setProfileTask",
        "seedTaskRoutes",
        "listModels",
        "executeRankerValidation"
      ])
    );
  });

  it("calls invalidate() in each of them", () => {
    expect(writingMethods().filter((method) => !method.invalidates)).toEqual([]);
  });
});
