import type { IpcMain } from "electron";
import {
  BudgetSnapshotSchema,
  ImportEstimateInputSchema,
  ImportEstimateSchema,
  type BudgetSnapshot,
  type ImportEstimate
} from "@app/domain";
import { z } from "zod";

import { ipcChannels } from "../../../shared/ipc.js";
import type { ImportRouteModel, RemoteBudget } from "./remote-budget.js";

/**
 * The RemoteBudget over IPC (F4 D14, spec 3.3): `budget.estimateImport` prices an import plan for the
 * import plan chip (T96 renders it); `budget.snapshot` reads the meters (the Activity drawer's budget
 * section) and `budget.continue` is the Activity's "continue" past the pause share (the rows the
 * pause held run again). Requests and answers are validated at the boundary.
 */
export function registerBudgetIpc(
  ipc: Pick<IpcMain, "handle">,
  budget: Pick<RemoteBudget, "estimateImport" | "snapshot">,
  routeModel: ImportRouteModel,
  actions: { continuePastPause(): Promise<BudgetSnapshot> }
): void {
  ipc.handle(
    ipcChannels.budgetEstimateImport,
    async (_event, input: unknown): Promise<ImportEstimate> =>
      ImportEstimateSchema.parse(
        await budget.estimateImport(ImportEstimateInputSchema.parse(input), { routeModel })
      )
  );
  ipc.handle(
    ipcChannels.budgetSnapshot,
    async (_event, ...args: unknown[]): Promise<BudgetSnapshot> => {
      z.tuple([]).parse(args);
      return BudgetSnapshotSchema.parse(await budget.snapshot());
    }
  );
  ipc.handle(
    ipcChannels.budgetContinue,
    async (_event, ...args: unknown[]): Promise<BudgetSnapshot> => {
      z.tuple([]).parse(args);
      return BudgetSnapshotSchema.parse(await actions.continuePastPause());
    }
  );
}
