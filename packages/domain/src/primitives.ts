import { z } from "zod";

export const StableIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);

export type StableId = z.infer<typeof StableIdSchema>;

export const IsoDateTimeSchema = z.string().datetime();

export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const NonEmptyStringSchema = z.string().trim().min(1);

export const Sha256Schema = z
  .string()
  .regex(/^(sha256:)?[a-f0-9]{64}$/i);

export const JsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof JsonObjectSchema>;

export const ConfidenceScoreSchema = z.number().min(0).max(1);

export const ProgressRatioSchema = z.number().min(0).max(1);

export const OptionalMetadataSchema = JsonObjectSchema.default({});
