/**
 * T63 (R1): the calibration-identity assertion that comes first in a measurement run and voids it
 * when it fails (F3 M2; tracked from F4 T88, formerly `.cache/f3/m2/scripts/r1-assert.ts`).
 *
 *   MEMORA_CACHE_ROOT=<main checkout>/.cache npx tsx scripts/relations/r1-assert.ts
 *       [--frozen <cache>/f3/freeze/frozen.json] [--s1-fallback <cache>/f3/m2/s1-fallback.json]
 *       [--helper native/mlx-helper/.build/release/memora-mlx-helper]
 *       [--db <scratch connection.json>] [--expect mlx|gguf] [--out <report.json>] [--label <text>]
 *
 * Paths default to the checkout this script is in and to $MEMORA_CACHE_ROOT (default: that
 * checkout's `.cache`). `discovery.neighbours` passes when it equals the frozen value or the value a
 * recorded S1 fallback (`--s1-fallback`) holds: D21's adoption rule records `{"discoveryNeighbours": 2}`
 * there when it flips the shipped value; a DEV run's `MEMORA_RELATIONS_DISCOVERY_NEIGHBOURS` changes
 * no shipped value and needs no record.
 *
 * STATIC half (no profile, no model, always): the runtime identity the shipped code computes for each
 * decider, with the product's own functions, must equal `frozen.json`'s:
 *   - MLX and GGUF: `rankerCalibrationIdentity` over the catalog entry (`findLocalModelCatalogEntry`), the
 *     current `relations.decide.instruction` (sha256), `relationsConfig.decide` (template, 600 characters,
 *     mean), then `findRelationCalibration(relationsConfig, identity)` must find the entry whose identity,
 *     `applyFrom`, `suggestFrom` and parity reference equal the frozen record's;
 *   - Decisions: `decisionsDesign` over the current `relations.decisions.instruction` and the typed limits
 *     gives the frozen `requestDesignSha256` (dd654932...) and finds the frozen entry;
 *   - the frozen config (instruction, template, bodyCharacters, rule, retrieval, maxShownPerNote) equals the
 *     shipped `relationsConfig`.
 * The MLX helper binary's sha256 (the M2 build) is compared with `frozen.parity.mlx.runtimeBuild`.
 *
 * DB half (`--db`, a finished or freshly started profile clone on a scratch sidecar, read-only): the
 * ranker rows of `local_models` must be `ready`, hold a decide validation that names the same runtime
 * build the helper has now, with the smoke passed and, when the build is not the one `frozen.json`
 * checked, a recorded parity check that passed (max |delta| <= 0.125). `--expect` names the ranker that
 * `class:decide` must resolve to in this profile (mlx by default); the route is read from
 * `ai_task_profile_routes` and `ai_profiles`.
 *
 * Exit 0 pass, 3 void (the run proves nothing: M2 stops and the orchestrator reports), 2 usage error.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  findLocalModelCatalogEntry,
  rankerCatalogArtifactSha256,
  resolveDecisionsLimits
} from "@app/ai";
import {
  closePgPool,
  createAiConfigRepository,
  createLocalModelRepository,
  createPgPool,
  operationRouteKey,
  workloadClassRouteKey
} from "@app/db";
import {
  findRelationCalibration,
  relationCalibrationIdentityKey,
  relationsConfig,
  type RelationCalibrationEntry
} from "@app/domain";

import { renderPrompt } from "../../apps/desktop/src/main/services/prompt-runtime.ts";
import {
  decisionsDesign,
  relationDecisionsInstruction
} from "../../apps/desktop/src/main/services/relations/decisions-identity.ts";
import {
  rankerCalibrationIdentity,
  relationDecideInstruction,
  relationDecideOperation
} from "../../apps/desktop/src/main/services/relations/relation-matcher.ts";

const { values } = parseArgs({
  options: {
    frozen: { type: "string" },
    "s1-fallback": { type: "string" },
    helper: { type: "string" },
    db: { type: "string" },
    expect: { type: "string" },
    out: { type: "string" },
    label: { type: "string" }
  }
});
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const repository = resolve(import.meta.dirname, "..", "..");
const cacheRoot = resolve(process.env.MEMORA_CACHE_ROOT ?? resolve(repository, ".cache"));
const frozenPath = resolve(values.frozen ?? resolve(cacheRoot, "f3/freeze/frozen.json"));
const helperPath = resolve(
  values.helper ?? resolve(repository, "native/mlx-helper/.build/release/memora-mlx-helper")
);
const expectRanker = values.expect ?? "mlx";
if (expectRanker !== "mlx" && expectRanker !== "gguf") {
  console.error("--expect must be mlx or gguf");
  process.exit(2);
}

interface FrozenCalibration {
  identity: Record<string, unknown>;
  applyFrom: number | null;
  suggestFrom: number | null;
  parity: unknown;
}
const frozen = JSON.parse(readFileSync(frozenPath, "utf8")) as {
  configHash: string;
  frozenAt: string;
  calibrationIdentity: string;
  calibrations: FrozenCalibration[];
  config: Record<string, unknown> & {
    instruction: { id: string; sha256: string };
    template: string;
    bodyCharacters: number;
    rule: string;
    retrieval: Record<string, unknown>;
    maxShownPerNote: number;
    discoveryNeighbours: number;
  };
  parity: {
    mlx: { runtimeBuild: string; baselineBuild: string };
    gguf: { runtimeBuild: string };
  };
};

const reasons: string[] = [];
const check = (ok: boolean, reason: string): boolean => {
  if (!ok) reasons.push(reason);
  return ok;
};
const frozenByKey = new Map(
  frozen.calibrations.map((entry) => [
    relationCalibrationIdentityKey(entry.identity as never),
    entry
  ])
);

// --- static half ----------------------------------------------------------------------------------------

const instruction = relationDecideInstruction();
const instructionSha256 = sha256(instruction);
check(
  instructionSha256 === frozen.config.instruction.sha256,
  `relations.decide.instruction hashes to ${instructionSha256}, frozen ${frozen.config.instruction.sha256}`
);
// renderPrompt must be a function of the catalog only; a second render equals the first.
check(
  renderPrompt("relations.decide.instruction") === instruction,
  "the instruction render is not stable"
);

const staticChecks: Record<string, unknown> = {};
for (const [kind, catalogId] of [
  ["mlx", "mlx-qwen3-reranker-0.6b"],
  ["gguf", "gguf-qwen3-reranker-0.6b-q8-0"]
] as const) {
  const entry = findLocalModelCatalogEntry(catalogId);
  if (!entry) {
    check(false, `${kind}: catalog entry ${catalogId} not found`);
    continue;
  }
  const identity = rankerCalibrationIdentity({
    instructionSha256,
    config: relationsConfig,
    model: {
      provider: "local",
      model: entry.id,
      runtimeKind: kind,
      repository: entry.repository,
      revision: entry.revision,
      quantization: entry.quantization,
      artifactSha256: rankerCatalogArtifactSha256(entry)
    }
  });
  const key = relationCalibrationIdentityKey(identity);
  const frozenEntry = frozenByKey.get(key) ?? null;
  const shipped = findRelationCalibration(relationsConfig, identity);
  const equalToFrozen = frozenEntry !== null;
  check(equalToFrozen, `${kind}: the runtime identity ${key} is not in frozen.json`);
  check(
    shipped !== null,
    `${kind}: relations-config.ts ships no calibration for the runtime identity`
  );
  const same = (field: "applyFrom" | "suggestFrom") =>
    shipped !== null &&
    frozenEntry !== null &&
    (shipped as RelationCalibrationEntry & Record<string, unknown>)[field] === frozenEntry[field];
  check(same("applyFrom"), `${kind}: shipped applyFrom differs from the frozen one`);
  check(same("suggestFrom"), `${kind}: shipped suggestFrom differs from the frozen one`);
  if (kind === "mlx")
    check(
      key === frozen.calibrationIdentity,
      `mlx: identity ${key} differs from frozen.calibrationIdentity`
    );
  staticChecks[kind] = {
    catalogId,
    identityKey: key,
    inFrozen: equalToFrozen,
    shippedFound: shipped !== null,
    applyFrom: shipped ? (shipped as unknown as { applyFrom: number | null }).applyFrom : null,
    suggestFrom: shipped ? (shipped as unknown as { suggestFrom: number | null }).suggestFrom : null
  };
}

// Decisions: the request design fingerprint is the parity of a remote decider.
{
  const design = decisionsDesign({
    instruction: relationDecisionsInstruction(),
    config: relationsConfig,
    limits: resolveDecisionsLimits()
  });
  const key = relationCalibrationIdentityKey(design.identity);
  const frozenEntry = frozenByKey.get(key) ?? null;
  check(frozenEntry !== null, `decisions: the runtime identity ${key} is not in frozen.json`);
  check(
    design.calibration !== null,
    "decisions: relations-config.ts ships no calibration for the runtime identity"
  );
  check(
    design.identity.requestDesignSha256 ===
      (frozen as unknown as { parity: { decisions: { requestDesignSha256: string } } }).parity
        .decisions.requestDesignSha256,
    `decisions: requestDesignSha256 ${design.identity.requestDesignSha256} differs from frozen.parity.decisions`
  );
  if (frozenEntry && design.calibration) {
    check(
      (design.calibration as unknown as { applyFrom: number | null }).applyFrom ===
        frozenEntry.applyFrom &&
        (design.calibration as unknown as { suggestFrom: number | null }).suggestFrom ===
          frozenEntry.suggestFrom,
      "decisions: shipped bands differ from the frozen ones"
    );
  }
  staticChecks.decisions = {
    identityKey: key,
    requestDesignSha256: design.identity.requestDesignSha256,
    inFrozen: frozenEntry !== null,
    shippedFound: design.calibration !== null,
    instructionSha256: design.instructionSha256,
    applyFrom: frozenEntry?.applyFrom ?? null,
    suggestFrom: frozenEntry?.suggestFrom ?? null
  };
}

// The frozen config against the shipped defaults.
const shippedConfig = {
  template: relationsConfig.decide.template,
  bodyCharacters: relationsConfig.decide.bodyCharacters,
  rule: relationsConfig.decide.rule,
  maxShownPerNote: relationsConfig.maxShownPerNote,
  discoveryNeighbours: relationsConfig.discovery.neighbours,
  retrieval: relationsConfig.retrieval
};
check(shippedConfig.template === frozen.config.template, "template differs from the frozen one");
check(shippedConfig.bodyCharacters === frozen.config.bodyCharacters, "bodyCharacters differs");
check(shippedConfig.rule === frozen.config.rule, "rule differs");
check(shippedConfig.maxShownPerNote === frozen.config.maxShownPerNote, "maxShownPerNote differs");
// S1's pre-registered fallback, or D21's rule (F4 C2), may raise discovery to two neighbours after the
// freeze; s1-fallback.json records it.
const s1FallbackPath = resolve(
  values["s1-fallback"] ?? resolve(cacheRoot, "f3/m2/s1-fallback.json")
);
const s1Fallback = existsSync(s1FallbackPath)
  ? (JSON.parse(readFileSync(s1FallbackPath, "utf8")) as { discoveryNeighbours: number })
  : null;
check(
  shippedConfig.discoveryNeighbours === frozen.config.discoveryNeighbours ||
    shippedConfig.discoveryNeighbours === s1Fallback?.discoveryNeighbours,
  "discoveryNeighbours differs (neither the frozen value nor S1's recorded fallback)"
);
for (const [name, value] of Object.entries(frozen.config.retrieval))
  check(
    (shippedConfig.retrieval as unknown as Record<string, unknown>)[name] === value,
    `retrieval.${name} differs from the frozen one`
  );

// The M2 build of the MLX helper.
let helperBuild: string | null = null;
try {
  helperBuild = `memora-mlx-helper@sha256:${sha256(readFileSync(helperPath))}`;
} catch {
  check(false, `the MLX helper ${helperPath} cannot be read`);
}
const helperEqualsFrozen = helperBuild === frozen.parity.mlx.runtimeBuild;

// --- DB half --------------------------------------------------------------------------------------------

interface RankerRow {
  catalogId: string;
  status: string;
  lastError: string | null;
  runtimeBuild: string | null;
  smokePassed: boolean | null;
  parityPassed: boolean | null;
  parityMaxDelta: number | null;
  validatedAt: string | null;
}
let dbChecks: Record<string, unknown> | null = null;
if (values.db) {
  const connection = JSON.parse(readFileSync(resolve(values.db), "utf8")) as {
    connectionString: string;
  };
  const pool = createPgPool({ connectionString: connection.connectionString, max: 1 });
  try {
    // The matcher's own route lookup for the ranker (`op:relation_decide`, then `class:decide`).
    const route = await createAiConfigRepository(pool).getDefaultTask(
      workloadClassRouteKey("decide"),
      undefined,
      [operationRouteKey(relationDecideOperation), workloadClassRouteKey("decide")]
    );
    const models = createLocalModelRepository(pool);
    const routedRecord = route?.localModelId ? await models.findById(route.localModelId) : null;
    const routed = routedRecord?.catalogId ?? null;
    const wanted =
      expectRanker === "mlx" ? "mlx-qwen3-reranker-0.6b" : "gguf-qwen3-reranker-0.6b-q8-0";
    check(routed === wanted, `class:decide resolves to ${routed ?? "nothing"}, expected ${wanted}`);
    const rows: RankerRow[] = [];
    for (const catalogId of ["mlx-qwen3-reranker-0.6b", "gguf-qwen3-reranker-0.6b-q8-0"]) {
      const record = await models.findByCatalogId(catalogId);
      if (!record) continue;
      const validation = (record.metadata as Record<string, unknown>).decideValidation as
        | {
            runtimeBuild?: string;
            smoke?: { passed?: boolean };
            parity?: { passed?: boolean; maxDelta?: number };
            validatedAt?: string;
          }
        | undefined;
      rows.push({
        catalogId,
        status: record.status,
        lastError: record.lastError ?? null,
        runtimeBuild: validation?.runtimeBuild ?? null,
        smokePassed: validation?.smoke?.passed ?? null,
        parityPassed: validation?.parity?.passed ?? null,
        parityMaxDelta: validation?.parity?.maxDelta ?? null,
        validatedAt: validation?.validatedAt ?? null
      });
    }
    const byId = new Map(rows.map((row) => [row.catalogId, row]));
    const judge = (row: RankerRow | undefined, kind: "mlx" | "gguf", required: boolean) => {
      if (!row) {
        check(!required, `${kind}: no ranker row in the profile`);
        return;
      }
      if (!required && row.runtimeBuild === null) return;
      const expectedBuild = kind === "mlx" ? helperBuild : frozen.parity.gguf.runtimeBuild;
      check(row.status === "ready", `${kind}: status ${row.status}`);
      check(row.lastError === null, `${kind}: last_error ${row.lastError}`);
      check(row.smokePassed === true, `${kind}: the smoke did not pass`);
      check(
        row.runtimeBuild === expectedBuild,
        `${kind}: the validation names ${row.runtimeBuild}, the build now is ${expectedBuild}`
      );
      const frozenBuild =
        kind === "mlx" ? frozen.parity.mlx.runtimeBuild : frozen.parity.gguf.runtimeBuild;
      if (row.runtimeBuild !== frozenBuild)
        check(
          row.parityPassed === true && (row.parityMaxDelta ?? Infinity) <= 0.125,
          `${kind}: a build other than the frozen one needs a recorded parity check that passed (max |delta| <= 0.125)`
        );
    };
    judge(byId.get("mlx-qwen3-reranker-0.6b"), "mlx", expectRanker === "mlx");
    judge(byId.get("gguf-qwen3-reranker-0.6b-q8-0"), "gguf", expectRanker === "gguf");
    dbChecks = { routed, expect: wanted, rows };
  } finally {
    await closePgPool(pool);
  }
}

const report = {
  task: "T63-R1",
  label: values.label ?? null,
  at: new Date().toISOString(),
  frozen: { path: frozenPath, configHash: frozen.configHash, frozenAt: frozen.frozenAt },
  helper: { path: helperPath, build: helperBuild, equalsFrozenBuild: helperEqualsFrozen },
  static: staticChecks,
  db: dbChecks,
  pass: reasons.length === 0,
  void: reasons.length > 0,
  reasons
};
if (values.out) {
  mkdirSync(dirname(resolve(values.out)), { recursive: true });
  writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
}
console.info(
  `R1 ${report.pass ? "PASS" : "VOID"}${values.label ? ` (${values.label})` : ""}: helper ${helperBuild?.slice(0, 40)}... ${helperEqualsFrozen ? "= frozen build" : "differs from the frozen build"}`
);
for (const reason of reasons) console.info(`  - ${reason}`);
process.exit(report.pass ? 0 : 3);
