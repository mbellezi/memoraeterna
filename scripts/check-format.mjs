import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const [{ stdout: changedStdout }, { stdout: untrackedStdout }] = await Promise.all([
  execFileAsync("git", ["diff", "--name-only", "--diff-filter=ACMR", "HEAD", "--"], { cwd: root }),
  execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root })
]);

const checkedExtensions = new Set([
  ".css",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx"
]);

const failures = [];

for (const file of new Set(`${changedStdout}\n${untrackedStdout}`.split("\n").filter(Boolean))) {
  const extension = file.slice(file.lastIndexOf("."));
  if (!checkedExtensions.has(extension)) {
    continue;
  }

  const content = await readFile(resolve(root, file), "utf8");
  if (!content.endsWith("\n")) {
    failures.push(`${file}: missing final newline`);
  }
  if (/[ \t]$/mu.test(content)) {
    failures.push(`${file}: trailing whitespace`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
