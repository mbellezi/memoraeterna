import { ipcChannels, wikiResolveLinksInputSchema } from "../../shared/ipc.js";
import type { IpcMain } from "electron";
import { z } from "zod";
import {
  WikiTreeInputSchema,
  WikiContextInputSchema,
  WikiLinkedTargetInputSchema,
  WikiQuerySchema
} from "@app/domain";
import { legacyRetiredError } from "./legacy-fence.js";
import type { WikiService } from "./wiki-service.js";

/**
 * The legacy wiki is read-only: the reads below still serve the Obsidian scope picker and the
 * remaining readers, while `save` and `move` are retired (F2 D3) and write nothing.
 */
export function registerWikiIpc(ipc: IpcMain, service: WikiService) {
  ipc.handle(ipcChannels.wikiTree, (_event, input: unknown) =>
    service.tree(WikiTreeInputSchema.parse(input))
  );
  ipc.handle(ipcChannels.wikiContext, (_event, input: unknown) =>
    service.context(WikiContextInputSchema.parse(input))
  );
  ipc.handle(ipcChannels.wikiMove, () => {
    throw legacyRetiredError();
  });
  ipc.handle(ipcChannels.wikiLinkedTarget, (_event, payload: unknown) =>
    service.linkedTarget(WikiLinkedTargetInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.wikiResolveLinks, (_event, payload: unknown) =>
    service.resolveLinks(wikiResolveLinksInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.wikiList, () => service.list());
  ipc.handle(ipcChannels.wikiGet, (_event, payload: unknown) => {
    const input = z
      .object({ id: z.string().uuid(), revisionId: z.string().uuid().optional() })
      .strict()
      .parse(payload);
    return service.get(input.id, input.revisionId);
  });
  ipc.handle(ipcChannels.wikiSave, () => {
    throw legacyRetiredError();
  });
  ipc.handle(ipcChannels.wikiSearch, (_event, payload: unknown) =>
    service.search(WikiQuerySchema.parse(payload))
  );
  ipc.handle(ipcChannels.wikiHistory, (_event, payload: unknown) =>
    service.history(z.string().uuid().parse(payload))
  );
}
