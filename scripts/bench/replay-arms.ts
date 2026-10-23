/**
 * The arms of the record-only local-writer benchmark (F4 T69, decisions 25 and 26) and the parameters a
 * call carries on each. Nothing here adopts a model: an arm is a folder, a runtime and a parameter set,
 * and the parameters are the product's own for that model family where the catalog has one.
 */
import { AiModelParametersSchema } from "@app/domain";
import { findLocalModelCatalogEntry } from "@app/ai";

import { withAiTaskParameterDefaults } from "../../apps/desktop/src/main/services/ai-task-parameters.js";
import type { ReplayCall } from "./contracts/types.ts";

export interface ArmSpec {
  id: string;
  label: string;
  runtime: "mlx" | "gguf";
  /** The catalog entry of the model when it has one (an installed model); null for a downloaded one. */
  catalogId: string | null;
  /** Where the model folder is, under the data root (`.cache`); `--model-dir` replaces it. */
  directory: string;
  /** The model's own generation parameters, as the product's model record would carry them. */
  parameters: Record<string, unknown>;
  /** Where `parameters` come from, for the manifest. */
  parameterSource: string;
  /** Rates the plan projects hours with until a run measures its own (an assumption, not a result). */
  assumed: { decodeTps: number; prefillTps: number; source: string };
}

function catalogWriter(id: string) {
  const entry = findLocalModelCatalogEntry(id);
  if (!entry) throw new Error(`The local model catalog lost the writer ${id}.`);
  return entry;
}

const nine = catalogWriter("mlx-qwen3.5-9b-4bit");
const four = catalogWriter("mlx-qwen3-4b-instruct-2507-4bit");
const gemma = catalogWriter("mlx-gemma-4-12b-it-4bit");

/** The installed writers live in a profile's `local-models` folder; the profile's files are only read. */
const installed = (catalogId: string) => `profiles/env-g-m2b/local-models/${catalogId}`;

export const arms: Readonly<Record<string, ArmSpec>> = {
  m4b: {
    id: "m4b",
    label: "Qwen3-4B-Instruct-2507 4-bit (installed small writer)",
    runtime: "mlx",
    catalogId: four.id,
    directory: installed(four.id),
    parameters: { ...four.defaultParameters },
    parameterSource: `catalog ${four.id} defaultParameters`,
    assumed: {
      decodeTps: 70,
      prefillTps: 900,
      source: "assumption: about 1.75 times the 9B rate; nothing measured"
    }
  },
  m9b4: {
    id: "m9b4",
    label: "Qwen3.5-9B 4-bit (installed large writer)",
    runtime: "mlx",
    catalogId: nine.id,
    directory: installed(nine.id),
    parameters: { ...nine.defaultParameters },
    parameterSource: `catalog ${nine.id} defaultParameters`,
    assumed: {
      decodeTps: 40,
      prefillTps: 500,
      source:
        "assumption near the F3 soak24 average of 14.5 s per structured call (17,089 s over 1,178 calls)"
    }
  },
  "q36-35b-a3b": {
    id: "q36-35b-a3b",
    label: "Qwen3.6-35B-A3B 4-bit (downloaded, mlx-community, rev 38740b84)",
    runtime: "mlx",
    catalogId: null,
    directory: "models/qwen3.6-35b-a3b-4bit-mlx",
    parameters: { ...nine.recommendedParameters!.nonReasoning },
    parameterSource: `catalog ${nine.id} recommendedParameters.nonReasoning (same Qwen 3.x family; the 3.6 card was not read)`,
    assumed: {
      decodeTps: 80,
      prefillTps: 1_000,
      source:
        "assumption below the spike section 5 estimate of about 94 tok/s at 8-bit; nothing measured"
    }
  },
  "gemma4-26b-a4b": {
    id: "gemma4-26b-a4b",
    label: "Gemma 4 26B-A4B 4-bit (downloaded, mlx-community, rev 0d77464e)",
    runtime: "mlx",
    catalogId: null,
    directory: "models/gemma-4-26b-a4b-it-4bit-mlx",
    parameters: { ...gemma.defaultParameters },
    parameterSource: `catalog ${gemma.id} defaultParameters (the Gemma 4 family's)`,
    assumed: {
      decodeTps: 79,
      prefillTps: 900,
      source:
        "the spike section 4 figure for the plain 4-bit on an M4 Max 32c (79.5 tok/s), cited there, not measured here"
    }
  }
};

/** An arm for any folder: the harness serves another runtime build or model without a code change. */
export function customArm(input: {
  label: string;
  runtime: "mlx" | "gguf";
  modelDir: string;
  parameters?: Record<string, unknown>;
}): ArmSpec {
  return {
    id: "custom",
    label: input.label,
    runtime: input.runtime,
    catalogId: null,
    directory: input.modelDir,
    parameters: input.parameters ?? { ...nine.defaultParameters },
    parameterSource: input.parameters ? "--param" : `catalog ${nine.id} defaultParameters`,
    assumed: { decodeTps: 40, prefillTps: 500, source: "default for a custom arm (assumption)" }
  };
}

/** `AiWorkloadClass` a contract's caller states; the others leave it to the task type, as the product does. */
export function workloadClassOf(call: Pick<ReplayCall, "contract">) {
  switch (call.contract) {
    case "topic-names":
    case "overview":
    case "typing":
      return "write-fast" as const;
    case "confirmation":
      return "write-quality" as const;
    default:
      return undefined;
  }
}

/**
 * The parameters the service would send for this call: the model's own over the task defaults of
 * `withAiTaskParameterDefaults` (local model), the output allowance of the caller as a ceiling on
 * `maxTokens`, and the harness seed so two runs of one arm can be compared.
 */
export function effectiveParameters(
  arm: ArmSpec,
  call: Pick<ReplayCall, "taskType" | "operation" | "maxOutputTokens">,
  options: { seed?: number | undefined; overrides?: Record<string, unknown> | undefined } = {}
): Record<string, unknown> {
  const parameters = AiModelParametersSchema.parse(
    withAiTaskParameterDefaults(call.taskType, { ...arm.parameters, ...options.overrides }, true, {
      operation: call.operation
    })
  );
  if (call.maxOutputTokens !== undefined)
    parameters.maxTokens = Math.min(
      parameters.maxTokens ?? 16_384,
      Math.max(1, Math.floor(call.maxOutputTokens))
    );
  if (options.seed !== undefined) parameters.seed = options.seed;
  return parameters;
}
