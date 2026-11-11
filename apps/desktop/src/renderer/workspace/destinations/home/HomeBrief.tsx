import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { itemTitle } from "../../../components/inbox/inbox-model";
import { Button } from "../../../components/ui/button";
import { Kbd } from "../../../components/ui/kbd";
import { Tooltip } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import { formatView } from "../../route";
import {
  briefingClauses,
  dateLine,
  greetingPart,
  homeMode,
  type BriefingClause,
  type HomeData,
  type ResumeEntry
} from "./home-model";
import { countText, pluralKey, slotted, slotValues, whenText } from "./home-text";

/** A count or a word in the briefing that opens its place: accent text, underlined, a real button. */
export function InlineLink({
  children,
  onClick,
  label
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  label?: string;
}) {
  if (!onClick) return <strong className="font-semibold">{children}</strong>;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "inline cursor-pointer rounded-sm border-0 bg-transparent p-0 font-semibold text-accent",
        "underline decoration-1 underline-offset-[3px]",
        "hover:text-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      )}
    >
      {children}
    </button>
  );
}

/** The word "Jardineiro", which explains itself on hover and on focus (design record §5.2). */
export function GardenerWord({ t }: { t: Translator }) {
  return (
    <Tooltip label={t("home.gardener.tip")}>
      <span
        tabIndex={0}
        className="cursor-help border-b border-dotted border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t("home.gardener.name")}
      </span>
    </Tooltip>
  );
}

export interface BriefActions {
  openLibrary?: () => void;
  openInbox?: () => void;
  resume?: () => void;
}

/** One clause of the briefing as text with its links. */
function clauseText(t: Translator, clause: BriefingClause, actions: BriefActions): ReactNode[] {
  const n = (value: number) => new Intl.NumberFormat(t.locale).format(value);
  switch (clause.id) {
    case "arrivals": {
      const key =
        clause.notes > 0
          ? pluralKey(
              t.locale,
              clause.sources,
              "home.briefing.arrivedOne",
              "home.briefing.arrivedOther"
            )
          : pluralKey(
              t.locale,
              clause.sources,
              "home.briefing.arrivedNoNotesOne",
              "home.briefing.arrivedNoNotesOther"
            );
      return slotted(t(key, { values: slotValues("sources", "notes") }), {
        sources: (
          <InlineLink onClick={actions.openLibrary}>
            {countText(t, "sources", clause.sources)}
          </InlineLink>
        ),
        notes: countText(t, "notes", clause.notes)
      });
    }
    case "notesOnly":
      return [
        t(
          pluralKey(
            t.locale,
            clause.notes,
            "home.briefing.notesOnlyOne",
            "home.briefing.notesOnlyOther"
          ),
          { values: { notes: countText(t, "newNotes", clause.notes) } }
        )
      ];
    case "placement": {
      if (clause.unplaced === 0) return [t("home.briefing.placedAll")];
      if (clause.placed === 0)
        return [
          t(
            pluralKey(
              t.locale,
              clause.unplaced,
              "home.briefing.noneYetOne",
              "home.briefing.noneYetOther"
            ),
            { values: { count: n(clause.unplaced) } }
          )
        ];
      const placed = t(
        pluralKey(t.locale, clause.placed, "home.briefing.placedOne", "home.briefing.placedOther"),
        { values: { count: n(clause.placed) } }
      );
      const unplaced = t(
        pluralKey(
          t.locale,
          clause.unplaced,
          "home.briefing.unplacedOne",
          "home.briefing.unplacedOther"
        ),
        { values: { count: n(clause.unplaced) } }
      );
      return [`${placed} ${unplaced}`];
    }
    case "generating":
      return [
        clause.count === 1
          ? t("home.briefing.generatingOne")
          : t("home.briefing.generatingOther", { values: { count: n(clause.count) } })
      ];
    case "gardener":
      return slotted(t("home.briefing.gardener", { values: slotValues("gardener", "changes") }), {
        gardener: <GardenerWord t={t} />,
        changes: <strong className="font-semibold">{countText(t, "changes", clause.count)}</strong>
      });
    case "decisions": {
      const title = clause.top ? itemTitle(t, clause.top) : null;
      const key =
        title === null
          ? pluralKey(
              t.locale,
              clause.count,
              "home.briefing.decisionsOne",
              "home.briefing.decisionsOther"
            )
          : pluralKey(
              t.locale,
              clause.count,
              "home.briefing.decisionsAmongOne",
              "home.briefing.decisionsAmongOther"
            );
      return slotted(
        t(key, {
          values: { ...slotValues("decisions"), ...(title === null ? {} : { title }) }
        }),
        {
          decisions: (
            <InlineLink onClick={actions.openInbox}>
              {countText(t, "decisions", clause.count)}
            </InlineLink>
          )
        }
      );
    }
  }
}

