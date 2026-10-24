import { z } from "zod";

// Who decides note relations (D16, setting `relations.deciderMode`) is defined with the matcher.
import type { NoteDeciderMode } from "./relations-config.js";

/**
 * Workload-class routes and the Local, Hybrid and Cloud presets (F3 D34, spec 3.6). Pure: the
 * presets say which model each class wants on a machine; the main process resolves those wants to
 * the profiles it has, so nothing here reads a database or the disk.
 */

/** The five workload classes a person routes (the scheduler's classes, `packages/ai/contracts`). */
export const aiClassIds = ["embed", "decide", "write-fast", "write-quality", "answer"] as const;
export const AiClassIdSchema = z.enum(aiClassIds);
export type AiClassId = z.infer<typeof AiClassIdSchema>;

/** The classes that hold generative writers; one local writer serves all of them (C6). */
export const aiWriteClassIds = ["write-fast", "write-quality", "answer"] as const;

export const aiPresetIds = ["local", "hybrid", "cloud"] as const;
export const AiPresetIdSchema = z.enum(aiPresetIds);
export type AiPresetId = z.infer<typeof AiPresetIdSchema>;

/** What the mode select shows: a preset, or the person's own routes. */
export const AiPresetModeSchema = z.enum([...aiPresetIds, "custom"]);
export type AiPresetMode = z.infer<typeof AiPresetModeSchema>;

/**
 * The operations that run the generative decide contract. Each states class `decide` and always
 * resolves through its own `op:` route onto a generative writer, never onto `class:decide`, which
 * holds validated rankers only (D16, R5): a missing route would send the contract to the ranker.
 */
export const generativeDecideOperations = [
  "note_matching_reranking",
  "note_matching_reranking_repair",
  "source_relation_matching",
  "relation_escalation"
] as const;
export type GenerativeDecideOperation = (typeof generativeDecideOperations)[number];

/** The catalog entries the presets name (checked against the catalog in `packages/ai`). */
export const presetCatalogIds = {
  embedding: "gguf-qwen3-embedding-0.6b-q8-0",
  rankerMlx: "mlx-qwen3-reranker-0.6b",
  rankerGguf: "gguf-qwen3-reranker-0.6b-q8-0",
  writerLarge: "mlx-qwen3.5-9b-4bit",
  writerSmall: "mlx-qwen3-4b-instruct-2507-4bit"
} as const;

/** Memory from which the Local preset's writer is the 9B model (C6), else the 4B one. */
export const largeLocalWriterMinimumMemoryBytes = 24 * 1024 ** 3;

export interface PresetMachine {
  platform: string;
  /** `process.arch` of the app. */
  arch: string;
  totalMemoryBytes: number;
  /**
   * The machine's own architecture when the hardware probe knows it (T97): an x64 app translated by
   * Rosetta on Apple silicon still runs the arm64 MLX helper. Absent, `arch` stands.
   */
  nativeArch?: string | undefined;
  /** The app runs translated (Rosetta). */
  translated?: boolean | undefined;
  /** The memory an Apple GPU may wire (the Metal working set), from the probe; absent when unknown. */
  workingSetBytes?: number | undefined;
}

/** Whether this machine runs the MLX implementations (macOS on Apple silicon). */
export function machineRunsMlx(
  machine: Pick<PresetMachine, "platform" | "arch" | "nativeArch">
): boolean {
  return machine.platform === "darwin" && (machine.nativeArch ?? machine.arch) === "arm64";
}

/** What a class of a preset wants. */
export type PresetTarget =
  /** A catalog model installed on this machine (a ranker only once validated for decide). */
  | { kind: "local-model"; catalogId: string }
  /** The person's remote profile: ChatGPT/Codex sign-in or an API key. */
  | { kind: "remote-writer" }
  /** The remote provider's embedding model, else the local embedding model. */
  | { kind: "provider-embedding"; fallbackCatalogId: string }
  /** Whichever ranker is installed and validated (decision 19). */
  | { kind: "installed-ranker" };

export interface AiPresetPlan {
  preset: AiPresetId;
  classes: Record<AiClassId, PresetTarget>;
  /** The writer behind the four generative-decide routes (always written). */
  generativeDecide: PresetTarget;
  /** The note decider mode the preset writes. */
  deciderMode: NoteDeciderMode;
}

export type AiPresetPlanResult =
  { ok: true; plan: AiPresetPlan } | { ok: false; reason: "local_requires_apple_silicon" };

function localWriter(machine: PresetMachine): PresetTarget {
  return {
    kind: "local-model",
    catalogId:
      machine.totalMemoryBytes >= largeLocalWriterMinimumMemoryBytes
        ? presetCatalogIds.writerLarge
        : presetCatalogIds.writerSmall
  };
}

/**
 * The plan of a preset on a machine. Local needs MLX (macOS on Apple silicon) and is refused
 * anywhere else; Hybrid and Cloud run everywhere, with the GGUF ranker where MLX does not run.
 * `class:decide` never holds a generative model in any preset: the generative decider lives in the
 * `generativeDecide` routes.
 */
export function planAiPreset(preset: AiPresetId, machine: PresetMachine): AiPresetPlanResult {
  const mlx = machineRunsMlx(machine);
  if (preset === "local" && !mlx) return { ok: false, reason: "local_requires_apple_silicon" };
  const embedLocal: PresetTarget = { kind: "local-model", catalogId: presetCatalogIds.embedding };
  const rankerLocal: PresetTarget = {
    kind: "local-model",
    catalogId: mlx ? presetCatalogIds.rankerMlx : presetCatalogIds.rankerGguf
  };
  if (preset === "local") {
    const writer = localWriter(machine);
    return {
      ok: true,
      plan: {
        preset,
        classes: {
          embed: embedLocal,
          decide: rankerLocal,
          "write-fast": writer,
          "write-quality": writer,
          answer: writer
        },
        generativeDecide: writer,
        deciderMode: "ranker"
      }
    };
  }
  const remote: PresetTarget = { kind: "remote-writer" };
  return {
    ok: true,
    plan: {
      preset,
      classes: {
        embed:
          preset === "hybrid"
            ? embedLocal
            : { kind: "provider-embedding", fallbackCatalogId: presetCatalogIds.embedding },
        decide: preset === "hybrid" ? rankerLocal : { kind: "installed-ranker" },
        "write-fast": remote,
        "write-quality": remote,
        answer: remote
      },
      generativeDecide: remote,
      deciderMode: preset === "hybrid" ? "ranker" : "ranker-else-generative"
    }
  };
}
