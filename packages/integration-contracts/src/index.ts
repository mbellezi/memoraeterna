import { z } from "zod";

export const integrationContractVersion = "0.1.0";

export const integrationContractVersionSchema = z.literal(integrationContractVersion);
export type IntegrationContractVersion = z.infer<typeof integrationContractVersionSchema>;

export const integrationClientKindSchema = z.enum(["chrome-extension", "obsidian-plugin"]);
export type IntegrationClientKind = z.infer<typeof integrationClientKindSchema>;

export const integrationClientIdentitySchema = z.object({
  kind: integrationClientKindSchema,
  name: z.string().min(1),
  contractVersion: integrationContractVersionSchema
});
export type IntegrationClientIdentity = z.infer<typeof integrationClientIdentitySchema>;
