import { useEffect } from "react";
import { parseObjectAddress, type ObjectLocateResult, type ObjectRef } from "@app/domain";
import { createTranslator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../components/glyphs";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { LoadingState, Skeleton, SkeletonLines } from "../components/ui/skeleton";
import { cn } from "../lib/cn";
import { useObject } from "../lib/object-events";
import type { PanelModule, PanelProps } from "./PanelStack";

/**
 * What the panel stack's and the panel frame's screens show inside their frames: one synthetic
 * library (design record §17's fermentation fixture) and a stand-in object page that reads it
 * through `objects.get` and reports its state the way the real panels (T140, T141, T146, T147)
 * do. Only the screen modules import this file.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const address = (kind: ObjectRef["kind"], n: number) => `memora://${kind}/${uuid(n)}`;

export const fixtureAddresses = {
  source: address("source", 11),
  topic: address("topic", 4),
  note: address("note", 21),
  question: address("question", 31),
  topNote: address("note", 22),
  extra: address("note", 23)
} as const;

const topic = (n: number, title: string): ObjectRef => ({ kind: "topic", id: uuid(n), title });
const path = [
  topic(1, ""),
  topic(2, "Life sciences"),
  topic(3, "Microbiology"),
  topic(5, "Fermentation"),
  topic(4, "Lactic fermentation")
];

interface Page {
  title: string;
  meta: string;
  body: string[];
  /** For the compact form: the rows of its list. */
  rows?: { address: string; title: string }[];
}

const pages: Record<string, Page> = {
  [fixtureAddresses.source]: {
    title: "Food microbiology, ch. 3",
    meta: "Book · 214 pages · 18 notes",
    body: ["Lactic acid bacteria turn sugar into lactic acid and so preserve food."]
  },
  [fixtureAddresses.topic]: {
    title: "Lactic fermentation",
    meta: "18 notes · 2 sources",
    body: [
      "Bacteria that turn sugar into lactic acid, and with that preserve food. The base of yoghurt, sauerkraut and kefir."
    ],
    rows: [
      {
        address: fixtureAddresses.topNote,
        title: "Lactic acid inhibits pathogens by lowering the pH"
      },
      { address: fixtureAddresses.note, title: "Lactic acid bacteria tolerate an acid medium" },
      { address: fixtureAddresses.extra, title: "Temperature controls the final acidity" }
    ]
  },
  [fixtureAddresses.note]: {
    title: "Lactic acid bacteria tolerate an acid medium",
    meta: "Written by the local AI on 3 Nov · 1 source",
    body: ["They keep growing where most spoilage bacteria stop."]
  },
  [fixtureAddresses.question]: {
    title: "Why do fermented foods keep longer outside the fridge?",
    meta: "Asked on 4 Nov · 6 citations",
    body: ["Because the fermentation itself builds the barrier that protects the food."]
  },
  [fixtureAddresses.topNote]: {
    title: "Lactic acid inhibits pathogens by lowering the pH",
    meta: "Written by the local AI on 3 Nov · reviewed by you on 5 Nov · 2 sources",
    body: [
      "When lactic acid bacteria consume the sugars of a food, the lactic acid they produce brings the pH " +
        "down to about 4. At that acidity most of the bacteria that spoil food or cause disease cannot multiply.",
      "That is why sauerkraut, yoghurt and pickled vegetables keep for weeks outside the fridge: the fermentation itself builds the barrier that protects the food.",
      "The barrier is not absolute. Acid-resistant spores survive, which is why badly sealed preserves can still spoil."
    ]
  },
  [fixtureAddresses.extra]: {
    title: "Temperature controls the final acidity",
    meta: "Written by the local AI on 3 Nov · 1 source",
    body: ["A cooler ferment ends less acid and more aromatic."]
  }
};

const kindOf = (value: string) => parseObjectAddress(value)?.kind ?? "note";

function summary(value: string, empty: boolean) {
  const page = pages[value];
  return {
    address: value,
    kind: kindOf(value),
    title: page?.title ?? "",
    status: "current" as const,
    preview: empty ? "" : (page?.body[0] ?? ""),
    updatedAt: "2026-11-05T10:00:00.000Z"
  };
}

function located(value: string, empty: boolean): ObjectLocateResult {
  const parsed = parseObjectAddress(value);
  const object: ObjectRef = {
    kind: parsed?.kind ?? "note",
    id: parsed?.id ?? uuid(0),
    title: pages[value]?.title ?? ""
  };
  const placed = empty ? [path[0] as ObjectRef] : path;
  return {
    object,
    primaryPath: parsed?.kind === "topic" && !empty ? placed : [...placed, object],
    alsoIn:
      !empty && value === fixtureAddresses.topNote
        ? [{ kind: "topic", id: uuid(6), title: "Fermented foods" }]
        : [],
    citedBy: [],
    counts: {
      alsoIn: !empty && value === fixtureAddresses.topNote ? 1 : 0,
      citedBy: 0,
      notes: 0,
      passages: 0,
      children: 0
    }
  };
}

