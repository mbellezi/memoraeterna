import { useCallback, useEffect, useId, useState } from "react";
import type { Translator } from "@app/i18n";
import { formatObjectAddress, parseObjectAddress } from "@app/domain";

import { EmptyState } from "../../../components/ui/empty-state";
import { Button } from "../../../components/ui/button";
import type { PanelLoadState } from "../../PanelFrame";
import type { PanelProps } from "../../PanelStack";
import { formatView, parseViewAddress, type MapLens } from "../../route";
import { ShapeScreen } from "./shape/ShapeScreen";
import { panelDomId, tabDomId, ViewSwitch } from "./shape/ViewSwitch";

/**
 * The Map destination's root (design record §7.5): the title, the two views of the tree and the
 * view itself. The tab is part of the root's address (`memora://view/map/<lens>`), so the stack
 * remembers it. "Árvore" (`shape`) is the size and health of the tree; "Grafo" (`relations`) is the
 * connections between topics, and shows a placeholder until its card (T151) lands. The root
 * reports its own `data-surface` and `data-state`, as the stack draws no frame around a root.
 */

export const surfaceId = "destination-map";

/** The lens and the topic the person came from (the "aqui" marker), read from the root's address. */
export function readMapAddress(address: string): { lens: MapLens; scope: string | null } {
  const view = parseViewAddress(address);
  if (view?.view !== "map") return { lens: "relations", scope: null };
  return {
    lens: view.lens,
    scope: view.scope ? formatObjectAddress({ kind: view.scope.kind, id: view.scope.id }) : null
  };
}

/** The title of an object, read once for the zoom-out band; null while unread or unnamed. */
function useTitle(address: string | null): string | null {
  const [read, setRead] = useState<{ address: string; title: string | null } | null>(null);
  useEffect(() => {
    if (address === null) return undefined;
    let live = true;
    window.app.objects
      .resolveMany({ addresses: [address] })
      .then((result) => {
        if (live) setRead({ address, title: result.items[address]?.title ?? null });
      })
      .catch(() => {
        if (live) setRead({ address, title: null });
      });
    return () => {
      live = false;
    };
  }, [address]);
  return read?.address === address ? read.title : null;
}

export function MapRoot({ t, address, mode, active, onState, onOpen, current }: PanelProps) {
  const { lens, scope } = readMapAddress(address);
  const originTopic = scope !== null && parseObjectAddress(scope)?.kind === "topic" ? scope : null;
  const originTitle = useTitle(originTopic);
  const prefix = useId();
  const [shapeState, setShapeState] = useState<PanelLoadState>("loading");
  const state: PanelLoadState = lens === "shape" ? shapeState : "empty";
  useEffect(() => {
    onState(state);
  }, [onState, state]);

  const openLens = useCallback(
    (next: MapLens) =>
      onOpen(
        formatView({
          view: "map",
          lens: next,
          ...(scope ? { scope: parseObjectAddress(scope)! } : {})
        }),
        { replace: true }
      ),
    [onOpen, scope]
  );
  const origin = originTopic
    ? { topicId: parseObjectAddress(originTopic)!.id, title: originTitle }
    : null;
  const compact = mode === "compact";

  return (
    <section
      data-surface={surfaceId}
      data-state={state}
      aria-label={t("map.title")}
      className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-5 max-[1179px]:px-4"
    >
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="m-0 font-reading text-2xl font-semibold text-foreground">
          {t("map.title")}
        </h1>
        {compact ? null : (
          <ViewSwitch
            label={t("map.lens.label")}
            value={lens}
            idPrefix={prefix}
            items={[
              { id: "shape", label: t("map.lens.shape") },
              { id: "relations", label: t("map.lens.relations") }
            ]}
            onChange={openLens}
          />
        )}
      </header>
      <div
        role="tabpanel"
        id={panelDomId(prefix, lens)}
        aria-labelledby={tabDomId(prefix, lens)}
        className="min-h-0 min-w-0"
      >
        {lens === "shape" ? (
          <ShapeScreen
            t={t}
            active={active}
            compact={compact}
            currentTopicId={current ? (readTopicId(current) ?? null) : null}
            origin={origin}
            onState={setShapeState}
            onNavigate={(navigation) => {
              if (navigation.type === "topic")
                onOpen(formatObjectAddress({ kind: "topic", id: navigation.topicId }));
            }}
            onOpenInbox={() => onOpen(formatView({ view: "inbox" }))}
            onBack={() => originTopic && onOpen(originTopic)}
          />
        ) : (
          <RelationsPlaceholder t={t} onShape={() => openLens("shape")} />
        )}
      </div>
    </section>
  );
}

const readTopicId = (address: string): string | null => {
  const parsed = parseObjectAddress(address);
  return parsed?.kind === "topic" ? parsed.id : null;
};

/** Until the graph of connections lands (T151): says what is coming and offers the tree. */
function RelationsPlaceholder({ t, onShape }: { t: Translator; onShape: () => void }) {
  return (
    <EmptyState
      headline={t("map.relations.headline")}
      className="max-w-xl"
      action={
        <Button type="button" onClick={onShape}>
          {t("map.relations.action")}
        </Button>
      }
    >
      {t("map.relations.body")}
    </EmptyState>
  );
}
