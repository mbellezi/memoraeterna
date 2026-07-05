import { integrationContractVersion } from "@app/integration-contracts";

export const chromeExtensionClient = {
  kind: "chrome-extension",
  contractVersion: integrationContractVersion
} as const;