/** The briefing: the true clauses in one paragraph, linked counts in accent. */
export function Briefing({
  t,
  data,
  actions
}: {
  t: Translator;
  data: HomeData;
  actions: BriefActions;
}) {
  const clauses = briefingClauses(data);
  return (
    <p
      aria-label={t("home.briefing.label")}
      className="m-0 max-w-[40rem] font-reading text-lg text-foreground [text-wrap:pretty]"
    >
      {clauses.map((clause, index) => (
        <span key={clause.id}>
          {index > 0 ? " " : null}
          {clauseText(t, clause, actions)}
        </span>
      ))}
    </p>
  );
}

/** The date line and the greeting: "Bom dia. Enquanto você esteve fora:", or the calm day's. */
export function Greeting({ t, data }: { t: Translator; data: HomeData }) {
  const now = new Date(data.readAt);
  const date = dateLine(t.locale, now);
  const lastVisit = data.lastVisit === null ? null : whenText(t, data.lastVisit, data.readAt);
  const part = greetingPart(now.getHours());
  const hello = t(
    part === "morning"
      ? "home.greeting.morning"
      : part === "afternoon"
        ? "home.greeting.afternoon"
        : "home.greeting.evening"
  );
  const calm = homeMode(data) === "calm";
  const lead = calm
    ? t(data.lastVisit === null ? "home.greeting.calmWeek" : "home.greeting.calm")
    : t(data.lastVisit === null ? "home.greeting.week" : "home.greeting.away");
  return (
    <>
      <p className="m-0 text-sm text-muted-foreground">
        {lastVisit === null
          ? date
          : t("home.date.lastVisit", { values: { date, when: lastVisit } })}
      </p>
      <h2 className="m-0 font-reading text-2xl font-semibold text-foreground [text-wrap:balance]">
        {hello} {lead}
      </h2>
    </>
  );
}

export function Reassurance({ t }: { t: Translator }) {
  return (
    <p className="m-0 flex items-start gap-2 text-sm text-secondary-foreground [text-wrap:pretty]">
      <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
      {t("home.briefing.reassurance")}
    </p>
  );
}

/** "Continuar de onde parou": the trail as three plain rows on a thread and the one primary button. */
export function ResumeCard({
  t,
  trail,
  readAt,
  onResume
}: {
  t: Translator;
  trail: readonly ResumeEntry[];
  readAt: number;
  onResume?: (() => void) | undefined;
}) {
  const newest = trail[trail.length - 1];
  const kindWords = {
    source: "objects.kinds.source",
    note: "objects.kinds.note",
    topic: "objects.kinds.topic",
    question: "objects.kinds.question",
    entity: "objects.kinds.entity"
  } as const;
  return (
    <section
      aria-labelledby="home-resume-title"
      className="grid min-w-0 content-start gap-4 rounded-xl border border-border bg-surface p-5 [box-shadow:var(--shadow-sheet)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="home-resume-title" className="m-0 text-base font-semibold text-foreground">
          {t("home.resume.title")}
        </h3>
        {newest ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {whenText(t, newest.openedAt, readAt)}
          </span>
        ) : null}
      </div>
      <ol
        aria-label={t("home.resume.label")}
        className="relative m-0 grid list-none gap-3 p-0 before:absolute before:bottom-2 before:left-[3.5px] before:top-2 before:w-px before:bg-[var(--thread)]"
      >
        {trail.map((entry, index) => {
          const current = index === trail.length - 1;
          return (
            <li
              key={entry.address}
              className="relative grid grid-cols-[6.25rem_minmax(0,1fr)] items-baseline gap-x-2 pl-5"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 top-[0.55rem] size-2 rounded-full",
                  current ? "bg-accent" : "bg-muted-foreground"
                )}
              />
              <span className="inline-flex items-center gap-1 text-sm text-secondary-foreground">
                <ObjectKindGlyph
                  kind={entry.kind}
                  size={12}
                  className={objectKindTextClass[entry.kind]}
                />
                {t(kindWords[entry.kind])}
              </span>
              <span
                className={cn(
                  "min-w-0 font-reading text-sm [text-wrap:pretty]",
                  current ? "font-semibold text-foreground" : "text-secondary-foreground"
                )}
              >
                {entry.title}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="min-w-0 text-sm text-secondary-foreground">
          {t(
            pluralKey(t.locale, trail.length, "home.resume.panelsOne", "home.resume.panelsOther"),
            { values: { count: new Intl.NumberFormat(t.locale).format(trail.length) } }
          )}
        </span>
        <Button variant="primary" onClick={onResume}>
          {t("home.resume.action")}
          <Kbd tone="on-solid" aria-hidden="true">
            ↵
          </Kbd>
        </Button>
      </div>
    </section>
  );
}

/** The address Home's counts open. */
export const homeAddresses = {
  library: formatView({ view: "library" }),
  inbox: formatView({ view: "inbox" }),
  map: formatView({ view: "map", lens: "shape" })
} as const;
