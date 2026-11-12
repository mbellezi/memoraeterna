import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode
} from "react";
import { ArrowRight } from "lucide-react";
import { parseObjectAddress, type ObjectKind } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../components/glyphs";
import { ErrorState } from "../components/ui/error-state";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../components/ui/hover-card";
import { Kbd } from "../components/ui/kbd";
import { LoadingState, Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/cn";
import { useObjectChanged } from "../lib/object-events";
import {
  anchorsPassage,
  countKey,
  isRelationLink,
  kindWordKeys,
  placeOf,
  previewCounts,
  surfaceState,
  titleOf,
  type PreviewState
} from "./ObjectLinkModel";
import { previewBatcher, type PreviewBatcher, type PreviewResult } from "./preview-batcher";

/**
 * The object link (D15, design record §10.1): every place that points at an object (a Markdown
 * `memora://` link, a path crumb, a row that says where something is) is one `ObjectLink`. A click
 * or Enter opens the object beside the panel that holds the link, Option-click in it; the hover
 * card opens after 300 ms of hover or of keyboard focus, stays while the pointer is on it, closes
 * with Esc and never traps focus; Space peeks (quick-look reads the `data-quick-look` attribute).
 * A citation chip or a relation row of the context panel is not an `ObjectLink` and shows no card.
 */

export interface ObjectOpenOptions {
  /** Option-click and Option-Enter: open in this panel, not beside it. */
  replace?: boolean;
}
export type ObjectOpen = (address: string, options?: ObjectOpenOptions) => void;

interface ObjectLinkContextValue {
  t: Translator;
  onOpen: ObjectOpen;
}

const ObjectLinkContext = createContext<ObjectLinkContextValue | null>(null);

/** What a link needs from the panel around it: the translator and where "open beside" goes. */
export function ObjectLinkProvider({
  t,
  onOpen,
  children
}: ObjectLinkContextValue & { children: ReactNode }) {
  return <ObjectLinkContext.Provider value={{ t, onOpen }}>{children}</ObjectLinkContext.Provider>;
}

export function useObjectLinkContext(): ObjectLinkContextValue | null {
  return useContext(ObjectLinkContext);
}

// ---------------------------------------------------------------------------------------------
// The read behind the card and the sheet.

export interface ObjectPreview {
  state: PreviewState;
  /** The state answers the address asked for; false while the next object's read is on its way. */
  current: boolean;
  retry: () => void;
}

const toState = (result: PreviewResult): PreviewState =>
  result.status === "ready" ? { status: "ready", item: result.item } : { status: "missing" };

/**
 * Reads an address through the batcher while `enabled`, and again when the object changes (the
 * bus's `object.changed`; no timer). A new address keeps the last answer on screen, marked not
 * `current`, until its own arrives, so peeking from row to row does not blink.
 */
export function useObjectPreview(
  address: string,
  enabled: boolean,
  batcher?: PreviewBatcher
): ObjectPreview {
  const [held, setHeld] = useState<{ address: string; state: PreviewState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    // The first read of an address may share a call already on its way; a re-read after a change
    // (or a retry) must not, since that call may have read before the commit.
    (batcher ?? previewBatcher())
      .request(address, attempt > 0 ? { fresh: true } : undefined)
      .then((result) => {
        if (live) setHeld({ address, state: toState(result) });
      })
      .catch(() => {
        // A failed re-read keeps what is shown; a first read says it failed.
        if (live)
          setHeld((current) =>
            current?.address === address && current.state.status === "ready"
              ? current
              : { address, state: { status: "error" } }
          );
      });
    return () => {
      live = false;
    };
  }, [address, enabled, attempt, batcher]);
  useObjectChanged([address], () => setAttempt((value) => value + 1), enabled);
  return {
    state: held?.state ?? { status: "loading" },
    current: held?.address === address,
    retry: () => {
      setHeld(null);
      setAttempt((value) => value + 1);
    }
  };
}

// ---------------------------------------------------------------------------------------------
// The card.

const untitledTopic: MessageKey = "panelFrame.ribbon.untitled";

