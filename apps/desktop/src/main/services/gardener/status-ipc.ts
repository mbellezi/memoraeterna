import type { IpcMain } from "electron";
import { GardenerStatusSnapshotSchema, type GardenerStatusSnapshot } from "@app/domain";
import { z } from "zod";

import { ipcChannels } from "../../../shared/ipc.js";

/**
 * `gardener.status` (F4 D27, spec 3.8): the Gardener's status now. The renderer reads it when its
 * Activity opens and follows the `gardener.status` events after; the answer is validated before it
 * leaves. `gardener.resume` is the Activity's one action on the Gardener's controls: it lifts the
 * person's pause, and the status follows as an event.
 */
export function registerGardenerStatusIpc(
  ipc: Pick<IpcMain, "handle">,
  service: { snapshot(): Promise<GardenerStatusSnapshot> },
  actions?: { resume(): Promise<void> }
): void {
  ipc.handle(
    ipcChannels.gardenerStatus,
    async (_event, ...args: unknown[]): Promise<GardenerStatusSnapshot> => {
      z.tuple([]).parse(args);
      return GardenerStatusSnapshotSchema.parse(await service.snapshot());
    }
  );
  if (actions)
    ipc.handle(ipcChannels.gardenerResume, async (_event, ...args: unknown[]): Promise<null> => {
      z.tuple([]).parse(args);
      await actions.resume();
      return null;
    });
}
