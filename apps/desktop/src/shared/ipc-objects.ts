import type {
  ObjectBacklinksInput,
  ObjectBacklinksResult,
  ObjectGetInput,
  ObjectGetResult,
  ObjectResolveManyInput,
  ObjectResolveManyResult
} from "@app/domain";

/**
 * The objects area of the desktop API (F5 D11, D30): channels and the renderer's view of
 * `window.app.objects` for the reads of the objects layer. Locate and neighborhood keep their
 * channels in `ipc.ts`; the wave's wiring card merges these into `ipcChannels` and `DesktopApi`.
 */
export const objectsIpcChannels = {
  objectsGet: "app:objects:get",
  objectsResolveMany: "app:objects:resolve-many",
  objectsBacklinks: "app:objects:backlinks"
} as const;

export interface ObjectsApi {
  /** One object by address; `{ status: "missing" }` when it does not exist. */
  get: (input: ObjectGetInput) => Promise<ObjectGetResult>;
  /** Up to 200 unique addresses in one read, keyed by address as requested. */
  resolveMany: (input: ObjectResolveManyInput) => Promise<ObjectResolveManyResult>;
  /** One page of the links into an object, across the kinds of link. */
  backlinks: (input: ObjectBacklinksInput) => Promise<ObjectBacklinksResult>;
}
