import type { IpcMain } from "electron";
import {
  HardwareProfileInputSchema,
  HardwareProfileResultSchema,
  type HardwareProfileInput,
  type HardwareProfileResult
} from "@app/domain";
import { z } from "zod";

import { ipcChannels } from "../../../shared/ipc.js";

/**
 * `hardware.profile` (F4 D32, T97): the machine's profile, the setup recommended for it and the
 * informative price of each preset. It takes nothing, or `{ refresh: true }` to probe again
 * ("Re-detect"); the answer is validated before it leaves, so only the allowlisted fields do.
 */
export function registerHardwareIpc(
  ipc: Pick<IpcMain, "handle">,
  service: { profile(input: HardwareProfileInput): Promise<HardwareProfileResult> }
): void {
  ipc.handle(
    ipcChannels.hardwareProfile,
    async (_event, ...args: unknown[]): Promise<HardwareProfileResult> => {
      const [input] = z.union([z.tuple([]), z.tuple([HardwareProfileInputSchema])]).parse(args);
      return HardwareProfileResultSchema.parse(await service.profile(input ?? {}));
    }
  );
}
