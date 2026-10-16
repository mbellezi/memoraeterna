// Command line of `npm run topics:rating` (E4, F2 T30).
import { parseArgs } from "node:util";

import { ratingConfig, ratingProfiles } from "./rating-core.js";
import type { RatingProfile } from "./rating-core.js";
import { ratingRootDirectory } from "./rating-run.js";

export const defaultRatingPort = 5179;

export const ratingUsage = `Usage: npm run topics:rating -- <command> [options]

Commands
  sample --env-c <conn> --env-g <conn> --env-f <conn> --seed <n> [--run <name>]
      Draws the ${ratingConfig.sampleSize} topics (ENV-C: 6 Areas, 6 level-2, 8 at level 3 or deeper; ENV-G and
      ENV-F: 5 leaves each; live, named, with notes; never the root) and ${ratingConfig.membersPerTopic} random notes per
      topic, shuffles them together and writes <run>/ with manifest.json (the seed and each
      profile's topic_trees.config_hash), sample.json (what the page shows) and sealed.json (which
      dataset, level and naming source each topic is; the page never loads it).
      <conn> is the profile's dev-connection.json (or a postgres:// URL); it is opened read-only.
      The run name defaults to seed-<seed>. A run is written once: it is never drawn again.
  serve <run> [--port <n>]
      Serves the page on http://127.0.0.1:<port>/ (default ${defaultRatingPort}). Answers are saved as the owner goes
      to <run>/answers.json and restored after a reload. Stop it with Ctrl-C.
  score <run>
      Prints the coherent and well-named marginals and the number of topics rated both yes against
      the D20 bar (>= ${ratingConfig.passBar}/${ratingConfig.sampleSize}), per dataset and in total, and writes <run>/result.md and
      result.json. Exit code: 0 passes, 1 does not pass, 2 incomplete or an error.

<run> is a run name under ${ratingRootDirectory()} or the path of a run directory.
The page shows no level, dataset or naming source. The sealed file is for scoring only.`;

export interface SampleArgs {
  connections: Record<RatingProfile, string>;
  seed: number;
  run: string;
}

export type RatingCommand =
  | { kind: "help" }
  | ({ kind: "sample" } & SampleArgs)
  | { kind: "serve"; run: string; port: number }
  | { kind: "score"; run: string };

function wholeNumber(name: string, text: string, min: number, max: number): number {
  const value = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max}, got "${text}".`);
  }
  return value;
}

export function parseRatingArgs(argv: readonly string[]): RatingCommand {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      "env-c": { type: "string" },
      "env-g": { type: "string" },
      "env-f": { type: "string" },
      seed: { type: "string" },
      run: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: true
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === "help") return { kind: "help" };
  if (command === "sample") {
    if (rest.length > 0) throw new Error("sample takes no positional arguments.");
    const connections = {} as Record<RatingProfile, string>;
    for (const profile of ratingProfiles) {
      const value = values[profile];
      if (!value) throw new Error(`--${profile} is required.`);
      connections[profile] = value;
    }
    if (values.seed === undefined) throw new Error("--seed is required.");
    const seed = wholeNumber("--seed", values.seed, 0, 4_294_967_295);
    const run = values.run ?? `seed-${seed}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(run)) {
      throw new Error("--run must be a plain name (letters, digits, dot, dash, underscore).");
    }
    return { kind: "sample", connections, seed, run };
  }
  if (command === "serve" || command === "score") {
    if (rest.length !== 1) throw new Error(`${command} takes exactly one <run>.`);
    const run = rest[0] as string;
    if (command === "score") return { kind: "score", run };
    return {
      kind: "serve",
      run,
      port:
        values.port === undefined
          ? defaultRatingPort
          : wholeNumber("--port", values.port, 0, 65_535)
    };
  }
  throw new Error(`Unknown command "${command}".`);
}
