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
  TopicsChangedEventSchema,
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
  type TopicsChangedEvent,
  type TopicsStatus
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
 * The operations other tasks install: `mutate`, `undo` and `review` (T26) and `reembed` (T19b). A
 * channel without its handler answers `topics.errors.unavailable` instead of Electron's own error,
 * so the renderer can code against the whole contract before the handler lands.
 */
export interface TopicOperationHandlers {
  mutate?: (input: TopicMutation) => Promise<TopicMutationResult>;
  undo?: (input: TopicUndoInput) => Promise<TopicUndoResult>;
  review?: (input: TopicReviewInput) => Promise<TopicReviewResult>;
  reembed?: (input: TopicReembedInput) => Promise<TopicReembedResult>;
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
}

/** What the push channel needs of a window's web contents. */
export interface TopicsChangedTarget {
  isDestroyed(): boolean;
  /** `topicsChanged` carries its event; the view-history push (a pin, T26) carries none. */
  send(channel: string, payload?: TopicsChangedEvent): void;
}

/** The emitter the topic service calls after a change-set commits (its coalescer lives there). */
export type TopicsChangedEmitter = (event: TopicsChangedEvent) => void;

/**
 * The `topicsChanged` channel: validates each event and sends it to every live window. It sends
 * nothing by itself and holds no state: the topic service calls it once per committed (and
 * coalesced) change, so no window ever hears of a generation that a read cannot see yet. An event
 * that does not match the contract is reported, never sent.
 */
export function createTopicsChangedPublisher(
  targets: () => Iterable<TopicsChangedTarget>,
  onInvalid: (error: Error) => void = (error) => console.error(error.message)
): TopicsChangedEmitter {
  return (event) => {
    const parsed = TopicsChangedEventSchema.safeParse(event);
    if (!parsed.success) {
      onInvalid(new Error(`Invalid topicsChanged event: ${parsed.error.message}`));
      return;
    }
    for (const target of targets()) {
      if (!target.isDestroyed()) target.send(ipcChannels.topicsChanged, parsed.data);
    }
  };
}

export interface TopicTreeIpcOptions
  extends TopicOperationHandlers, Omit<TopicReadServiceOptions, "getPool"> {
  getPool: () => PgPool | null;
  /** The windows that hear `topicsChanged` (`webContents.getAllWebContents()`). */
  targets: () => Iterable<TopicsChangedTarget>;
  onInvalidEvent?: (error: Error) => void;
}

/**
 * The whole topic IPC surface in one call: the read service, every handler and the push channel. The
 * topic service's factory calls it once and gives `emitChanged` to its coalescer, which calls it
 * after each committed change-set.
 */
export function registerTopicTreeIpc(
  ipc: IpcMain,
  options: TopicTreeIpcOptions
): { read: TopicReadService; emitChanged: TopicsChangedEmitter } {
  const { targets, onInvalidEvent, mutate, undo, review, reembed, ...readOptions } = options;
  const read = new TopicReadService(readOptions);
  registerTopicIpc(ipc, {
    read,
    ...(mutate ? { mutate } : {}),
    ...(undo ? { undo } : {}),
    ...(review ? { review } : {}),
    ...(reembed ? { reembed } : {})
  });
  return { read, emitChanged: createTopicsChangedPublisher(targets, onInvalidEvent) };
}
