import type { IpcMain } from "electron";
import { GardenerStatusSnapshotSchema, type GardenerStatusSnapshot } from "@app/domain";
import { z } from "zod";

import { ipcChannels } from "../../../shared/ipc.js";

/**
 * `gardener.status` (F4 D27, spec 3.8): the Gardener's status now. The renderer reads it when its
 * Activity opens and follows the `gardener.status` events after; the answer is validated before it
 * leaves.
 */
export function registerGardenerStatusIpc(
  ipc: Pick<IpcMain, "handle">,
  service: { snapshot(): Promise<GardenerStatusSnapshot> }
): void {
  ipc.handle(
    ipcChannels.gardenerStatus,
    async (_event, ...args: unknown[]): Promise<GardenerStatusSnapshot> => {
      z.tuple([]).parse(args);
      return GardenerStatusSnapshotSchema.parse(await service.snapshot());
    }
  );
}
