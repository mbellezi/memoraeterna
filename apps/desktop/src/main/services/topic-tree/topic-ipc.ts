import type { IpcMain } from "electron";

import type { PgPool } from "@app/db";
import {
  TopicChangeSetInputSchema,
  TopicMutationResultSchema,
  TopicMutationSchema,
  TopicNotesInputSchema,
  TopicPageInputSchema,
  TopicPathInputSchema,
  TopicReembedInputSchema,
  TopicReembedResultSchema,
  TopicReviewInputSchema,
  TopicReviewResultSchema,
  TopicShapeInputSchema,
  TopicTreeInputSchema,
  TopicUndoInputSchema,
  TopicUndoResultSchema,
  type TopicChangeSet,
  type TopicMutation,
  type TopicMutationResult,
  type TopicNotes,
  type TopicPage,
  type TopicPath,
  type TopicReembedInput,
  type TopicReembedResult,
  type TopicReviewInput,
  type TopicReviewResult,
  type TopicShape,
  type TopicTree,
  type TopicUndoInput,
  type TopicUndoResult,
  type TopicsStatus
} from "@app/domain";
import {
  TopicOverviewCancelInputSchema,
  TopicOverviewInputSchema,
  TopicOverviewResultSchema,
  type TopicOverviewCancelInput,
  type TopicOverviewInput,
  type TopicOverviewState
} from "@app/domain";
import { ipcChannels } from "../../../shared/ipc.js";
import { TopicReadService, type TopicReadServiceOptions } from "./topic-read-service.js";

/** The reads of the topic screens (`TopicReadService` implements it). */
export interface TopicReadPort {
  tree(input: unknown): Promise<TopicTree | null>;
  path(input: unknown): Promise<TopicPath | null>;
  page(input: unknown): Promise<TopicPage | null>;
  notes(input: unknown): Promise<TopicNotes | null>;
  shape(input: unknown): Promise<TopicShape | null>;
  changeSet(input: unknown): Promise<TopicChangeSet | null>;
  status(): Promise<TopicsStatus>;
}

/**
 * The operations other tasks install: `mutate`, `undo` and `review` (T26), `reembed` (T19b) and the
 * overview (T31). A channel without its handler answers `topics.errors.unavailable` (a cancel answers
 * false) instead of Electron's own error, so the renderer can code against the whole contract
 * before the handler lands.
 */
export interface TopicOperationHandlers {
  mutate?: (input: TopicMutation) => Promise<TopicMutationResult>;
  undo?: (input: TopicUndoInput) => Promise<TopicUndoResult>;
  review?: (input: TopicReviewInput) => Promise<TopicReviewResult>;
  reembed?: (input: TopicReembedInput) => Promise<TopicReembedResult>;
  /** `topics.overview` and its cancel (T31): the overview written on open. */
  writeOverview?: (input: TopicOverviewInput) => Promise<TopicOverviewState>;
  cancelOverview?: (input: TopicOverviewCancelInput) => boolean | Promise<boolean>;
}

export interface TopicIpcDependencies extends TopicOperationHandlers {
  read: TopicReadPort;
}

/** Every request is validated here, before a service sees it, and every answer before it leaves. */
export function registerTopicIpc(ipc: IpcMain, deps: TopicIpcDependencies): void {
  ipc.handle(ipcChannels.topicsTree, (_event, payload: unknown) =>
    deps.read.tree(TopicTreeInputSchema.parse(payload ?? {}))
  );
  ipc.handle(ipcChannels.topicsPath, (_event, payload: unknown) =>
    deps.read.path(TopicPathInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.topicsPage, (_event, payload: unknown) =>
    deps.read.page(TopicPageInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.topicsNotes, (_event, payload: unknown) =>
    deps.read.notes(TopicNotesInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.topicsShape, (_event, payload: unknown) =>
    deps.read.shape(TopicShapeInputSchema.parse(payload ?? {}))
  );
  ipc.handle(ipcChannels.topicsChangeSet, (_event, payload: unknown) =>
    deps.read.changeSet(TopicChangeSetInputSchema.parse(payload))
  );
  ipc.handle(ipcChannels.topicsStatus, () => deps.read.status());
  ipc.handle(ipcChannels.topicsMutate, async (_event, payload: unknown) => {
    const input = TopicMutationSchema.parse(payload);
    if (!deps.mutate) throw new Error("topics.errors.unavailable");
    return TopicMutationResultSchema.parse(await deps.mutate(input));
  });
  ipc.handle(ipcChannels.topicsUndo, async (_event, payload: unknown) => {
    const input = TopicUndoInputSchema.parse(payload);
    if (!deps.undo) throw new Error("topics.errors.unavailable");
    return TopicUndoResultSchema.parse(await deps.undo(input));
  });
  ipc.handle(ipcChannels.topicsReview, async (_event, payload: unknown) => {
    const input = TopicReviewInputSchema.parse(payload);
    if (!deps.review) throw new Error("topics.errors.unavailable");
    return TopicReviewResultSchema.parse(await deps.review(input));
  });
  ipc.handle(ipcChannels.topicsReembed, async (_event, payload: unknown) => {
    const input = TopicReembedInputSchema.parse(payload);
    if (!deps.reembed) throw new Error("topics.errors.unavailable");
    return TopicReembedResultSchema.parse(await deps.reembed(input));
  });
  ipc.handle(ipcChannels.topicsOverview, async (_event, payload: unknown) => {
    const input = TopicOverviewInputSchema.parse(payload);
    if (!deps.writeOverview) throw new Error("topics.errors.unavailable");
    return TopicOverviewResultSchema.parse(await deps.writeOverview(input));
  });
  ipc.handle(ipcChannels.topicsOverviewCancel, async (_event, payload: unknown) => {
    const input = TopicOverviewCancelInputSchema.parse(payload);
    return deps.cancelOverview ? (await deps.cancelOverview(input)) === true : false;
  });
}

export interface TopicTreeIpcOptions
  extends TopicOperationHandlers, Omit<TopicReadServiceOptions, "getPool"> {
  getPool: () => PgPool | null;
}

/**
 * The whole topic IPC surface in one call: the read service and every handler. The topic service's
 * factory calls it once. The tree's changes are not pushed from here: a committed change reaches
 * every window as `tree.changed` on the bus (F5 D16), after the coalescer.
 */
export function registerTopicTreeIpc(
  ipc: IpcMain,
  options: TopicTreeIpcOptions
): { read: TopicReadService } {
  const { mutate, undo, review, reembed, ...rest } = options;
  const { writeOverview, cancelOverview, ...readOptions } = rest;
  const read = new TopicReadService(readOptions);
  registerTopicIpc(ipc, {
    read,
    ...(mutate ? { mutate } : {}),
    ...(undo ? { undo } : {}),
    ...(review ? { review } : {}),
    ...(reembed ? { reembed } : {}),
    ...(writeOverview ? { writeOverview } : {}),
    ...(cancelOverview ? { cancelOverview } : {})
  });
  return { read };
}
