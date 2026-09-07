import { z } from "zod";

export const graphForceSettingsSchema = z.object({
  repulsion: z.number().finite().min(10).max(300),
  linkStrength: z.number().finite().min(0.05).max(1),
  linkDistance: z.number().finite().min(20).max(150),
  centerStrength: z.number().finite().min(0.005).max(0.12)
});

export type GraphForceSettings = z.infer<typeof graphForceSettingsSchema>;
export const defaultGraphForceSettings: GraphForceSettings = {
  repulsion: 80,
  linkStrength: 0.3,
  linkDistance: 55,
  centerStrength: 0.025
};

const layoutNodeSchema = z.object({ id: z.string(), x: z.number().finite(), y: z.number().finite() });
const layoutEdgeSchema = z.object({ source: z.string(), target: z.string(), weight: z.number().finite().nonnegative() });
export type GraphLayoutNode = z.infer<typeof layoutNodeSchema>;
export type GraphLayoutEdge = z.infer<typeof layoutEdgeSchema>;

export const graphLayoutCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init"),
    nodes: z.array(layoutNodeSchema),
    edges: z.array(layoutEdgeSchema),
    settings: graphForceSettingsSchema,
    restored: z.boolean()
  }),
  z.object({ type: z.literal("configure"), settings: graphForceSettingsSchema }),
  z.object({ type: z.literal("reheat") }),
  z.object({
    type: z.literal("drag"),
    id: z.string(), x: z.number().finite(), y: z.number().finite(),
    release: z.boolean(), sequence: z.number().int().nonnegative()
  })
]);
export type GraphLayoutCommand = z.infer<typeof graphLayoutCommandSchema>;

export const graphLayoutEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("positions"),
    positions: z.instanceof(Float32Array).refine((values) => values.every(Number.isFinite)),
    running: z.boolean(), sequence: z.number().int().nonnegative()
  }),
  z.object({ type: z.literal("error") })
]);
export type GraphLayoutEvent = z.infer<typeof graphLayoutEventSchema>;

export function graphLayoutRadius(count: number, distance: number): number {
  return Math.max(distance * 2, Math.sqrt(count) * distance * 0.6);
}

export function graphSeedFraction(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  return (hash >>> 0) / 4294967296;
}
