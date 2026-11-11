// Quality ratchet: fails when a tracked metric grows beyond its recorded value.
//
//   node scripts/quality-ratchet.mjs            check the working tree
//   node scripts/quality-ratchet.mjs --update   lower recorded values that improved
//
// Recorded values live in quality-ratchet.json. `--update` only ever lowers a
// value (or records a metric that has no value yet); it never raises one. A
// metric that grew must be fixed in the code, not recorded. A metric with a
// fixed `budget` (rule lines) is not recorded: it may move freely up to the budget,
// so an essential rule can be added without forcing an unrelated deletion.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ratchetPath = resolve(root, "quality-ratchet.json");

const args = process.argv.slice(2);
const unknownArgs = args.filter((arg) => arg !== "--update");
if (unknownArgs.length > 0) {
  console.error(
    `Unknown argument: ${unknownArgs.join(" ")}\nUsage: quality-ratchet.mjs [--update]`
  );
  process.exit(2);
}
const update = args.includes("--update");

const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  }
)
  .split("\0")
  .filter((file) => file && existsSync(resolve(root, file)));

const extensionOf = (file) => file.slice(file.lastIndexOf("."));
const isTestFile = (file) =>
  /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) ||
  /(^|\/)(__tests__|__fixtures__|__snapshots__|test-fixtures)\//u.test(file);
const isRenderer = (file) => file.startsWith("apps/desktop/src/renderer/");
const isProductSource = (file) => /^(apps|packages)\/[^/]+\/src\//u.test(file);
const codeExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const countMatches = (pattern) => (text) => text.match(pattern)?.length ?? 0;
const countLines = (text) => {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
};

// Each metric counts occurrences per file; the total is compared with the record.
const metrics = [
  {
    name: "rawPaletteClasses",
    description: "raw slate/cyan/gray palette classes in renderer TSX (non-test)",
    appliesTo: (file) => isRenderer(file) && file.endsWith(".tsx") && !isTestFile(file),
    count: countMatches(
      /(?<![\w-])(?:text|bg|border|ring|fill|stroke)-(?:slate|cyan|gray)-[0-9]{2,3}/gu
    )
  },
  {
    name: "arbitraryFontSizes",
    description: "arbitrary text-[Npx] font sizes in renderer sources (non-test)",
    appliesTo: (file) =>
      isRenderer(file) &&
      [".tsx", ".ts", ".css", ".html"].includes(extensionOf(file)) &&
      !isTestFile(file),
    count: countMatches(/text-\[[0-9.]+px\]/gu)
  },
  {
    name: "windowDialogs",
    description: "window.confirm/alert/prompt calls in the renderer (non-test)",
    appliesTo: (file) =>
      isRenderer(file) && [".tsx", ".ts"].includes(extensionOf(file)) && !isTestFile(file),
    count: countMatches(/(?<![\w$.])(?:window\.)?(?:confirm|alert|prompt)\s*\(/gu)
  },
  {
    name: "rendererSetIntervals",
    description: "setInterval calls in renderer code (non-test)",
    appliesTo: (file) =>
      isRenderer(file) && [".tsx", ".ts"].includes(extensionOf(file)) && !isTestFile(file),
    count: countMatches(/\bsetInterval\s*\(/gu)
  },
  {
    name: "productLinesOver200",
    description: "product code lines longer than 200 characters (apps/*/src, packages/*/src)",
    appliesTo: (file) =>
      isProductSource(file) && codeExtensions.has(extensionOf(file)) && !isTestFile(file),
    count: (text) => text.split("\n").filter((line) => line.length > 200).length
  },
  {
    name: "ruleLines",
    description: "total lines of RULES.md and rules/**/*.md",
    // 900 while the refactoring phases run (owner 2026-11-11); back to 800 when F7 closes.
    budget: 900,
    appliesTo: (file) => file === "RULES.md" || (file.startsWith("rules/") && file.endsWith(".md")),
    count: countLines
  }
];

const sourceCache = new Map();
const readSource = (file) => {
  if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(resolve(root, file), "utf8"));
  return sourceCache.get(file);
};

const measured = metrics.map((metric) => {
  const byFile = [];
  let total = 0;
  for (const file of files) {
    if (!metric.appliesTo(file)) continue;
    const count = metric.count(readSource(file));
    if (count > 0) byFile.push([file, count]);
    total += count;
  }
  byFile.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { ...metric, total, byFile };
});

let recorded = {};
if (existsSync(ratchetPath)) {
  recorded = JSON.parse(readFileSync(ratchetPath, "utf8"));
  const known = new Set(metrics.map((metric) => metric.name));
  const stray = Object.keys(recorded).filter((name) => !known.has(name));
  for (const metric of metrics) if (metric.budget !== undefined) delete recorded[metric.name];
  if (stray.length > 0) {
    console.error(`quality-ratchet.json has unknown metrics: ${stray.join(", ")}`);
    process.exit(2);
  }
} else if (!update) {
  console.error("quality-ratchet.json is missing. Run with --update to record the current values.");
  process.exit(2);
}

const next = {};
let failed = false;
let changed = false;
const lines = [];

for (const metric of measured) {
  if (metric.budget !== undefined) {
    if (metric.total > metric.budget) {
      failed = true;
      lines.push(
        `  FAIL      ${metric.name}: ${metric.total} > budget ${metric.budget}  (${metric.description})`
      );
    } else {
      lines.push(`  ok        ${metric.name}: ${metric.total} (budget ${metric.budget})`);
    }
    continue;
  }
  const limit = recorded[metric.name];
  if (limit === undefined) {
    if (update) {
      next[metric.name] = metric.total;
      changed = true;
      lines.push(`  recorded  ${metric.name}: ${metric.total}  (${metric.description})`);
    } else {
      failed = true;
      lines.push(`  MISSING   ${metric.name}: current ${metric.total}, no recorded value`);
    }
    continue;
  }
  next[metric.name] = limit;
  if (metric.total > limit) {
    failed = true;
    lines.push(
      `  FAIL      ${metric.name}: ${metric.total} > recorded ${limit}  (${metric.description})`
    );
    for (const [file, count] of metric.byFile.slice(0, 10))
      lines.push(`              ${count}  ${file}`);
  } else if (metric.total < limit) {
    if (update) {
      next[metric.name] = metric.total;
      changed = true;
      lines.push(`  lowered   ${metric.name}: ${limit} -> ${metric.total}`);
    } else {
      lines.push(
        `  improved  ${metric.name}: ${metric.total} < recorded ${limit} (run: npm run ratchet -- --update)`
      );
    }
  } else {
    lines.push(`  ok        ${metric.name}: ${metric.total}`);
  }
}

console.log(lines.join("\n"));

if (update && changed) {
  const ordered = Object.fromEntries(
    metrics
      .filter((metric) => metric.budget === undefined)
      .map((metric) => [metric.name, next[metric.name]])
  );
  writeFileSync(ratchetPath, `${JSON.stringify(ordered, null, 2)}\n`);
  console.log("quality-ratchet.json updated.");
}

if (failed) {
  console.error("Quality ratchet failed: a metric grew beyond its recorded value.");
  process.exitCode = 1;
}
