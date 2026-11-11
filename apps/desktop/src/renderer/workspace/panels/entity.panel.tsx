import { useEffect, useState, useSyncExternalStore } from "react";
import { parseObjectAddress } from "@app/domain";
import type { ObjectSummary } from "@app/domain";

import { useAppEvent } from "../../lib/app-events";
import { useObjectChanged, useObjectKindChanged } from "../../lib/object-events";
import type { PanelProps } from "../PanelStack";
import { EntityPageController } from "./entity/entity-controller";
import { reportedState } from "./entity/entity-model";
import { EntityPageView } from "./entity/EntityPageView";

/**
 * The Entity panel (`#entity`, design record §6.5; D31, D15): the page of one entity, read from
 * `entities.page`. The frame above it draws the path ribbon ("Mais citada em …", the topic where
 * most of its notes are placed) and the header; this file registers the panel by file and keeps
 * its page current through the bus: the entity itself, the notes that mention it and their topics
 * read the page again in place, and a hidden panel loads nothing.
 */

export const kind = "entity";

export function match(address: string): boolean {
  return parseObjectAddress(address)?.kind === "entity";
}

/** The title is the entity's name, as `objects.get` reads it; the kind word comes from the frame. */
export function title(summary: ObjectSummary | null): string {
  return summary?.title ?? "";
}

export function Component({
  t,
  address,
  mode,
  active,
  onState,
  onPlace,
  onOpen,
  current
}: PanelProps) {
  const id = parseObjectAddress(address)?.id ?? null;
  const [controller] = useState(
    () =>
      new EntityPageController({
        api: () => (typeof window === "undefined" ? undefined : window.app?.entities)
      })
  );
  const load = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    if (id !== null) controller.show(id, active);
  }, [controller, id, active]);

  // The entity, the notes that mention it and the topics that group them: read the page again.
  const reread = () => controller.reread();
  useObjectChanged([address], reread, active);
  useObjectKindChanged(["note", "topic"], reread, active);
  useAppEvent("tree.changed", reread, active);

  const reported = id === null ? "error" : reportedState(load);
  useEffect(() => onState(reported), [onState, reported]);
  // An entity sits where most of its notes are: the ribbon says "Mais citada em" before the path.
  useEffect(() => onPlace({ place: "mostCited" }), [onPlace]);

  return (
    <EntityPageView
      t={t}
      load={id === null ? { status: "error" } : load}
      mode={mode}
      current={current}
      onOpen={onOpen}
      onRetry={() => controller.retry()}
      onLoadMore={() => controller.loadMore()}
    />
  );
}
