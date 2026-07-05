import { z } from "zod";

export const LanguageCodes = ["en", "pt-BR", "it", "fr", "es"] as const;

export const LanguageCodeSchema = z.enum(LanguageCodes);

export type LanguageCode = z.infer<typeof LanguageCodeSchema>;
