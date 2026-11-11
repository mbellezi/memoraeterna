import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  createPgPool,
  closePgPool,
  createMatchingEvaluationRepository
} from "../packages/db/src/index.ts";
import { readProfileDescriptor, scriptProfile } from "./lib/profile-arg.ts";

// The scratch profile of the pilot (`--profile <abs dir>`); the owner's DEV profile is never a default.
const { profilePath, outputDirectory: directory, rest } = await scriptProfile("pilot");
const descriptor = await readProfileDescriptor(profilePath);
const manifest = z
  .object({
    startedAt: z.string().datetime(),
    roundStartedAt: z.string().datetime().optional(),
    batchId: z.string().uuid().nullable(),
    ids: z.record(z.string(), z.string().uuid())
  })
  .parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")));
const pool = createPgPool({ connectionString: descriptor.connectionString, max: 1 });
try {
  const repository = createMatchingEvaluationRepository(pool);
  const progress = manifest.batchId
    ? await repository.progress(manifest.batchId, manifest.startedAt)
    : null;
  if (rest.includes("--snapshot")) {
    const snapshot = await repository.snapshot(
      Object.values(manifest.ids),
      manifest.roundStartedAt ?? manifest.startedAt
    );
    await writeFile(
      join(directory, "results.json"),
      JSON.stringify({ capturedAt: new Date().toISOString(), ...snapshot }, null, 2)
    );
    console.log(
      JSON.stringify({
        counts: Object.fromEntries(
          Object.entries(snapshot).map(([key, rows]) => [key, rows.length])
        )
      })
    );
  }
  console.log(
    JSON.stringify({
      usage: progress?.usage,
      runs: progress?.runs.map((run) => ({
        title: run.title,
        status: run.status,
        stage: run.current_stage,
        error: run.error
      }))
    })
  );
} finally {
  await closePgPool(pool);
}
