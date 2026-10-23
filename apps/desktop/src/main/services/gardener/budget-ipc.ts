import type { IpcMain } from "electron";
import { ImportEstimateInputSchema, ImportEstimateSchema, type ImportEstimate } from "@app/domain";

import { ipcChannels } from "../../../shared/ipc.js";
import type { ImportRouteModel, RemoteBudget } from "./remote-budget.js";

/**
 * The RemoteBudget over IPC (F4 D14, spec 3.3): `budget.estimateImport` prices an import plan for the
 * import plan chip (T96 renders it). The request and the answer are validated at the boundary.
 */
export function registerBudgetIpc(
  ipc: Pick<IpcMain, "handle">,
  budget: Pick<RemoteBudget, "estimateImport">,
  routeModel: ImportRouteModel
): void {
  ipc.handle(
    ipcChannels.budgetEstimateImport,
    async (_event, input: unknown): Promise<ImportEstimate> =>
      ImportEstimateSchema.parse(
        await budget.estimateImport(ImportEstimateInputSchema.parse(input), { routeModel })
      )
  );
}
