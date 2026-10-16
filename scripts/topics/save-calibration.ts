// `npx tsx scripts/topics/save-calibration.ts --db <connection.json | postgres url> [--file <json>] [--dry-run]`
//
// Stores T29a's calibrated gate values (T, tau, theta) as the active `topic_calibrations` row of
// each installed decider, through `topicTreeRepository.saveCalibration` (D9: the single writer).
// The input is `placement-adopted.json` of `scripts/topics/calibrate-placement.ts adopt`. Each
// decider key is computed exactly as the gate service does (`topic-gate.ts`: the installed
// model's runtime, repository, revision and quantization, and the `topic.gate.instruction`
// prompt), so a row matches the key of the decisions the profile records. Rows are saved only for
// the profile's active tree space, and only when it is the space the calibration was measured in.
// The profile must be running (its sidecar); nothing else is written, and the connection string
// is never printed.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  closePgPool,
  createLocalModelRepository,
  createPgPool,
  createTopicTreeRepository
} from "@app/db";
import { gateDeciderKey } from "@app/domain/topic-tree";
import { z } from "zod";

import { topicGateInstruction } from "../../apps/desktop/src/main/services/topic-tree/topic-prompts.js";
import { resolveConnection } from "../kpi/connection.js";
import { cacheRoot } from "./datasets.js";

export const saveCalibrationUsage = `Usage: npx tsx scripts/topics/save-calibration.ts --db <value> [options]

  --db <value>   DEV or profile connection file (database/dev-connection.json), a scratch
                 connection file or a postgres:// URL. The profile must be running.
  --file <json>  The adopted values (default <cache>/topics/calibration/placement-adopted.json).
  --dry-run      Print the rows without saving them.
  --help         Show this text.`;

const AdoptedGateSchema = z.looseObject({
  catalogId: z.string().min(1),
  runtime: z.enum(["mlx", "gguf"]),
  deciderKey: z.string().min(1),
  temperature: z.number().positive(),
  tau: z.number(),
  theta: z.number().min(0).max(1),
  how: z.string(),
  metrics: z.record(z.string(), z.unknown())
});

export const AdoptedFileSchema = z.looseObject({
  task: z.literal("T29a"),
  spaceKey: z.string().min(1),
  dataset: z.string().min(1),
  gates: z.array(AdoptedGateSchema)
});
export type AdoptedFile = z.infer<typeof AdoptedFileSchema>;

export interface InstalledRanker {
  catalogId: string;
  runtime: string;
  repository: string | null;
  revision: string | null;
  quantization: string | null;
}

export interface PlannedCalibration {
  catalogId: string;
  deciderKey: string;
  params: { gate: { temperature: number; tau: number; theta: number } };
  metrics: Record<string, unknown>;
}

export interface CalibrationPlan {
  rows: PlannedCalibration[];
  skipped: { catalogId: string; reason: "not-installed" }[];
  /** Installed rankers whose key differs from the offline one (another revision or quantization). */
  keyChanged: string[];
}

/** The rows to save: one per adopted decider installed in the profile, keyed as the gate keys it. */
export function planCalibrations(
  adopted: AdoptedFile,
  installed: readonly InstalledRanker[],
  instruction: string,
  hash: (text: string) => string
): CalibrationPlan {
  const plan: CalibrationPlan = { rows: [], skipped: [], keyChanged: [] };
  for (const gate of adopted.gates) {
    const model = installed.find((entry) => entry.catalogId === gate.catalogId);
    if (!model) {
      plan.skipped.push({ catalogId: gate.catalogId, reason: "not-installed" });
      continue;
    }
    const deciderKey = gateDeciderKey(
      {
        runtime: model.runtime,
        repository: model.repository,
        revision: model.revision,
        quantization: model.quantization,
        instruction
      },
      hash
    );
    if (deciderKey !== gate.deciderKey) plan.keyChanged.push(gate.catalogId);
    plan.rows.push({
      catalogId: gate.catalogId,
      deciderKey,
      params: { gate: { temperature: gate.temperature, tau: gate.tau, theta: gate.theta } },
      metrics: { ...gate.metrics, rule: gate.how, offlineDeciderKey: gate.deciderKey }
    });
  }
  return plan;
}

export function parseSaveCalibrationArgs(
  argv: readonly string[]
): { kind: "help" } | { kind: "run"; db: string; file: string; dryRun: boolean } {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      db: { type: "string" },
      file: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };
  if (!values.db) throw new Error("--db is required.");
  return {
    kind: "run",
    db: values.db,
    file: resolve(
      values.file ?? join(cacheRoot(), "topics", "calibration", "placement-adopted.json")
    ),
    dryRun: values["dry-run"] === true
  };
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function main(argv: readonly string[]): Promise<number> {
  const command = parseSaveCalibrationArgs(argv);
  if (command.kind === "help") {
    console.info(saveCalibrationUsage);
    return 0;
  }
  const adopted = AdoptedFileSchema.parse(JSON.parse(await readFile(command.file, "utf8")));
  const connection = await resolveConnection(command.db);
  const pool = createPgPool({ connectionString: connection.connectionString, max: 2 });
  try {
    const trees = createTopicTreeRepository(pool);
    const tree = await trees.activeTree();
    if (!tree) throw new Error("The profile has no active topic tree.");
    if (tree.spaceKey !== adopted.spaceKey) {
      throw new Error(
        `The active tree's space ${tree.spaceKey.slice(0, 12)} is not the calibrated space ` +
          `${adopted.spaceKey.slice(0, 12)}; nothing saved.`
      );
    }
    const models = createLocalModelRepository(pool);
    const installed: InstalledRanker[] = [];
    for (const gate of adopted.gates) {
      const model = await models.findByCatalogId(gate.catalogId);
      if (model) installed.push(model);
    }
    const plan = planCalibrations(adopted, installed, topicGateInstruction(), sha256);
    for (const skipped of plan.skipped) {
      console.info(`[topics:calibration] ${skipped.catalogId}: not installed, skipped`);
    }
    for (const catalogId of plan.keyChanged) {
      console.info(
        `[topics:calibration] ${catalogId}: the installed artifact differs from the calibrated one`
      );
    }
    for (const row of plan.rows) {
      const gate = row.params.gate;
      const label = `${row.catalogId}: T ${gate.temperature}, tau ${gate.tau}, theta ${gate.theta}`;
      if (command.dryRun) {
        console.info(`[topics:calibration] would save ${label}`);
        continue;
      }
      const saved = await trees.saveCalibration({
        spaceKey: tree.spaceKey,
        deciderKey: row.deciderKey,
        params: row.params,
        metrics: row.metrics,
        dataset: adopted.dataset,
        activate: true
      });
      console.info(`[topics:calibration] saved ${label} (row ${saved.id}, active)`);
    }
    return plan.rows.length > 0 ? 0 : 1;
  } finally {
    await closePgPool(pool);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[topics:calibration] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
      );
      process.exitCode = 1;
    }
  );
}
