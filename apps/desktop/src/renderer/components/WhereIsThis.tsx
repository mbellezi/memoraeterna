import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, MapPin, RefreshCw } from "lucide-react";
import type { ObjectLocateResult, ObjectRef } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import { isSilentRefresh, showsLoadError, type LoadOutcome } from "../lib/hidden-view";
import { useTopicsPulse } from "../lib/topics-pulse";
import {
  navigationForLocated,
  navigationForPathSegment,
  navigationForPlacement,
  type ObjectNavigation
} from "../lib/object-navigation";
import { ObjectKindGlyph, objectKindTextClass } from "./glyphs";
import { Button } from "./ui/button";

/** A navigation the owner of the view can carry out; the panel resolves the rest by locating. */
export type OpenableNavigation = Exclude<ObjectNavigation, { type: "none" | "resolve" }>;

export type WhereIsThisState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; address: string; result: ObjectLocateResult };

const linkClass =
  "rounded-md px-1.5 py-0.5 text-left text-accent hover:bg-soft hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * What an object reference reads as: its title or, when it has none to show, the localized label of
 * what it is. The tree root and a topic that is not named yet come back from `objects.locate` with
 * an empty title (D11 stores no placeholder); the root is the first segment of a path that starts
 * with a topic, as in the breadcrumb of the Topic page.
 */
export function objectLabel(t: Translator, ref: ObjectRef, pathIndex?: number): string {
  if (ref.title) return ref.title;
  if (ref.kind === "topic")
    return pathIndex === 0 ? t("topics.page.rootTitle") : t("topics.page.unnamed");
  return t(`objects.kinds.${ref.kind}` as MessageKey);
}

