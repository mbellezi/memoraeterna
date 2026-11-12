import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ListTree } from "lucide-react";
import type { Translator } from "@app/i18n";
import { formatObjectAddress } from "@app/domain";

import type { RelationsBranchResult } from "../../../../../shared/ipc-relations-branch";
import { useAppEvent } from "../../../../lib/app-events";
import { cn } from "../../../../lib/cn";
import { useStableCallback } from "../../../../lib/stable-callback";
import { relationTypeView, stanceTextClass } from "../../../../lib/relation-stance";
import { ObjectKindGlyph, StanceGlyph } from "../../../../components/glyphs";
import { LineSample } from "../../../../components/graph/LineSamples";
import { isWebGLAvailable } from "../../../../components/graph/webgl";
import { Button } from "../../../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../../../components/ui/dropdown-menu";
import { EmptyState } from "../../../../components/ui/empty-state";
import { ErrorState } from "../../../../components/ui/error-state";
import { LoadingState, Skeleton } from "../../../../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../../../../components/ui/toggle-group";
import type { PanelLoadState } from "../../../PanelFrame";
import {
  buildBranchModel,
  hasConnections,
  topicLabel,
  type BranchCursorItem,
  type BranchModel,
  type BranchScope
} from "./branch-model";
import {
  LiveRereads,
  branchChoices,
  sameBranchRead,
  type BranchChoices,
  type BranchRead
} from "./branch-reads";
import { RelationsCanvas, type BranchLayoutFactory } from "./RelationsCanvas";
import { superNodeRatio } from "./branch-sigma";
import { BranchNotices, DisplayToggle, type RelationsDisplay } from "./lens-controls";
import { RelationsAside, relationsBlockHeight } from "./RelationsTable";

export const surfaceId = "map-relations";

type ColourDepth = 1 | 2 | 3;

type Load =
  | { status: "loading" }
  | { status: "error" }
  /** The scope topic or source is gone. */
  | { status: "missing" }
  /** The tree has no topic yet: there is no branch to draw. */
  | { status: "noTopics" }
  /** The answer on screen; the model is worded from it in the interface's language. */
  | { status: "ready"; read: BranchRead };

/** The four states of a surface, as the frame names them. */
export function relationsState(load: Load, model: BranchModel | null): PanelLoadState {
  if (load.status === "loading") return "loading";
  if (load.status === "error") return "error";
  if (model && hasConnections(model)) return "success";
  return "empty";
}

/** How long a burst of pushed changes is let settle before the graph is read again in place. */
const refreshDelayMs = 1_000;
const defaultSensitivity = 1;

export interface RelationsLensProps {
  t: Translator;
  /** False while the Map or this tab is hidden: nothing loads and nothing listens. */
  active: boolean;
  /** The topic or source the Map was opened for; none picks the largest area of the tree. */
  scope: BranchScope | null;
  onOpenNote: (noteId: string) => void;
  /** Shows the Map's Tree tab. */
  onShowTree: () => void;
  onState?: (state: PanelLoadState) => void;
  /** The canvas's layout engine (the worker by default). */
  createLayout?: BranchLayoutFactory;
  /** What the screens tool names this frame, and how it opens (a screen module's business). */
  frame?: { surface: string; display?: RelationsDisplay; selected?: BranchCursorItem | null };
}

/** The read of the largest area, the Grafo's branch when the Map was opened without one. */
async function largestArea(): Promise<BranchScope | null> {
  const tree = await window.app.topics.tree({ parentId: null, limit: 100 });
  const area = [...(tree?.nodes ?? [])].sort((a, b) => b.items - a.items)[0];
  return area ? { kind: "topic", id: area.id } : null;
}