/** The crumbs of an object's place as one line of words: "Life sciences › Microbiology". */
export function PlaceText({
  t,
  path,
  className
}: {
  t: Translator;
  path: readonly { title: string }[];
  className?: string;
}) {
  if (path.length === 0)
    return <span className={className}>{t("panelFrame.ribbon.unsorted")}</span>;
  return (
    <span className={className}>
      {path.map((crumb, index) => (
        <span key={index}>
          {index > 0 ? (
            <span aria-hidden="true" className="px-1 text-muted-foreground">
              ›
            </span>
          ) : null}
          {crumb.title === "" ? t(untitledTopic) : crumb.title}
        </span>
      ))}
    </span>
  );
}

/** The skeleton in the shape of the card, so it keeps its size when the object arrives. */
function CardSkeleton() {
  return (
    <div className="grid gap-3" data-card-skeleton="">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-5 w-4/5" />
      <Skeleton className="h-3 w-3/5" />
      <div className="grid gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

/**
 * What the card shows of an object: its kind, title and place, the first lines of its text (the
 * anchored passage when the address has one), its counts and the two keys. It carries its own
 * `data-surface` and `data-state`.
 */
export function ObjectCard({
  t,
  address,
  preview
}: {
  t: Translator;
  address: string;
  preview: Pick<ObjectPreview, "state" | "retry">;
}) {
  const { state, retry } = preview;
  const surface = surfaceState(state);
  const parsed = parseObjectAddress(address);
  const kind: ObjectKind = state.status === "ready" ? state.item.kind : (parsed?.kind ?? "note");
  const relation = isRelationLink(address);

  let body: ReactNode;
  if (state.status === "loading") {
    body = (
      <LoadingState t={t} className="min-w-0">
        <CardSkeleton />
      </LoadingState>
    );
  } else if (state.status === "error") {
    body = (
      <ErrorState
        t={t}
        message={t("preview.card.error")}
        kept={t("preview.card.errorKept")}
        onRetry={retry}
        retryLabel={t("shell.actions.retry")}
      />
    );
  } else if (state.status === "missing") {
    body = (
      <p className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">
        {t("preview.card.missing")}
      </p>
    );
  } else {
    const { item } = state;
    const place = placeOf(item);
    const counts = previewCounts(item);
    const passage = anchorsPassage(address);
    const status =
      item.status === "retired"
        ? t("preview.card.status.retired")
        : item.status === "redirected"
          ? t("preview.card.status.redirected")
          : null;
    body = (
      <div className="grid min-w-0 gap-2.5">
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-secondary-foreground">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <ObjectKindGlyph kind={kind} size={14} className={objectKindTextClass[kind]} />
            {t(kindWordKeys[kind])}
          </span>
          {[relation ? t("preview.card.relation") : null, status].map((word) =>
            word ? (
              <span key={word} className="inline-flex gap-2 text-muted-foreground">
                <span aria-hidden="true">·</span>
                {word}
              </span>
            ) : null
          )}
        </p>
        <p
          title={titleOf(item, t(kindWordKeys[kind]))}
          className="m-0 line-clamp-2 font-reading text-base leading-snug font-semibold [overflow-wrap:anywhere]"
        >
          {titleOf(item, t(kindWordKeys[kind]))}
        </p>
        {relation ? (
          <div className="grid gap-0.5 rounded-md bg-soft px-3 py-2" data-go-to="">
            <span className="inline-flex items-center gap-1.5 text-xs text-secondary-foreground">
              <ArrowRight aria-hidden="true" className="size-3 text-muted-foreground" />
              {t("preview.card.goTo")}
            </span>
            <PlaceText
              t={t}
              path={item.kind === "topic" ? [...place, item] : place}
              className="text-sm font-semibold text-foreground [text-wrap:pretty]"
            />
          </div>
        ) : place.length > 0 ? (
          <p className="m-0 text-xs leading-5 text-secondary-foreground [text-wrap:pretty]">
            <PlaceText t={t} path={place} />
          </p>
        ) : null}
        {surface === "empty" ? (
          <p className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">
            {t("preview.card.empty")}
          </p>
        ) : (
          <div className="grid gap-1">
            {passage ? (
              <span className="text-xs text-muted-foreground">{t("preview.card.passage")}</span>
            ) : null}
            <p
              className={cn(
                "m-0 line-clamp-3 font-reading text-sm leading-snug text-secondary-foreground [text-wrap:pretty]",
                passage && "italic"
              )}
            >
              {item.preview}
            </p>
          </div>
        )}
        {counts.length > 0 ? (
          <p className="m-0 text-xs text-muted-foreground">
            {counts.map((entry, index) => (
              <span key={entry.name}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                {t(countKey(entry), { values: { count: entry.count } })}
              </span>
            ))}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    // The card is drawn in the interface font wherever it hangs (in a portal, or inside a reading column).
    <div data-surface="object-card" data-state={surface} className="grid min-w-0 gap-3 font-sans">
      {body}
      <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2.5 text-xs text-secondary-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd>
          {t("preview.card.keys.open")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>{t("preview.quickLook.keys.space")}</Kbd>
          {t("preview.card.keys.peek")}
        </span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The link.

type AnchorProps = Omit<ComponentPropsWithoutRef<"a">, "href" | "onClick" | "children">;

export interface ObjectLinkProps extends AnchorProps {
  /** `memora://<kind>/<uuid>`, with the anchors the link points at. */
  address: string;
  children: ReactNode;
  /** The panel's translator and opener; absent, the nearest `ObjectLinkProvider`'s. */
  t?: Translator;
  onOpen?: ObjectOpen;
  /**
   * `inline` (default): accent and underlined, for running text. `bare`: only the focus ring, for a
   * place that styles its own link (a path crumb); its class decides the colour, never the base.
   */
  appearance?: "inline" | "bare";
  /** False for a link that must show no card. */
  preview?: boolean;
  /** Where the card goes; right of the link by default, flipped where there is no room. */
  side?: "top" | "right" | "bottom" | "left";
  /** Tests and screens: hold the card open, in place and not in a portal. */
  previewOpen?: boolean;
  portal?: boolean;
  /** Tests: the batcher the card reads through. */
  batcher?: PreviewBatcher;
}

const focusRing =
  "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
/** A link in running text: accent, underlined. */
export const objectLinkClass = cn(
  focusRing,
  "text-accent underline decoration-1 underline-offset-[3px] [overflow-wrap:anywhere] hover:decoration-2"
);

export function ObjectLink({
  address,
  children,
  t: given,
  onOpen: givenOpen,
  appearance = "inline",
  preview = true,
  side = "right",
  previewOpen,
  portal = true,
  batcher,
  className,
  ...rest
}: ObjectLinkProps) {
  const context = useObjectLinkContext();
  const t = given ?? context?.t;
  const onOpen = givenOpen ?? context?.onOpen;
  const [opened, setOpened] = useState(false);
  const open = previewOpen ?? opened;
  const card = useObjectPreview(address, open && preview, batcher);

  const activate = (event: MouseEvent<HTMLAnchorElement>) => {
    // The window never navigates to a `memora://` address: the workspace opens it.
    event.preventDefault();
    onOpen?.(address, event.altKey ? { replace: true } : undefined);
  };

  const link = (
    <a
      href={address}
      data-object-link={address}
      data-quick-look={address}
      className={cn(appearance === "inline" ? objectLinkClass : focusRing, className)}
      onClick={activate}
      onAuxClick={(event) => event.preventDefault()}
      {...rest}
    >
      {children}
    </a>
  );
  if (!preview || !t) return link;
  return (
    <HoverCard
      open={open}
      onOpenChange={(next) => {
        if (previewOpen === undefined) setOpened(next);
      }}
    >
      <HoverCardTrigger asChild>{link}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        portal={portal}
        role="group"
        aria-label={t("preview.card.label")}
      >
        <ObjectCard t={t} address={address} preview={card} />
      </HoverCardContent>
    </HoverCard>
  );
}
