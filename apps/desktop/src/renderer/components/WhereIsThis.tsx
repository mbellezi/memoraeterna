import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, MapPin, RefreshCw } from "lucide-react";
import type { ObjectLocateResult, ObjectPlacement } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import {
  navigationForLocated,
  navigationForPathSegment,
  navigationForPlacement,
  type ObjectNavigation
} from "../lib/object-navigation";
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
  items: readonly ObjectPlacement[];
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
                {item.title || t(`objects.kinds.${item.kind}` as MessageKey)}
              </button>
              <span className="text-xs text-muted-foreground">
                {t(`objects.kinds.${item.kind}` as MessageKey)}
              </span>
              {item.legacy ? (
                <span
                  title={t("objects.whereIsThis.legacyHint")}
                  className="rounded-full border border-border bg-soft px-1.5 py-0.5 text-xs text-muted-foreground"
                >
                  {t("objects.whereIsThis.legacy")}
                </span>
              ) : null}
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

/**
 * The "Where is this" panel: the path of an object from the library root (each segment opens),
 * the other places it appears in and the objects that cite it. It is an inline section, never a
 * dialog, and covers its loading, error, missing and ready states.
 */
export function WhereIsThisView({
  t,
  state,
  openFailed = false,
  onOpen,
  onRetry
}: {
  t: Translator;
  state: WhereIsThisState;
  openFailed?: boolean;
  onOpen: (navigation: ObjectNavigation) => void;
  onRetry: () => void;
}) {
  const headingId = useId();
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
                        {segment.title || t(`objects.kinds.${segment.kind}` as MessageKey)}
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
                        {segment.title || t(`objects.kinds.${segment.kind}` as MessageKey)}
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
 * Locates `address` (one read, no AI) and shows the answer. A hidden view loads nothing; showing it
 * again re-requests only when the address or `refreshKey` changed, and a refresh keeps the previous
 * answer on screen instead of blinking back to loading. A failure stays visible and retryable.
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
  const [openFailed, setOpenFailed] = useState(false);
  // The key of the last finished request, successful or not: a failed load stays visible until
  // the person retries, and showing the view again does not repeat a request that already ran.
  const finishedKey = useRef<string | null>(null);
  const key = `${address}|${refreshKey}|${attempt}`;

  useEffect(() => {
    if (!active || finishedKey.current === key) return;
    let live = true;
    setState((current) =>
      current.status === "ready" && current.address === address ? current : { status: "loading" }
    );
    window.app.objects
      .locate({ address })
      .then((result) => {
        if (!live) return;
        finishedKey.current = key;
        setState(result ? { status: "ready", address, result } : { status: "missing" });
      })
      .catch(() => {
        if (!live) return;
        finishedKey.current = key;
        setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [active, address, key]);

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

  return (
    <WhereIsThisView
      t={t}
      state={state}
      openFailed={openFailed}
      onOpen={(navigation) => void open(navigation)}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
}
