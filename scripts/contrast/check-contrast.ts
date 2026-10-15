// Contrast check for the renderer design tokens (part of `npm run check`).
//
//   tsx scripts/contrast/check-contrast.ts              fail on any pair below its minimum ratio
//   tsx scripts/contrast/check-contrast.ts --verbose    also list every pair with its ratio
//   tsx scripts/contrast/check-contrast.ts <tokens.css> check another stylesheet
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkTokens, formatReport } from "./contrast.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const paths = args.filter((arg) => !arg.startsWith("--"));
const tokensPath = resolve(root, paths[0] ?? "apps/desktop/src/renderer/tokens.css");

const result = checkTokens(readFileSync(tokensPath, "utf8"));
console.log(`${tokensPath.replace(`${root}/`, "")}\n${formatReport(result, verbose)}`);
if (result.failures.length > 0 || result.problems.length > 0) process.exitCode = 1;
