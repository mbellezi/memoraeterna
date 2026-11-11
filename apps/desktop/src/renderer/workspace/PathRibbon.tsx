import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  formatObjectAddress,
  parseObjectAddress,
  type ObjectLocateResult,
  type ObjectRef
} from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../components/glyphs";
import { Skeleton } from "../components/ui/skeleton";
import { useAppEvent } from "../lib/app-events";
import { cn } from "../lib/cn";
import { useObjectChanged } from "../lib/object-events";

/**
 * The path ribbon (design record §9; D8, X2): where an object sits in the topic tree, above the
 * title of every object panel, read with no click from `objects.locate`. Each crumb opens its topic
 * beside the panel (an `ObjectLink` placeholder until T144); the middle crumbs fold into "…" when
 * the ribbon would take more than two lines, and the root and the leaf are never cut.
 */

/** One crumb: a topic of the object's primary path. */
export interface RibbonSegment {
  /** `memora://topic/<id>`: what J3 compares with `objects.locate`. */
  address: string;
  id: string;
  /** Empty for a topic that is not named yet; the ribbon writes its own label. */
  title: string;
}

/** How the place is known: placed, tentative while a source or an answer is still being made. */
export type RibbonPlace = "placed" | "tentativeSource" | "tentativeQuestion" | "byCitations";

const topicAddress = (ref: ObjectRef) => formatObjectAddress({ kind: "topic", id: ref.id });

/**
 * The crumbs of a located object: the topics of its primary path from the root down, without the
 * tree's untitled root (the first entry of a topic path) and without the object itself. A source
 * chain and the note at the end are not part of the tree, so they are not crumbs. A Topic page's
 * crumbs are its ancestors.
 */
export function ribbonSegments(located: ObjectLocateResult): RibbonSegment[] {
  const path = located.primaryPath;
  const own = (ref: ObjectRef) => ref.kind === located.object.kind && ref.id === located.object.id;
  return path
    .filter((ref, index) => ref.kind === "topic" && !own(ref) && !(index === 0 && ref.title === ""))
    .map((ref) => ({ address: topicAddress(ref), id: ref.id, title: ref.title }));
}

/**
 * Whether a located object has no place in the tree: no read result, or a primary path with no
 * topic but the object itself. A top-level topic (its path is the root and itself) is placed: its
 * only ancestor is the untitled root, so it has no crumbs, but it is never drawn as unsorted.
 */
export function isUnsorted(located: ObjectLocateResult | null): boolean {
  if (!located) return true;
  const { object } = located;
  return !located.primaryPath.some(
    (ref) => ref.kind === "topic" && !(ref.kind === object.kind && ref.id === object.id)
  );
}

/** A run of crumbs folded into the "…" button. */
export interface FoldedCrumbs {
  folded: number;
}

/**
 * The crumbs with `hidden` middle crumbs folded into one "…" entry. The first crumb (the root of
 * the shown path) and the last one (the leaf) always stay; at most every crumb between them folds.
 */
export function foldMiddle<T>(segments: readonly T[], hidden: number): (T | FoldedCrumbs)[] {
  const foldable = Math.max(0, segments.length - 2);
  const count = Math.min(Math.max(0, Math.floor(hidden)), foldable);
  if (count === 0) return [...segments];
  // Fold from the crumb just after the root, so the crumbs nearest the leaf stay readable.
  return [segments[0] as T, { folded: count }, ...segments.slice(1 + count)];
}

const isFolded = (entry: unknown): entry is FoldedCrumbs =>
  typeof entry === "object" && entry !== null && "folded" in entry;

/** The ribbon's read of `objects.locate`. */
export type Located =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; located: ObjectLocateResult | null };

/**
 * Reads `objects.locate` for an address. It returns the read, a retry that shows the skeleton, and
 * a quiet re-read that keeps the shown place until the new one arrives.
 */
function useLocated(address: string, active: boolean): [Located, () => void, () => void] {
  const [state, setState] = useState<Located>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    const objects = typeof window === "undefined" ? undefined : window.app?.objects;
    const read = objects
      ? objects.locate({ address })
      : Promise.reject(new Error("objects.locate is not available"));
    read
      .then((located) => {
        if (live) setState({ status: "ready", located });
      })
      .catch(() => {
        // A failed re-read keeps the place that is shown; a first read says it failed.
        if (live)
          setState((current) => (current.status === "ready" ? current : { status: "error" }));
      });
    return () => {
      live = false;
    };
  }, [address, active, attempt]);
  return [
    state,
    () => {
      setState({ status: "loading" });
      setAttempt((value) => value + 1);
    },
    () => setAttempt((value) => value + 1)
  ];
}

