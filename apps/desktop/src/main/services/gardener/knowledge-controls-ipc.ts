import type { IpcMain } from "electron";
import {
  KnowledgeControlsSchema,
  KnowledgeControlsUpdateSchema,
  type KnowledgeControls
} from "@app/domain";
import { z } from "zod";

import { ipcChannels } from "../../../shared/ipc.js";
import type { KnowledgeControlsService } from "./knowledge-controls.js";

/**
 * The Knowledge controls over IPC (F4 D13, T98): Settings › Knowledge reads the six and changes any
 * subset. The service validates and stores the change, moves its generation and tells its listeners
 * (the blockers, the budget, the status); the request and the answer are validated at the boundary
 * too. A change the person makes to the tree shape is handed to `treeShapeChanged`, which asks the
 * topic build to propose a rebuild for review; the controls read at start never do. Without the
 * background policy (a refused DEV override) nothing can be stored.
 */
export function registerKnowledgeControlsIpc(
  ipc: Pick<IpcMain, "handle">,
  controls: () => Pick<KnowledgeControlsService, "get" | "update"> | null,
  hooks: { treeShapeChanged?: () => void } = {}
): void {
  const service = () => {
    const current = controls();
    if (!current) throw new Error("errors.common.missingConfiguration");
    return current;
  };
  ipc.handle(
    ipcChannels.knowledgeControlsGet,
    async (_event, ...args: unknown[]): Promise<KnowledgeControls> => {
      z.tuple([]).parse(args);
      return KnowledgeControlsSchema.parse(await service().get());
    }
  );
  ipc.handle(
    ipcChannels.knowledgeControlsUpdate,
    async (_event, change: unknown): Promise<KnowledgeControls> => {
      const update = KnowledgeControlsUpdateSchema.parse(change);
      const current = service();
      const before = update.treeShape === undefined ? null : await current.get();
      const after = KnowledgeControlsSchema.parse(await current.update(update));
      if (before && before.treeShape !== after.treeShape) hooks.treeShapeChanged?.();
      return after;
    }
  );
}
