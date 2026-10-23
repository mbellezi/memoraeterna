// The Knowledge controls (F4 D13, plan 4.3): autonomy, the monthly remote spend cap and pause, plus
// the tree shape and the "only idle" and "only on AC power" options. One setting, read tolerantly:
// a value that no longer parses falls back to its default field by field, so one damaged field never
// resets the others, and keys this version does not know are dropped.
import { z } from "zod";

import { defaultGardenerConfig } from "../gardener-config.js";
import { topicTreePresets } from "../topic-tree/config.js";

/** The `settings` key that holds the controls. */
export const knowledgeControlsSettingKey = "knowledge.controls.v1";

/**
 * Autonomy (D12): `off` runs no generative or remote background work (placement, local deciding,
 * hard repairs and deterministic lints still run); `suggest` proposes what `auto` would apply;
 * `auto` applies with undo. The always-reviewed set stays reviewed in every mode.
 */
export const gardenerAutonomyLevels = ["off", "suggest", "auto"] as const;
export const GardenerAutonomySchema = z.enum(gardenerAutonomyLevels);
export type GardenerAutonomy = z.infer<typeof GardenerAutonomySchema>;

export const TreeShapeSchema = z.enum(topicTreePresets);
export type TreeShape = z.infer<typeof TreeShapeSchema>;

const capUsd = z.number().finite().min(0).max(defaultGardenerConfig.controls.monthlyCapMaxUsd);

const defaults = {
  autonomy: "auto",
  monthlyCapUsd: defaultGardenerConfig.controls.defaultMonthlyCapUsd,
  paused: false,
  treeShape: "balanced",
  onlyIdle: false,
  onlyOnAc: false
} as const;

/** The controls as stored and read; every field has its default (Q3). */
export const KnowledgeControlsSchema = z.object({
  autonomy: GardenerAutonomySchema.default(defaults.autonomy),
  monthlyCapUsd: capUsd.default(defaults.monthlyCapUsd),
  paused: z.boolean().default(defaults.paused),
  treeShape: TreeShapeSchema.default(defaults.treeShape),
  onlyIdle: z.boolean().default(defaults.onlyIdle),
  onlyOnAc: z.boolean().default(defaults.onlyOnAc)
});
export type KnowledgeControls = z.infer<typeof KnowledgeControlsSchema>;

/** A change to the controls: any subset of the fields, nothing else. */
export const KnowledgeControlsUpdateSchema = z
  .object({
    autonomy: GardenerAutonomySchema,
    monthlyCapUsd: capUsd,
    paused: z.boolean(),
    treeShape: TreeShapeSchema,
    onlyIdle: z.boolean(),
    onlyOnAc: z.boolean()
  })
  .partial()
  .strict();
export type KnowledgeControlsUpdate = z.infer<typeof KnowledgeControlsUpdateSchema>;

export const defaultKnowledgeControls: Readonly<KnowledgeControls> = Object.freeze(
  KnowledgeControlsSchema.parse({})
);

const tolerantSchema = z.object({
  autonomy: KnowledgeControlsSchema.shape.autonomy.catch(defaults.autonomy),
  monthlyCapUsd: KnowledgeControlsSchema.shape.monthlyCapUsd.catch(defaults.monthlyCapUsd),
  paused: KnowledgeControlsSchema.shape.paused.catch(defaults.paused),
  treeShape: KnowledgeControlsSchema.shape.treeShape.catch(defaults.treeShape),
  onlyIdle: KnowledgeControlsSchema.shape.onlyIdle.catch(defaults.onlyIdle),
  onlyOnAc: KnowledgeControlsSchema.shape.onlyOnAc.catch(defaults.onlyOnAc)
});

/** Reads a stored value: missing or damaged fields take their defaults, unknown keys are dropped. */
export function readKnowledgeControls(stored: unknown): KnowledgeControls {
  const parsed = tolerantSchema.safeParse(
    stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}
  );
  return parsed.success ? parsed.data : { ...defaultKnowledgeControls };
}

/** The controls after a change; the change is validated first. */
export function applyKnowledgeControlsUpdate(
  current: KnowledgeControls,
  update: unknown
): KnowledgeControls {
  return KnowledgeControlsSchema.parse({
    ...current,
    ...KnowledgeControlsUpdateSchema.parse(update)
  });
}

/** The fields whose values differ between two readings of the controls. */
export function changedKnowledgeControls(
  before: KnowledgeControls,
  after: KnowledgeControls
): Array<keyof KnowledgeControls> {
  return (Object.keys(after) as Array<keyof KnowledgeControls>).filter(
    (key) => before[key] !== after[key]
  );
}
