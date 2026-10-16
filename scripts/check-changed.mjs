// The economical check (RULES.md section 3): only what the changed files touch.
//
//   npm run check:changed                  files changed since the branch left `refactoring`, plus the
//                                          working tree (staged, unstaged and untracked)
//   npm run check:changed -- --base <ref>  files changed since <ref>, plus the working tree
//   npm run check:changed -- --list        print the changed files and stop
//
// Steps: whitespace and final newline, Prettier and ESLint on the changed files; the incremental
// `tsc -b` (only changed projects and their dependents rebuild) plus the script projects that hold
// changed scripts; the tests related to the changed files (`vitest related`); the ratchet and the
// contrast check (both take well under a second). The full `npm run check` closes a stage.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";

const root = process.cwd();
const { values } = parseArgs({
  options: { base: { type: "string" }, list: { type: "boolean", default: false } }
});

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const lines = (text) => text.split("\n").filter(Boolean);

function baseRef() {
  if (values.base) return git("rev-parse", "--verify", values.base);
  try {
    return git("merge-base", "HEAD", "refactoring");
  } catch {
    return git("rev-parse", "HEAD");
  }
}

const base = baseRef();
const changed = [
  ...new Set([
    ...lines(git("diff", "--name-only", "--diff-filter=ACMR", base, "--")),
    ...lines(git("ls-files", "--others", "--exclude-standard"))
  ])
]
  .filter((file) => existsSync(join(root, file)))
  .sort();

console.log(`check:changed against ${base.slice(0, 7)}: ${changed.length} changed file(s)`);
if (values.list) {
  for (const file of changed) console.log(`  ${file}`);
  process.exit(0);
}
if (changed.length === 0) process.exit(0);

const bin = (name) => join(root, "node_modules", ".bin", name);
const failures = [];
function step(name, command, args) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const ok = result.status === 0;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} (${seconds} s)`);
  if (!ok) failures.push(name);
}

// Whitespace and final newline (the part of `format:check` that Prettier does not cover).
const hygieneExtensions = new Set([".css", ".json", ".md", ".mjs", ".ts", ".tsx"]);
const hygiene = [];
for (const file of changed.filter((file) => hygieneExtensions.has(extname(file)))) {
  const content = readFileSync(join(root, file), "utf8");
  if (!content.endsWith("\n")) hygiene.push(`${file}: missing final newline`);
  if (/[ \t]$/mu.test(content)) hygiene.push(`${file}: trailing whitespace`);
}
for (const problem of hygiene) console.error(problem);
console.log(`${hygiene.length === 0 ? "ok  " : "FAIL"} whitespace and final newline`);
if (hygiene.length > 0) failures.push("whitespace and final newline");

step("prettier", bin("prettier"), ["--check", "--ignore-unknown", ...changed]);

const code = changed.filter((file) =>
  [".ts", ".tsx", ".mjs", ".js", ".cjs"].includes(extname(file))
);

// `tsc -b` is incremental: unchanged projects are skipped, a changed package rebuilds its dependents.
step("typecheck (tsc -b)", bin("tsc"), ["-b", "--pretty", "false"]);
const scriptProjects = new Set();
for (const file of code.filter((file) => file.startsWith("scripts/"))) {
  let directory = dirname(file);
  while (directory !== "scripts" && !existsSync(join(root, directory, "tsconfig.json"))) {
    directory = dirname(directory);
  }
  scriptProjects.add(join(directory, "tsconfig.json"));
}
// Scripts import the packages and the desktop app, so a source change can break them too.
if (code.some((file) => /^(apps|packages)\//u.test(file)))
  scriptProjects.add("scripts/tsconfig.json");
for (const project of [...scriptProjects]
  .filter((project) => existsSync(join(root, project)))
  .sort()) {
  step(`typecheck (${project})`, bin("tsc"), ["-p", project, "--pretty", "false"]);
}

if (code.length > 0) step("eslint", bin("eslint"), code);

step("tests (vitest related)", bin("vitest"), [
  "related",
  "--run",
  "--passWithNoTests",
  ...changed
]);
step("ratchet", process.execPath, ["scripts/quality-ratchet.mjs"]);
step("contrast", bin("tsx"), ["scripts/contrast/check-contrast.ts"]);

if (failures.length > 0) {
  console.error(`check:changed failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("check:changed passed (the full `npm run check` still closes the stage)");