export interface PathRibbonProps {
  t: Translator;
  /** The object's address (an anchor is ignored: a passage sits where its source sits). */
  address: string;
  /** The previous panel's compact form: 12 px. */
  compact?: boolean;
  place?: RibbonPlace;
  /** A hidden panel listens to nothing and reads again when it is shown. */
  active?: boolean;
  /** Opens a crumb's topic beside the panel. */
  onOpen: (address: string) => void;
  /** "Escolher lugar" on an unplaced object; absent, the ribbon only says "Sem lugar". */
  onChoosePlace?: () => void;
}

/** The ribbon's line height in px per size: two lines at most before the middle folds. */
const lineHeight = { regular: 20, compact: 16 } as const;

export function PathRibbon(props: PathRibbonProps) {
  const { address, active = true } = props;
  const parsed = parseObjectAddress(address);
  const objectAddress = parsed
    ? formatObjectAddress({ kind: parsed.kind, id: parsed.id })
    : address;
  const [located, retry, reread] = useLocated(objectAddress, active);
  // The place follows the object and every topic of its path: a renamed or moved ancestor, or a
  // tree change that places the object elsewhere, reads the place again.
  const crumbs =
    located.status === "ready" && located.located ? ribbonSegments(located.located) : [];
  useObjectChanged([objectAddress, ...crumbs.map((crumb) => crumb.address)], reread, active);
  useAppEvent("tree.changed", reread, active);
  return <PathRibbonView {...props} located={located} onRetry={retry} />;
}