/** The fake `window.app` answers for one set (success or empty). */
export function panelFixtures(empty: boolean) {
  return {
    "objects.get": ({ address: value }: { address: string }) => summary(value, empty),
    "objects.resolveMany": ({ addresses }: { addresses: string[] }) => ({
      items: Object.fromEntries(addresses.map((value) => [value, summary(value, empty)])),
      missing: []
    }),
    "objects.locate": ({ address: value }: { address: string }) => located(value, empty)
  };
}

/** A stand-in object page: it reads its object, reports its state and draws each state. */
export function StandInPage({
  address: value,
  mode,
  active,
  onState,
  onOpen,
  current
}: PanelProps) {
  const state = useObject(value, active);
  const reported =
    state.status === "loading"
      ? "loading"
      : state.status === "error"
        ? "error"
        : state.status === "missing" || state.object.preview === ""
          ? "empty"
          : "success";
  useEffect(() => onState(reported), [onState, reported]);
  const page = pages[value];
  const compact = mode === "compact";

  if (reported === "loading")
    return (
      <LoadingState t={stubT} delayMs={0}>
        <Skeleton className={cn("h-6", compact ? "w-4/5" : "w-3/5")} />
        <Skeleton className="w-2/5" />
        <SkeletonLines lines={compact ? 3 : 5} className="mt-4 max-w-(--measure)" />
      </LoadingState>
    );
  const kind = kindOf(value);
  if (reported === "error")
    return (
      <ErrorState
        t={stubT}
        className="max-w-(--measure)"
        message={`This ${kind} could not be opened.`}
        kept={`Nothing was changed. The ${kind} is still in your library.`}
        retryLabel="Try again"
        onRetry={() => undefined}
      />
    );
  const title = (
    <h1
      className={cn(
        "m-0 mb-2 font-reading font-semibold text-foreground [text-wrap:balance]",
        compact ? "text-lg leading-snug" : "text-xl"
      )}
    >
      {page?.title}
    </h1>
  );
  if (reported === "empty")
    return (
      <div className="grid gap-4">
        {title}
        <EmptyState
          className="max-w-(--measure)"
          headline={emptyCopy[kind]?.headline ?? emptyCopy.source.headline}
          {...(kind === "source"
            ? { action: <Button variant="secondary">Generate notes</Button> }
            : {})}
        >
          {emptyCopy[kind]?.body ?? emptyCopy.source.body}
        </EmptyState>
      </div>
    );
  return (
    <article className="min-w-0">
      {title}
      <p className="m-0 mb-4 text-sm text-secondary-foreground [text-wrap:pretty]">{page?.meta}</p>
      {compact && page?.rows ? (
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {page.rows.map((row) => (
            <li key={row.address}>
              <button
                type="button"
                aria-current={row.address === current ? "true" : undefined}
                onClick={() => onOpen(row.address)}
                className={cn(
                  "relative flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover",
                  row.address === current &&
                    "bg-surface-selected before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                )}
              >
                <ObjectKindGlyph
                  kind="note"
                  size={14}
                  className={cn("mt-[3px]", objectKindTextClass.note)}
                />
                <span className="min-w-0">{row.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div
          className={cn(
            "max-w-(--measure) font-reading text-foreground [text-wrap:pretty]",
            compact ? "text-sm leading-6 text-secondary-foreground" : "text-reading leading-[1.75]"
          )}
        >
          {(compact ? page?.body.slice(0, 1) : page?.body)?.map((paragraph) => (
            <p key={paragraph} className="m-0 mb-4">
              {paragraph}
            </p>
          ))}
        </div>
      )}
    </article>
  );
}

const stubT = createTranslator("en");

/** What each stand-in page says when its object has nothing in it yet. */
const emptyCopy: Partial<Record<ObjectRef["kind"], { headline: string; body: string }>> & {
  source: { headline: string; body: string };
} = {
  source: {
    headline: "Nothing is written here yet.",
    body: "The notes of this source appear here as they are written. You can already ask it a question."
  },
  topic: {
    headline: "Nothing is placed here yet.",
    body: "Notes and sources land here when the tree places them."
  },
  note: {
    headline: "This note has no text yet.",
    body: "Its text appears here when it is written."
  },
  question: {
    headline: "This question has no answer yet.",
    body: "The answer appears here as it is written, with its citations."
  }
};

/** The stand-in panel kinds, one per object kind, as `panels/*.panel.tsx` would export them. */
export const standInPanels: readonly PanelModule[] = (
  ["source", "note", "topic", "question", "entity"] as const
).map((kind) => ({
  kind,
  match: (value: string) => value.startsWith(`memora://${kind}/`),
  title: (found) => found?.title ?? "",
  Component: StandInPage
}));
