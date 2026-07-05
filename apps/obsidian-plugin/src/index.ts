import { integrationContractVersion } from "@app/integration-contracts";

export const obsidianPluginClient = {
  kind: "obsidian-plugin",
  contractVersion: integrationContractVersion
} as const;