async function sourceTitle(scope: BranchScope): Promise<string | null> {
  if (scope.kind !== "source") return null;
  const address = formatObjectAddress({ kind: "source", id: scope.id });
  try {
    const answer = await window.app.objects.resolveMany({ addresses: [address] });
    return answer.items[address]?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * The Map's Grafo tab (F5 D19, design record 7.5): the description, the colour depth and the branch
 * picker, then the canvas with its legend. The lens loads only while shown; a pushed change to the
 * notes or the tree reads the branch again in place once the burst settles.
 */
export function RelationsLens({
  t,
  active,
  scope,
  onOpenNote,
  onShowTree,
  onState,
  createLayout,
  frame
}: RelationsLensProps) {
  const [chosen, setChosen] = useState<BranchScope | null>(null);
  const [depth, setDepth] = useState<ColourDepth>(1);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState<BranchCursorItem | null>(frame?.selected ?? null);
  const [display, setDisplay] = useState<RelationsDisplay>(frame?.display ?? "both");
  const [webgl] = useState(() => isWebGLAvailable());
  const [unavailable, setUnavailable] = useState(false);
  const sensitivity = useWheelSensitivity(active);
  const scopeKey = scope ? `${scope.kind}:${scope.id}` : "";
  // Another "Open in Map" is another branch: the branch picked here gives way to it.
  const [seenScope, setSeenScope] = useState(scopeKey);
  if (seenScope !== scopeKey) {
    setSeenScope(scopeKey);
    setChosen(null);
  }
  const wanted = chosen ?? scope;
  const wantedKey = wanted ? `${wanted.kind}:${wanted.id}` : "";
  const loadKey = `${wantedKey}|${depth}|${attempt}`;
  const lastOk = useRef<string | null>(null);
  const silent = useRef(false);
  // A pushed change reads the branch again once the burst settles, and never before a first answer.
  const reread = useStableCallback(() => {
    silent.current = true;
    setAttempt((value) => value + 1);
  });
  const rereads = useMemo(() => new LiveRereads(reread, refreshDelayMs), [reread]);
  useEffect(() => () => rereads.dispose(), [rereads]);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    const quiet = silent.current && lastOk.current === `${wantedKey}|${depth}`;
    silent.current = false;
    if (!quiet) setLoad({ status: "loading" });
    void (async () => {
      try {
        const target = wanted ?? (await largestArea());
        if (!live) return;
        if (!target) {
          setLoad({ status: "noTopics" });
          return;
        }
        const [answer, title] = await Promise.all([
          window.app.relations.branch({
            scope: target.kind === "topic" ? { topicId: target.id } : { sourceId: target.id },
            colourDepth: depth
          }),
          sourceTitle(target)
        ]);
        if (!live) return;
        if (!answer) {
          setLoad({ status: "missing" });
          return;
        }
        lastOk.current = `${wantedKey}|${depth}`;
        const read: BranchRead = {
          target,
          depth,
          answer: answer as RelationsBranchResult,
          sourceTitle: title
        };
        // An answer equal to the one on screen keeps it: nothing is built or drawn again.
        setLoad((previous) =>
          previous.status === "ready" && sameBranchRead(previous.read, read)
            ? previous
            : { status: "ready", read }
        );
        rereads.answer();
      } catch {
        if (!live) return;
        // A read in place that fails keeps what is on screen; a first read says so.
        if (!quiet) setLoad({ status: "error" });
      }
    })();
    return () => {
      live = false;
    };
    // `wanted` is keyed by `wantedKey`; `rereads` lives as long as the lens; `t` words the model below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loadKey]);

  // The model is worded in the interface's language: a new language words the same answer again.
  const model = useMemo(
    () =>
      load.status === "ready"
        ? buildBranchModel(load.read.answer, {
            scope: load.read.target,
            colourDepth: load.read.depth,
            sourceTitle: load.read.sourceTitle,
            t
          })
        : null,
    [load, t]
  );

  // Pushed changes to notes, relations or the tree read the branch again in place.
  const refresh = () => rereads.push();
  useAppEvent("tree.changed", refresh, active);
  useAppEvent(
    "object.changed",
    (event) => {
      const kinds =
        "refs" in event ? event.refs.map((ref) => ref.kind) : (event.kinds as readonly string[]);
      if (kinds.some((kind) => kind === "note" || kind === "topic")) refresh();
    },
    active
  );

  const state = relationsState(load, model);
  useEffect(() => {
    onState?.(state);
  }, [onState, state]);

  const pick = (next: BranchScope) => {
    setSelected(null);
    setChosen(next);
  };

  // "Só tabela" and a window that cannot draw WebGL read the same table, alone.
  const canvasShown = display === "both" && webgl && !unavailable;
  const aside = model ? (
    <RelationsAside
      t={t}
      model={model}
      selected={selected}
      onSelect={setSelected}
      onOpenNote={onOpenNote}
      onChoose={(next) => pick(next)}
      alone={!canvasShown}
    />
  ) : null;

  return (
    <section
      data-surface={frame?.surface ?? surfaceId}
      data-state={state}
      aria-label={t("map.lens.relations")}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="m-0 text-sm text-secondary-foreground">{t("mapRelations.description")}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-2">
            <span
              className="text-xs text-secondary-foreground"
              title={t("mapRelations.depth.help")}
            >
              {t("mapRelations.depth.label")}
            </span>
            <ToggleGroup
              label={t("mapRelations.depth.help")}
              value={String(depth) as "1" | "2" | "3"}
              onValueChange={(value) => {
                setSelected(null);
                setDepth(Number(value) as ColourDepth);
              }}
            >
              <ToggleGroupItem value="1">{t("mapRelations.depth.one")}</ToggleGroupItem>
              <ToggleGroupItem value="2">{t("mapRelations.depth.two")}</ToggleGroupItem>
              <ToggleGroupItem value="3">{t("mapRelations.depth.three")}</ToggleGroupItem>
            </ToggleGroup>
          </div>
          {model && hasConnections(model) ? (
            <DisplayToggle t={t} value={display} onChange={setDisplay} />
          ) : null}
          <BranchPicker t={t} model={model} wanted={wanted} active={active} onPick={pick} />
        </div>
      </div>
      {load.status === "loading" ? (
        <RelationsSkeleton t={t} tableOnly={display === "table"} />
      ) : null}
      {load.status === "error" ? (
        <ErrorState
          t={t}
          message={t("mapRelations.error.message")}
          kept={t("mapRelations.error.kept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : null}
      {load.status === "noTopics" ? (
        <EmptyState headline={t("mapRelations.empty.noTopics")} className="max-w-xl">
          {t("mapRelations.empty.noTopicsBody")}
        </EmptyState>
      ) : null}
      {load.status === "missing" ? (
        <EmptyState
          headline={t("mapRelations.empty.missing")}
          className="max-w-xl"
          action={<TreeButton t={t} onClick={onShowTree} />}
        >
          {t("mapRelations.empty.missingBody")}
        </EmptyState>
      ) : null}
      {model && !hasConnections(model) ? (
        <EmptyState
          headline={t("mapRelations.empty.headline")}
          className="max-w-xl"
          action={<TreeButton t={t} onClick={onShowTree} />}
        >
          {t("mapRelations.empty.body")}
        </EmptyState>
      ) : null}
      {model && hasConnections(model) ? (
        <>
          <BranchNotices t={t} model={model} />
          {canvasShown ? (
            <div className="grid min-w-0 gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_26rem]">
              <div className="flex min-w-0 flex-col gap-3">
                <RelationsCanvas
                  t={t}
                  model={model}
                  wheelZoomSensitivity={sensitivity}
                  onOpenNote={onOpenNote}
                  onUnavailable={() => setUnavailable(true)}
                  selected={selected}
                  onSelect={setSelected}
                  {...(createLayout ? { createLayout } : {})}
                  className={relationsBlockHeight}
                />
                <RelationsLegend t={t} model={model} />
              </div>
              {aside}
            </div>
          ) : (
            <div className="grid min-w-0 gap-3">
              {webgl && !unavailable ? null : (
                // Not a failure of the person's data: a quiet note, and the table that carries the same.
                <div className="grid max-w-4xl gap-1 rounded-lg border border-border bg-surface p-4 text-sm">
                  <p className="m-0 font-semibold text-foreground">
                    {t("mapRelations.failure.unavailable")}
                  </p>
                  <p className="m-0 text-secondary-foreground">
                    {t("mapRelations.failure.unavailableBody")}
                  </p>
                </div>
              )}
              {aside}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function TreeButton({ t, onClick }: { t: Translator; onClick: () => void }) {
  return (
    <Button type="button" variant="secondary" onClick={onClick}>
      <ListTree aria-hidden="true" />
      {t("mapRelations.empty.tree")}
    </Button>
  );
}

/** Loading keeps the layout: the canvas's block and the legend's two lines. */
function RelationsSkeleton({ t, tableOnly }: { t: Translator; tableOnly: boolean }) {
  return (
    <LoadingState
      t={t}
      delayMs={0}
      className={cn(
        !tableOnly && "min-[1180px]:grid-cols-[minmax(0,1fr)_26rem] min-[1180px]:gap-4"
      )}
    >
      {tableOnly ? null : (
        <div className="grid min-w-0 gap-3">
          <Skeleton className={cn(relationsBlockHeight, "rounded-lg")} />
          <div className="grid max-w-(--measure) gap-2">
            <Skeleton className="w-4/5" />
            <Skeleton className="w-3/5" />
          </div>
        </div>
      )}
      <div className={cn("grid min-w-0 content-start gap-3", tableOnly && "max-w-4xl")}>
        <Skeleton className="w-2/5" />
        <Skeleton className="h-10 rounded-lg" />
        <Skeleton className="h-10 rounded-lg" />
        <Skeleton className="h-10 rounded-lg" />
        <Skeleton className="h-10 rounded-lg" />
      </div>
    </LoadingState>
  );
}

/**
 * The legend (design record 7.5): each topic colour with its name, each line with its stance glyph
 * and word, the dashed suggestion, and what a line's thickness says zoomed out. Colour is never
 * the only signal: every dot has its name beside it.
 */
export function RelationsLegend({ t, model }: { t: Translator; model: BranchModel }) {
  return (
    <section
      aria-label={t("mapRelations.legend.label")}
      className="grid min-w-0 gap-1.5 text-xs text-secondary-foreground"
    >
      <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1.5 p-0">
        <li className="font-semibold text-foreground">{t("mapRelations.legend.topics")}</li>
        {model.groups.map((group) => (
          <li key={group.id} className="inline-flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: `var(--graph-topic-${(group.colourIndex % 12) + 1})` }}
            />
            {group.legendLabel}
          </li>
        ))}
        {model.unplaced > 0 ? (
          <li className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full bg-secondary-foreground"
            />
            {t("mapRelations.legend.unplaced")}
          </li>
        ) : null}
      </ul>
      <ul className="m-0 flex list-none flex-wrap items-center gap-x-4 gap-y-1.5 p-0">
        <li className="font-semibold text-foreground">{t("mapRelations.legend.lines")}</li>
        {model.stances.map((stance) => (
          <li
            key={stance}
            className={cn("inline-flex items-center gap-1.5", stanceTextClass[stance])}
          >
            <StanceGlyph stance={stance} size={12} />
            <span className="text-secondary-foreground">
              {t(relationTypeView(model.stanceTypes[stance] ?? "related").wordKey)}
            </span>
          </li>
        ))}
        {model.hasSuggestions ? (
          <li className="inline-flex items-center gap-1.5">
            <LineSample suggested />
            {t("mapRelations.legend.suggested")}
          </li>
        ) : null}
      </ul>
      {superNodeRatio(model) !== null ? (
        <p className="m-0">{t("mapRelations.legend.thickness")}</p>
      ) : null}
    </section>
  );
}

/** Reads `graphWheelZoomSensitivity` once shown, and again when the app settings change. */
function useWheelSensitivity(active: boolean): number {
  const [value, setValue] = useState(defaultSensitivity);
  const [request, setRequest] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    window.app.settings
      .getApp()
      .then((settings) => {
        if (live) setValue(settings.graphWheelZoomSensitivity);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [active, request]);
  useAppEvent(
    "settings.changed",
    (event) => {
      if (event.stores.includes("app")) setRequest((count) => count + 1);
    },
    active
  );
  return value;
}

/**
 * "Ramo: Fermentação ▾": the branch on screen, and the branches next to it (above, beside, inside)
 * and the areas of the tree. The neighbours are read only when the menu opens.
 */
function BranchPicker({
  t,
  model,
  wanted,
  active,
  onPick
}: {
  t: Translator;
  model: BranchModel | null;
  wanted: BranchScope | null;
  active: boolean;
  onPick: (scope: BranchScope) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<BranchChoices | null>(null);
  const parentId = model?.parentId ?? null;
  const scopeId = model?.scope.id ?? wanted?.id ?? null;
  useEffect(() => {
    if (!open || !active) return undefined;
    let live = true;
    void (async () => {
      try {
        const [siblings, areas] = await Promise.all([
          parentId ? window.app.topics.tree({ parentId, limit: 100 }) : Promise.resolve(null),
          window.app.topics.tree({ parentId: null, limit: 100 })
        ]);
        if (!live) return;
        const named = (node: { id: string; title: string | null }) => ({
          id: node.id,
          title: topicLabel(t, node.title ?? "")
        });
        setChoices(branchChoices(siblings, areas, scopeId, parentId, named));
      } catch {
        if (live) setChoices({ above: null, beside: [], areas: [] });
      }
    })();
    return () => {
      live = false;
    };
  }, [open, active, parentId, scopeId, t]);

  const label = model
    ? t(model.scope.kind === "source" ? "mapRelations.scope.source" : "mapRelations.scope.label", {
        values: { title: model.scopeTitle }
      })
    : t("mapRelations.scope.menu");
  const inside = model?.children;
  const sections = useMemo(
    () =>
      [
        {
          key: "above",
          label: t("mapRelations.scope.above"),
          items: choices?.above ? [choices.above] : []
        },
        { key: "inside", label: t("mapRelations.scope.inside"), items: inside ?? [] },
        { key: "beside", label: t("mapRelations.scope.beside"), items: choices?.beside ?? [] },
        { key: "areas", label: t("mapRelations.scope.areas"), items: choices?.areas ?? [] }
      ].filter((section) => section.items.length > 0),
    [choices, inside, t]
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          className="max-w-[min(22rem,100%)]"
          aria-label={`${label}. ${t("mapRelations.scope.menu")}`}
          disabled={!model}
        >
          <ObjectKindGlyph kind="topic" className="shrink-0 text-object-topic" />
          <span className="min-w-0 truncate" title={model?.scopeTitle}>
            {label}
          </span>
          <ChevronDown aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-80">
        {sections.length === 0 ? (
          <DropdownMenuLabel>{t("mapRelations.scope.menu")}</DropdownMenuLabel>
        ) : null}
        {sections.map((section, index) => (
          <div key={section.key}>
            {index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>{section.label}</DropdownMenuLabel>
            {section.items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                onSelect={() => onPick({ kind: "topic", id: item.id })}
              >
                {item.title}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