/** The ribbon for a read of the place (`PathRibbon` reads it; a test passes its own). */
export function PathRibbonView({
  t,
  address,
  compact = false,
  place = "placed",
  onOpen,
  onChoosePlace,
  located,
  onRetry: retry
}: PathRibbonProps & { located: Located; onRetry: () => void }) {
  const parsed = parseObjectAddress(address);
  const segments =
    located.status === "ready" && located.located ? ribbonSegments(located.located) : [];
  const isTopic = parsed?.kind === "topic";

  // Folding: the crumb line may take two lines; past that the middle folds, one crumb at a time.
  const line = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState(0);
  const segmentKey = segments.map((segment) => segment.id).join(",");
  // A fallback font is wider than the interface font: the path measures again once fonts load.
  const [fonts, setFonts] = useState(0);
  useEffect(() => {
    const faces = typeof document === "undefined" ? undefined : document.fonts;
    if (!faces) return undefined;
    let live = true;
    const loaded = () => {
      if (live) setFonts((value) => value + 1);
    };
    void faces.ready.then(loaded);
    faces.addEventListener("loadingdone", loaded);
    return () => {
      live = false;
      faces.removeEventListener("loadingdone", loaded);
    };
  }, []);
  // A new width, path, size or font measures again from the whole path.
  const foldKey = `${width}|${segmentKey}|${compact ? "compact" : "regular"}|${fonts}`;
  const [fold, setFold] = useState({ key: foldKey, hidden: 0 });
  const hidden = fold.key === foldKey ? fold.hidden : 0;
  useEffect(() => {
    const node = line.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [located.status]);
  useLayoutEffect(() => {
    const node = line.current;
    if (!node || expanded) return;
    const limit = 2 * (compact ? lineHeight.compact : lineHeight.regular) + 2;
    if (node.getBoundingClientRect().height > limit && hidden < segments.length - 2)
      setFold({ key: foldKey, hidden: hidden + 1 });
  }, [hidden, expanded, segments.length, compact, foldKey]);

  const size = compact ? "text-xs leading-4" : "text-sm leading-5";
  const shell = cn(
    "mb-2 flex min-w-0 flex-wrap items-start gap-x-1 text-secondary-foreground",
    size
  );

  if (located.status === "loading")
    return (
      <nav
        aria-label={t("panelFrame.ribbon.label")}
        aria-busy="true"
        data-path-ribbon=""
        data-ribbon-state="loading"
        className={cn(shell, "h-5 items-center")}
      >
        <span className="sr-only">{t("panelFrame.ribbon.loading")}</span>
        <Skeleton className="h-3 w-40" />
      </nav>
    );

  if (located.status === "error")
    return (
      <nav
        aria-label={t("panelFrame.ribbon.label")}
        data-path-ribbon=""
        data-ribbon-state="error"
        className={shell}
      >
        <span>{t("panelFrame.ribbon.error")}</span>
        <span aria-hidden="true" className="text-muted-foreground">
          ·
        </span>
        <button
          type="button"
          onClick={retry}
          className="rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {t("panelFrame.ribbon.retry")}
        </button>
      </nav>
    );

  if (located.status === "ready" && isUnsorted(located.located))
    return (
      <nav
        aria-label={t("panelFrame.ribbon.label")}
        data-path-ribbon=""
        data-ribbon-state="unsorted"
        className={shell}
      >
        <ObjectKindGlyph kind="topic" size={14} className="mt-[3px] text-muted-foreground" />
        <span>{t("panelFrame.ribbon.unsorted")}</span>
        {onChoosePlace ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <button
              type="button"
              onClick={onChoosePlace}
              className="rounded-sm text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t("panelFrame.ribbon.choosePlace")}
            </button>
          </>
        ) : null}
      </nav>
    );

  const tentative = place === "tentativeSource" || place === "tentativeQuestion";
  const dashed = "border-b border-dashed border-border-strong italic";
  // A placed object with no crumbs is a top-level topic: its only ancestor is the root.
  if (segments.length === 0 && !tentative)
    return (
      <nav
        aria-label={t("panelFrame.ribbon.label")}
        data-path-ribbon=""
        data-ribbon-state="placed"
        className={shell}
      >
        <ObjectKindGlyph
          kind="topic"
          size={compact ? 12 : 14}
          className={cn("text-object-topic", compact ? "mt-[2px]" : "mt-[3px]")}
        />
        <span>{t("panelFrame.ribbon.topLevel")}</span>
      </nav>
    );
  const shown = expanded ? segments : foldMiddle(segments, hidden);
  const crumbs = shown.map((entry, index) => {
    const separator =
      index > 0 ? (
        <span aria-hidden="true" className="text-muted-foreground">
          ›
        </span>
      ) : null;
    if (isFolded(entry))
      return (
        <Fragment key="folded">
          {separator}
          <button
            type="button"
            aria-label={t("panelFrame.ribbon.expand")}
            title={t("panelFrame.ribbon.expand")}
            onClick={() => setExpanded(true)}
            className={cn(
              "rounded-sm px-0.5 hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              tentative && dashed
            )}
          >
            …
          </button>
        </Fragment>
      );
    const leaf = !isTopic && index === shown.length - 1;
    const label = entry.title === "" ? t("panelFrame.ribbon.untitled") : entry.title;
    return (
      <Fragment key={entry.id}>
        {separator}
        <button
          type="button"
          data-segment={entry.address}
          aria-current={leaf ? "location" : undefined}
          onClick={() => onOpen(entry.address)}
          className={cn(
            "max-w-full rounded-sm text-left [overflow-wrap:anywhere] underline-offset-[3px] hover:text-accent hover:underline",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            leaf && "font-semibold text-foreground",
            entry.title === "" && "italic",
            tentative && dashed
          )}
        >
          {label}
        </button>
      </Fragment>
    );
  });

  const others = located.status === "ready" ? (located.located?.alsoIn ?? []) : [];
  const otherCount = located.status === "ready" ? (located.located?.counts.alsoIn ?? 0) : 0;
  const first = others[0];
  const clause =
    place === "tentativeSource"
      ? t("panelFrame.ribbon.tentativeSource")
      : place === "tentativeQuestion"
        ? t("panelFrame.ribbon.tentativeQuestion")
        : place === "byCitations"
          ? t("panelFrame.ribbon.placedByCitations")
          : null;

  return (
    <nav
      aria-label={t("panelFrame.ribbon.label")}
      data-path-ribbon=""
      data-ribbon-state={tentative ? "tentative" : "placed"}
      className={cn("mb-2 min-w-0", size)}
    >
      <span
        ref={line}
        className="flex min-w-0 flex-wrap items-start gap-x-1 text-secondary-foreground"
      >
        <ObjectKindGlyph
          kind="topic"
          size={compact ? 12 : 14}
          className={cn("mr-0.5 text-object-topic", compact ? "mt-[2px]" : "mt-[3px]")}
        />
        {tentative ? (
          <span className="text-muted-foreground">{t("panelFrame.ribbon.tentative")}</span>
        ) : null}
        {/* The crumbs are items of the glyph's own line: a box around them would be one flex item
            as wide as the whole path, and would drop to a line of its own under the glyph. */}
        {crumbs}
        {clause ? (
          // A trailing clause wraps whole, and a line never starts with its separator.
          <span className="whitespace-normal text-muted-foreground [text-wrap:pretty]">
            <span aria-hidden="true">· </span>
            {clause}
          </span>
        ) : null}
      </span>
      {first ? (
        <span
          className={cn(
            "block text-muted-foreground [text-wrap:pretty]",
            compact ? "text-xs leading-4" : "text-xs leading-5"
          )}
        >
          {t("panelFrame.ribbon.alsoIn")}{" "}
          <button
            type="button"
            data-also-in={topicAddress(first)}
            onClick={() => onOpen(topicAddress(first))}
            className={cn(
              "rounded-sm text-secondary-foreground underline-offset-[3px] hover:text-accent",
              "hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            )}
          >
            {first.title === "" ? t("panelFrame.ribbon.untitled") : first.title}
          </button>
          {otherCount > 1 ? (
            <> {t("panelFrame.ribbon.andMore", { values: { count: otherCount - 1 } })}</>
          ) : null}
        </span>
      ) : null}
    </nav>
  );
}
