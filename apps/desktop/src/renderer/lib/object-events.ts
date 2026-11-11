import { useEffect, useMemo, useState } from "react";
import {
  parseObjectAddress,
  type ObjectGetResult,
  type ObjectKind,
  type ObjectSummary
} from "@app/domain";

import type { AppEventOf, ObjectChangedRef } from "../../shared/app-events";
import type { ObjectsApi } from "../../shared/ipc-objects";
import { useAppEvent, type AppEventApi } from "./app-events";
import { useStableCallback } from "./stable-callback";

/**
 * Following objects through the bus (F5 D16, spec 3.7). The main process publishes `object.changed`
 * after a commit: up to 200 refs `{ kind, id, change }`, or `{ overflow, kinds }` when a batch was
 * too broad to list. A panel follows the objects it shows, a list follows a kind, and both read
 * again through `objects.get` or their own read; nothing here polls.
 */

/** What an object one follows is told: the refs that concern it, or that the batch was too broad. */
export interface ObjectChangeNotice {
  /** The listed refs that concern the followed objects, in the order of the event. */
  refs: readonly ObjectChangedRef[];
  /** The batch listed no ids and named a followed kind: anything of that kind may have changed. */
  overflow: boolean;
}

/** One followed object: its kind and id. An anchor (a passage, a span) belongs to the same object. */
export interface ObjectTarget {
  kind: ObjectKind;
  id: string;
}

/** The kinds and ids of addresses; one that is not a valid `memora://` address is left out. */
export function objectTargetsOf(addresses: readonly string[]): ObjectTarget[] {
  const targets = new Map<string, ObjectTarget>();
  for (const address of addresses) {
    const parsed = parseObjectAddress(address);
    if (parsed) targets.set(`${parsed.kind}:${parsed.id}`, { kind: parsed.kind, id: parsed.id });
  }
  return [...targets.values()];
}

/** The part of an `object.changed` event that concerns the targets, or null when none of it does. */
export function noticeForTargets(
  event: AppEventOf<"object.changed">,
  targets: readonly ObjectTarget[]
): ObjectChangeNotice | null {
  if ("overflow" in event) {
    return targets.some((target) => event.kinds.includes(target.kind))
      ? { refs: [], overflow: true }
      : null;
  }
  const refs = event.refs.filter((ref) =>
    targets.some((target) => target.kind === ref.kind && target.id === ref.id)
  );
  return refs.length > 0 ? { refs, overflow: false } : null;
}

/** The part of an `object.changed` event that concerns the kinds, or null when none of it does. */
export function noticeForKinds(
  event: AppEventOf<"object.changed">,
  kinds: readonly ObjectKind[]
): ObjectChangeNotice | null {
  if ("overflow" in event)
    return event.kinds.some((kind) => kinds.includes(kind)) ? { refs: [], overflow: true } : null;
  const refs = event.refs.filter((ref) => kinds.includes(ref.kind));
  return refs.length > 0 ? { refs, overflow: false } : null;
}

/**
 * Calls `onChange` for each `object.changed` that concerns one of the addresses, until the returned
 * function is called. Outside React (a store, a controller).
 */
export function watchObjectChanged(
  api: () => AppEventApi | undefined,
  addresses: readonly string[],
  onChange: (notice: ObjectChangeNotice) => void
): () => void {
  const targets = objectTargetsOf(addresses);
  if (targets.length === 0) return () => undefined;
  const stop = api()?.onAppEvent("object.changed", (event) => {
    const notice = noticeForTargets(event, targets);
    if (notice) onChange(notice);
  });
  return () => stop?.();
}

/**
 * Calls `onChange` while mounted and `active` (a view that stays mounted while hidden says whether
 * it is shown; a hidden view listens to nothing) for each change of one of the addresses. A new
 * `onChange` on each render does not resubscribe; new addresses do.
 */
export function useObjectChanged(
  addresses: readonly string[],
  onChange: (notice: ObjectChangeNotice) => void,
  active = true
): void {
  const stable = useStableCallback(onChange);
  const key = addresses.join("\n");
  useEffect(() => {
    if (!active) return;
    return watchObjectChanged(
      () => (typeof window === "undefined" ? undefined : window.app),
      key === "" ? [] : key.split("\n"),
      stable
    );
  }, [active, key, stable]);
}

/**
 * Calls `onChange` while mounted and `active` for each change of an object of one of the kinds. A
 * list subscribes by kind and reads its page again; it does not follow ids it does not show.
 */
export function useObjectKindChanged(
  kinds: readonly ObjectKind[],
  onChange: (notice: ObjectChangeNotice) => void,
  active = true
): void {
  const stable = useStableCallback(onChange);
  const key = kinds.join(",");
  const followed = useMemo(() => (key === "" ? [] : (key.split(",") as ObjectKind[])), [key]);
  useAppEvent(
    "object.changed",
    (event) => {
      const notice = noticeForKinds(event, followed);
      if (notice) stable(notice);
    },
    active
  );
}

/** What a panel knows of the object it shows: loading, read, gone, or failed to read. */
export type ObjectState =
  | { status: "loading" }
  | { status: "ready"; object: ObjectSummary }
  | { status: "missing" }
  | { status: "error" };

/** The part of `window.app` that reading and following one object needs. */
export type ObjectWatchApi = AppEventApi & { objects: Pick<ObjectsApi, "get"> };

const isMissing = (answer: ObjectGetResult): answer is { status: "missing" } =>
  answer.status === "missing";

/**
 * Reads one object through `objects.get` and again whenever `object.changed` names it, reporting
 * each state. The object on screen stays while it is read again (a failed re-read keeps it, and the
 * newest answer wins). Returns what stops following. Outside React.
 */
export function watchObject(
  api: () => ObjectWatchApi | undefined,
  address: string,
  onState: (state: ObjectState) => void
): () => void {
  let live = true;
  let token = 0;
  let shown = false;
  const read = (): void => {
    const app = api();
    if (!app) {
      onState({ status: "error" });
      return;
    }
    const mine = ++token;
    app.objects
      .get({ address })
      .then((answer) => {
        if (!live || mine !== token) return;
        shown = !isMissing(answer);
        onState(isMissing(answer) ? { status: "missing" } : { status: "ready", object: answer });
      })
      .catch(() => {
        // A failed re-read keeps the object that is shown; a first read says it failed.
        if (live && mine === token && !shown) onState({ status: "error" });
      });
  };
  onState({ status: "loading" });
  const stop = watchObjectChanged(api, [address], read);
  read();
  return () => {
    live = false;
    stop();
  };
}

/**
 * The object at an address, read through `objects.get` and again after every `object.changed` that
 * names it (a merged topic shows its redirect, a deleted object shows as missing). A hidden view
 * (`active` false) listens to nothing and reads again when it is shown.
 */
export function useObject(address: string, active = true): ObjectState {
  const [state, setState] = useState<ObjectState>({ status: "loading" });
  useEffect(() => {
    if (!active) return;
    return watchObject(
      () => (typeof window === "undefined" ? undefined : window.app),
      address,
      setState
    );
  }, [address, active]);
  return state;
}