function PlacementList({
  t,
  heading,
  empty,
  items,
  total,
  onOpen
}: {
  t: Translator;
  heading: string;
  empty: string;
  items: readonly ObjectRef[];
  total: number;
  onOpen: (navigation: ObjectNavigation) => void;
}) {
  return (
    <div className="grid content-start gap-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
        {total > 0 ? ` · ${total}` : ""}
      </h4>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-0.5">
          {items.map((item) => (
            <li key={`${item.kind}:${item.id}`} className="flex flex-wrap items-center gap-x-2">
              <button
                type="button"
                className={`${linkClass} min-w-0 max-w-full truncate text-sm`}
                onClick={() => onOpen(navigationForPlacement(item))}
              >
                {objectLabel(t, item)}
              </button>
              <span className="text-xs text-muted-foreground">
                {t(`objects.kinds.${item.kind}` as MessageKey)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {total > items.length ? (
        <p className="text-xs text-muted-foreground">
          {t("objects.whereIsThis.more", { values: { count: total - items.length } })}
        </p>
      ) : null}
    </div>
  );
}

const pageLinkClass = "max-w-56 truncate text-left text-accent hover:underline";

/** The ancestors of the object on its primary path: the object itself is the page it is shown on. */
export function primaryPathAncestors(result: ObjectLocateResult): ObjectRef[] {
  const last = result.primaryPath.at(-1);
  return last && last.kind === result.object.kind && last.id === result.object.id
    ? result.primaryPath.slice(0, -1)
    : [...result.primaryPath];
}

function PlacementChips({
  t,
  items,
  total,
  stacked,
  onOpen
}: {
  t: Translator;
  items: readonly ObjectRef[];
  total: number;
  stacked: boolean;
  onOpen: (navigation: ObjectNavigation) => void;
}) {
  return (
    <>
      <ul className={stacked ? "flex flex-col items-start gap-1.5" : "flex flex-wrap gap-1.5"}>
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`} className="flex max-w-full items-center gap-1.5">
            <button
              type="button"
              className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-border px-2 text-sm hover:bg-surface-hover"
              onClick={() => onOpen(navigationForPlacement(item))}
            >
              <ObjectKindGlyph kind={item.kind} className={objectKindTextClass[item.kind]} />
              <span className="truncate">{objectLabel(t, item)}</span>
              <span className="sr-only"> · {t(`objects.kinds.${item.kind}` as MessageKey)}</span>
            </button>
          </li>
        ))}
      </ul>
      {total > items.length ? (
        <p className="pt-1 text-xs text-muted-foreground">
          {t("objects.whereIsThis.more", { values: { count: total - items.length } })}
        </p>
      ) : null}
    </>
  );
}

/** Where an object is, laid out as a section of its page: only the rows that have entries. */
function WhereIsThisPage({
  t,
  headingId,
  state,
  openFailed,
  onOpen,
  onRetry
}: {
  t: Translator;
  headingId: string;
  state: WhereIsThisState;
  openFailed: boolean;
  onOpen: (navigation: ObjectNavigation) => void;
  onRetry: () => void;
}) {
  const result = state.status === "ready" ? state.result : null;
  const ancestors = result ? primaryPathAncestors(result) : [];
  const rows = result
    ? [ancestors.length > 0, result.alsoIn.length > 0, result.citedBy.length > 0]
    : [false, false, false];
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={state.status === "loading"}
      data-testid="where-is-this"
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <h2 id={headingId} className="text-lg font-semibold">
        {t("objects.whereIsThis.title")}
      </h2>
      <WhereIsThisStates t={t} state={state} onRetry={onRetry} />
      {result && rows.some(Boolean) ? (
        <dl className="grid grid-cols-[8.25rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
          {rows[0] ? (
            <>
              <dt className="pt-0.5 text-xs text-muted-foreground">
                {t("notePage.where.primaryPath")}
              </dt>
              <dd className="min-w-0">
                <ol className="flex flex-wrap items-center gap-1">
                  {ancestors.map((segment, index) => {
                    const navigation = navigationForPathSegment(result.primaryPath, index);
                    const title = objectLabel(t, segment, index);
                    return (
                      <li
                        key={`${segment.kind}:${segment.id}`}
                        className="flex min-w-0 items-center gap-1"
                      >
                        {index > 0 ? (
                          <ChevronRight
                            className="size-3 text-muted-foreground"
                            aria-hidden="true"
                          />
                        ) : null}
                        {navigation.type === "none" ? (
                          <span className="max-w-56 truncate">{title}</span>
                        ) : (
                          <button
                            type="button"
                            className={pageLinkClass}
                            onClick={() => onOpen(navigation)}
                          >
                            {title}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </dd>
            </>
          ) : null}
          {rows[1] ? (
            <>
              <dt className="pt-0.5 text-xs text-muted-foreground">
                {t("objects.whereIsThis.alsoIn")}
              </dt>
              <dd className="min-w-0">
                <PlacementChips
                  t={t}
                  items={result.alsoIn}
                  total={result.counts.alsoIn}
                  stacked={false}
                  onOpen={onOpen}
                />
              </dd>
            </>
          ) : null}
          {rows[2] ? (
            <>
              <dt className="pt-0.5 text-xs text-muted-foreground">
                {t("notePage.where.citedIn")}
              </dt>
              <dd className="min-w-0">
                <PlacementChips
                  t={t}
                  items={result.citedBy}
                  total={result.counts.citedBy}
                  stacked
                  onOpen={onOpen}
                />
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {openFailed ? (
        <p role="alert" className="text-sm text-foreground">
          {t("objects.whereIsThis.openFailed")}
        </p>
      ) : null}
    </section>
  );
}

/** Loading, missing and failed states, shared by both layouts. */
function WhereIsThisStates({
  t,
  state,
  onRetry
}: {
  t: Translator;
  state: WhereIsThisState;
  onRetry: () => void;
}) {
  return (
    <>
      {state.status === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("objects.whereIsThis.loading")}
        </p>
      ) : null}
      {state.status === "missing" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("objects.whereIsThis.missing")}
        </p>
      ) : null}
      {state.status === "error" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-foreground">
            {t("objects.whereIsThis.error")}
          </p>
          <Button type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * The "Where is this" panel: the path of an object (the topics from the root of the topic tree,
 * then its source chain; each segment opens), the other topics it is placed in and the objects that
 * cite it. It is an inline section, never a
 * dialog, and covers its loading, error, missing and ready states. The `page` variant is the
 * section of an object page: the object itself is the page, so its path lists only ancestors, and
 * rows without entries are left out.
 */
export function WhereIsThisView({
  t,
  state,
  openFailed = false,
  variant = "panel",
  onOpen,
  onRetry
}: {
  t: Translator;
  state: WhereIsThisState;
  openFailed?: boolean;
  variant?: "panel" | "page";
  onOpen: (navigation: ObjectNavigation) => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  if (variant === "page")
    return (
      <WhereIsThisPage
        t={t}
        headingId={headingId}
        state={state}
        openFailed={openFailed}
        onOpen={onOpen}
        onRetry={onRetry}
      />
    );
  const result = state.status === "ready" ? state.result : null;
  const counts = result
    ? (["passages", "notes", "children"] as const).filter((name) => result.counts[name] > 0)
    : [];
  return (
    <section
      aria-labelledby={headingId}
      aria-busy={state.status === "loading"}
      data-testid="where-is-this"
      className="grid gap-3 rounded-xl border border-border bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3
          id={headingId}
          className="flex items-center gap-2 text-sm font-semibold text-foreground"
        >
          <MapPin className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("objects.whereIsThis.title")}
        </h3>
        {counts.length > 0 && result ? (
          <dl className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
            {counts.map((name) => (
              <div key={name} className="flex gap-1">
                <dt>{t(`objects.whereIsThis.counts.${name}` as MessageKey)}</dt>
                <dd className="font-semibold tabular-nums text-foreground">
                  {result.counts[name]}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      <WhereIsThisStates t={t} state={state} onRetry={onRetry} />
      {result ? (
        <>
          <nav aria-label={t("objects.whereIsThis.path")}>
            <ol className="flex flex-wrap items-center gap-1 text-sm">
              {result.primaryPath.map((segment, index) => {
                const navigation = navigationForPathSegment(result.primaryPath, index);
                const current = index === result.primaryPath.length - 1;
                return (
                  <li key={`${segment.kind}:${segment.id}`} className="flex items-center gap-1">
                    {index > 0 ? (
                      <ChevronRight
                        className="h-3.5 w-3.5 text-muted-foreground"
                        aria-hidden="true"
                      />
                    ) : null}
                    {navigation.type === "none" ? (
                      <span
                        aria-current={current ? "location" : undefined}
                        className="max-w-72 truncate px-1.5 py-0.5 font-medium text-foreground"
                      >
                        {objectLabel(t, segment, index)}
                        {current ? (
                          <span className="sr-only"> · {t("objects.whereIsThis.here")}</span>
                        ) : null}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`${linkClass} max-w-56 truncate`}
                        onClick={() => onOpen(navigation)}
                      >
                        {objectLabel(t, segment, index)}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="grid gap-4 sm:grid-cols-2">
            <PlacementList
              t={t}
              heading={t("objects.whereIsThis.alsoIn")}
              empty={t("objects.whereIsThis.alsoInEmpty")}
              items={result.alsoIn}
              total={result.counts.alsoIn}
              onOpen={onOpen}
            />
            <PlacementList
              t={t}
              heading={t("objects.whereIsThis.citedBy")}
              empty={t("objects.whereIsThis.citedByEmpty")}
              items={result.citedBy}
              total={result.counts.citedBy}
              onOpen={onOpen}
            />
          </div>
        </>
      ) : null}
      {openFailed ? (
        <p role="alert" className="text-sm text-foreground">
          {t("objects.whereIsThis.openFailed")}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Opens what a "Where is this" entry points at: sources, notes and topics go straight to the
 * owner; anything else is located first. `openFailed` reports an entry that could not be opened.
 */
export function useObjectOpener(onNavigate: (navigation: OpenableNavigation) => void) {
  const [openFailed, setOpenFailed] = useState(false);
  const open = useCallback(
    async (navigation: ObjectNavigation) => {
      setOpenFailed(false);
      if (navigation.type === "none") return;
      if (navigation.type !== "resolve") {
        onNavigate(navigation);
        return;
      }
      try {
        const located = await window.app.objects.locate({ address: navigation.address });
        const resolved = located ? navigationForLocated(located) : null;
        if (resolved && resolved.type !== "none" && resolved.type !== "resolve")
          onNavigate(resolved);
        else setOpenFailed(true);
      } catch {
        setOpenFailed(true);
      }
    },
    [onNavigate]
  );
  return { open: (navigation: ObjectNavigation) => void open(navigation), openFailed };
}

/**
 * What the panel does when it renders: nothing while hidden or when the key already finished
 * (a failure stays visible until Retry), a silent refresh when the topic tree changed (`pulsed`) or
 * when it is shown again with the same key after a successful load, otherwise a load.
 */
export function locateLoadDecision(input: {
  active: boolean;
  wasHidden: boolean;
  outcome: LoadOutcome | null;
  key: string;
  /** The topic tree changed since the last read: the path may have moved. */
  pulsed?: boolean;
}): "skip" | "silent" | "load" {
  if (!input.active) return "skip";
  if (input.pulsed) return "silent";
  if (isSilentRefresh(input.wasHidden, input.outcome, input.key)) return "silent";
  return input.outcome?.key === input.key ? "skip" : "load";
}

/**
 * Locates `address` (one read, no AI) and shows the answer. A hidden view loads nothing; shown again
 * it refreshes in place when its key is unchanged and the last load succeeded (citations and the
 * path may have changed meanwhile), and re-requests when the address or `refreshKey` changed. While
 * shown it also reads again, in place, after the topic tree changed (a rebalance, a rename or a
 * move can change the path). A refresh keeps the previous answer on screen instead of blinking back
 * to loading. A failure stays visible and retryable.
 */
export function WhereIsThis({
  t,
  address,
  active = true,
  refreshKey = 0,
  onNavigate
}: {
  t: Translator;
  address: string;
  active?: boolean;
  /** Changes when what the answer depends on changed (for example after the source was reloaded). */
  refreshKey?: number | string;
  onNavigate: (navigation: OpenableNavigation) => void;
}) {
  const [state, setState] = useState<WhereIsThisState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const opener = useObjectOpener(onNavigate);
  const outcome = useRef<LoadOutcome | null>(null);
  const wasHidden = useRef(false);
  const readPulse = useRef(0);
  const pulse = useTopicsPulse(active);
  const key = `${address}|${refreshKey}|${attempt}`;

  useEffect(() => {
    const decision = locateLoadDecision({
      active,
      wasHidden: wasHidden.current,
      outcome: outcome.current,
      key,
      pulsed: pulse !== readPulse.current
    });
    if (!active) {
      wasHidden.current = true;
      return;
    }
    wasHidden.current = false;
    readPulse.current = pulse;
    if (decision === "skip") return;
    const silent = decision === "silent";
    let live = true;
    if (!silent)
      setState((current) =>
        current.status === "ready" && current.address === address ? current : { status: "loading" }
      );
    window.app.objects
      .locate({ address })
      .then((result) => {
        if (!live) return;
        outcome.current = { key, ok: true, hasData: Boolean(result) };
        setState(result ? { status: "ready", address, result } : { status: "missing" });
      })
      .catch(() => {
        if (!live) return;
        const previous = outcome.current;
        outcome.current = { key, ok: false, hasData: false };
        if (showsLoadError({ silent, previous, key })) setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [active, address, key, pulse]);

  return (
    <WhereIsThisView
      t={t}
      state={state}
      openFailed={opener.openFailed}
      onOpen={opener.open}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
}
