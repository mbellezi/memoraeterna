// The one way a main service says that objects changed (F5 D16, spec 3.7): `object.changed` goes to
// the windows through `appEventPort`, after the work it describes committed and never inside a
// transaction. A service that has no bus in hand calls `publishObjectsChanged`; a call with nothing
// to say publishes nothing, and an event is never the reason a write fails.
import type { ObjectKind } from "@app/domain";

import type { ObjectChange, ObjectChangedRef } from "../../shared/app-events.js";
import { appEventPort, type AppEventPort } from "./app-events.js";

/** What a call may publish through: the process-wide port, or a fake in a test. */
export type ObjectEventPort = Pick<AppEventPort, "publish">;

/**
 * Publishes the refs of objects a commit changed. Refs repeated by `kind:id` fold into one (the
 * last change counts, except `deleted`, which always wins), so a writer may list an object once per
 * place it touched it. The bus folds the rest and sends a batch of more than 200 as an overflow.
 */
export function publishObjectsChanged(
  refs: Iterable<ObjectChangedRef>,
  port: ObjectEventPort = appEventPort
): void {
  const byObject = new Map<string, ObjectChangedRef>();
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    const held = byObject.get(key);
    byObject.set(key, held?.change === "deleted" ? held : ref);
  }
  if (byObject.size === 0) return;
  try {
    port.publish({ type: "object.changed", refs: [...byObject.values()] });
  } catch {
    // Telling the windows is a courtesy of a commit that already happened.
  }
}

/**
 * Says that objects of these kinds changed too widely to list (a rebuilt topic tree): a consumer
 * reads its list of that kind again.
 */
export function publishObjectKindsOverflow(
  kinds: readonly ObjectKind[],
  port: ObjectEventPort = appEventPort
): void {
  if (kinds.length === 0) return;
  try {
    port.publish({ type: "object.changed", overflow: true, kinds: [...new Set(kinds)] });
  } catch {
    // As above.
  }
}

/** The refs of several objects of one kind that changed in the same way. */
export function objectRefs(
  kind: ObjectKind,
  ids: Iterable<string>,
  change: ObjectChange
): ObjectChangedRef[] {
  return [...new Set(ids)].map((id) => ({ kind, id, change }));
}

/** Publishes `objectRefs(kind, ids, change)`. */
export function publishObjectKindChanged(
  kind: ObjectKind,
  ids: Iterable<string>,
  change: ObjectChange,
  port: ObjectEventPort = appEventPort
): void {
  publishObjectsChanged(objectRefs(kind, ids, change), port);
}
