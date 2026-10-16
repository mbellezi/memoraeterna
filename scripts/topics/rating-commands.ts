// The three commands of `npm run topics:rating` (E4, F2 T30): sample, serve and score.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import pg from "pg";

import { resolveConnection } from "../kpi/connection.js";
import type { ResolvedConnection } from "../kpi/connection.js";
import { createEvalServer } from "../spikes/eval-server.js";
import type { SampleArgs } from "./rating-args.js";
import { assembleRating, drawProfileTopics, profileLabels, ratingProfiles } from "./rating-core.js";
import type { ManifestFile, NoteDetail, ProfileDraw, RatingProfile } from "./rating-core.js";
import { readNoteDetails, readRatingSnapshot } from "./rating-db.js";
import {
  RatingRunError,
  answerKeyOf,
  ratingAnswerPrefix,
  ratingFiles,
  readRun,
  resolveRunDirectory,
  writePage,
  writeRun
} from "./rating-run.js";
import {
  AnswersFileSchema,
  renderScoreMarkdown,
  renderScoreText,
  scoreRating
} from "./rating-score.js";
import type { RatingScore } from "./rating-score.js";

export type Log = (line: string) => void;

const where = (connection: ResolvedConnection): string =>
  `${connection.info.host}:${connection.info.port ?? "?"}/${connection.info.name}`;

/** Reads one profile in one read-only snapshot and draws its topics and their members. */
async function drawProfile(
  profile: RatingProfile,
  connection: ResolvedConnection,
  seed: number,
  log: Log
): Promise<{ draw: ProfileDraw; details: Map<string, NoteDetail> }> {
  const client = new pg.Client({
    connectionString: connection.connectionString,
    options: "-c default_transaction_read_only=on -c statement_timeout=120000",
    connectionTimeoutMillis: 10_000
  });
  await client.connect();
  try {
    log(`${profileLabels[profile]}: reading ${where(connection)}`);
    await client.query("begin transaction isolation level repeatable read read only");
    const snapshot = await readRatingSnapshot(client, profile);
    const draw = drawProfileTopics(snapshot, seed);
    const details = await readNoteDetails(
      client,
      draw.topics.flatMap((topic) => topic.memberIds)
    );
    await client.query("commit");
    return { draw, details };
  } finally {
    await client.end();
  }
}

/** Draws the sample from the three profiles and writes the run. Returns the manifest. */
export async function sampleRun(
  args: SampleArgs,
  log: Log,
  now: () => Date = () => new Date()
): Promise<{ directory: string; manifest: ManifestFile }> {
  const connections = {} as Record<RatingProfile, ResolvedConnection>;
  for (const profile of ratingProfiles) {
    connections[profile] = await resolveConnection(args.connections[profile]);
  }
  for (const [at, first] of ratingProfiles.entries()) {
    for (const second of ratingProfiles.slice(at + 1)) {
      if (where(connections[first]) === where(connections[second])) {
        log(
          `warning: ${profileLabels[first]} and ${profileLabels[second]} point at the same database (${where(connections[first])}).`
        );
      }
    }
  }
  const directory = resolveRunDirectory(args.run);
  const draws: ProfileDraw[] = [];
  const details = {} as Record<RatingProfile, Map<string, NoteDetail>>;
  for (const profile of ratingProfiles) {
    const read = await drawProfile(profile, connections[profile], args.seed, log);
    draws.push(read.draw);
    details[profile] = read.details;
  }
  const parts = assembleRating({ seed: args.seed, draws, details });
  const manifest = await writeRun(directory, {
    run: args.run,
    seed: args.seed,
    createdAt: now().toISOString(),
    parts
  });
  for (const profile of manifest.profiles) {
    log(
      `${profile.label}: tree ${profile.treeId}, config_hash ${profile.configHash}, generation ${profile.generation}`
    );
    if (profile.profile === "env-c" && !profile.areasApplied) {
      log("warning: ENV-C has no applied Areas change-set, so its level-1 topics are not Areas.");
    }
  }
  return { directory, manifest };
}

/** Starts the page server; resolves once it listens, with the URL to open. */
export async function serveRun(
  run: string,
  port: number
): Promise<{ url: string; answersPath: string; close: () => Promise<void> }> {
  const directory = resolveRunDirectory(run);
  const loaded = await readRun(directory);
  const pagePath = await writePage(loaded);
  const answersPath = join(directory, ratingFiles.answers);
  const server = createEvalServer({
    pagePath,
    outPath: answersPath,
    answerPrefix: ratingAnswerPrefix
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        new RatingRunError(
          error.code === "EADDRINUSE" ? `Port ${port} is in use; pass --port <n>.` : error.message
        )
      )
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    answersPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

/** Scores a run's answers, writes result.md and result.json, and returns the score. */
export async function scoreRun(
  run: string
): Promise<{ score: RatingScore; text: string; resultPath: string }> {
  const directory = resolveRunDirectory(run);
  const loaded = await readRun(directory, { needSealed: true });
  let raw: string;
  try {
    raw = await readFile(join(directory, ratingFiles.answers), "utf8");
  } catch {
    throw new RatingRunError("There are no answers yet (answers.json does not exist).");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RatingRunError("answers.json is not valid JSON.");
  }
  const answers = AnswersFileSchema.safeParse(parsed);
  if (!answers.success) throw new RatingRunError("answers.json is not a saved set of answers.");
  if (answers.data.key !== answerKeyOf(loaded.sampleSha256)) {
    throw new RatingRunError("answers.json belongs to a different sample than this run's.");
  }
  const score = scoreRating({
    sealed: loaded.sealed,
    answers: answers.data,
    passBar: loaded.manifest.passBar,
    sampleSize: loaded.manifest.sampleSize
  });
  const resultPath = join(directory, ratingFiles.resultMarkdown);
  await writeFile(
    resultPath,
    renderScoreMarkdown({
      score,
      manifest: loaded.manifest,
      sealed: loaded.sealed,
      answersSavedAt: answers.data.savedAt ?? null
    }),
    "utf8"
  );
  await writeFile(
    join(directory, ratingFiles.resultJson),
    `${JSON.stringify({ run: loaded.manifest.run, seed: loaded.manifest.seed, score }, null, 2)}\n`,
    "utf8"
  );
  return { score, text: renderScoreText(score), resultPath };
}
