import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BookMarked,
  BookOpen,
  CalendarDays,
  ChevronDown,
  File,
  FileText,
  Film,
  Globe,
  GraduationCap,
  Newspaper,
  ScrollText,
  StickyNote
} from "lucide-react";
import { AtomicNoteRelationTypeSchema, relationBandWord, type SourceItemType } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import type { SourceDetail } from "../../../../shared/ipc";
import { AiNoteBadge } from "../../../components/AiNoteBadge";
import { cn } from "../../../lib/cn";
import { relationTypeView } from "../../../lib/relation-stance";

// The pieces the Source page and the Library share. Moved out of LibraryView by F5 T139 without a
// change of behaviour.

export function expandedCardScrollBlock(
  card: { top: number; bottom: number; height: number },
  viewport: { top: number; bottom: number; height: number },
  margin = 8
): ScrollLogicalPosition | null {
  const availableHeight = Math.max(0, viewport.height - margin * 2);
  if (card.top >= viewport.top + margin && card.bottom <= viewport.bottom - margin) return null;
  return card.height <= availableHeight ? "nearest" : "start";
}

export function useExpandedCardViewport(expanded: boolean) {
  const cardRef = useRef<HTMLElement | null>(null);
  const wasExpanded = useRef(expanded);

  useEffect(() => {
    const hasJustExpanded = expanded && !wasExpanded.current;
    wasExpanded.current = expanded;
    if (!hasJustExpanded) return;
    const timer = window.setTimeout(() => {
      const card = cardRef.current;
      if (!card) return;
      const cardRect = card.getBoundingClientRect();
      const scrollViewport = closestVerticalScrollViewport(card);
      const viewportRect = scrollViewport?.getBoundingClientRect() ?? {
        top: 0,
        bottom: window.innerHeight,
        height: window.innerHeight
      };
      const block = expandedCardScrollBlock(cardRect, viewportRect);
      if (block) card.scrollIntoView({ behavior: "smooth", block, inline: "nearest" });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [expanded]);

  return cardRef;
}

export function closestVerticalScrollViewport(element: HTMLElement): HTMLElement | null {
  let candidate = element.parentElement;
  while (candidate) {
    const overflowY = window.getComputedStyle(candidate).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      candidate.scrollHeight > candidate.clientHeight
    )
      return candidate;
    candidate = candidate.parentElement;
  }
  return null;
}

export const typeIcons: Record<SourceItemType, typeof FileText> = {
  PersonalNote: StickyNote,
  DailyNote: CalendarDays,
  WebArticle: Globe,
  Book: BookOpen,
  BookChapter: BookMarked,
  PeriodicalIssue: Newspaper,
  AcademicPaper: GraduationCap,
  DocumentSection: FileText,
  StandaloneArticle: ScrollText,
  Video: Film,
  GenericDocument: File
};

const typeBadgeStyles: Record<SourceItemType, string> = {
  PersonalNote: "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200",
  DailyNote: "bg-indigo-100 text-indigo-900 dark:bg-indigo-950 dark:text-indigo-200",
  WebArticle: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  Book: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  BookChapter: "bg-teal-100 text-teal-900 dark:bg-teal-950 dark:text-teal-200",
  PeriodicalIssue: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  AcademicPaper: "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  DocumentSection: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  StandaloneArticle: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
  Video: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  GenericDocument: "bg-fuchsia-100 text-fuchsia-900 dark:bg-fuchsia-950 dark:text-fuchsia-200"
};

/**
 * What the relation list of a source says about how sure the matcher was (F3 D42): a relation the
 * owner kept says so; a relations v2 row says its band as a word ("Strong", "Possible", "Not
 * calibrated"), never a per-pair percentage; only a legacy row, whose score was a fused one, keeps
 * showing the stored percentage.
 */
export function relationConfidenceLabel(
  relation: {
    band: "apply" | "suggest" | null;
    calibration: "frozen" | "provisional" | "uncalibrated" | null;
    state: "applied" | "suggested" | "withdrawn" | "kept";
    finalScore: number;
  },
  t: Translator
): string {
  if (relation.state === "kept") return t("notePage.state.kept");
  if (relation.band === null) return `${Math.round(relation.finalScore * 100)}%`;
  const word = relationBandWord(relation);
  return word === null ? "" : t(`notePage.band.${word}`);
}

export function SourceTypeBadge({ type, t }: { type: SourceItemType; t: Translator }) {
  const Icon = typeIcons[type];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold",
        typeBadgeStyles[type]
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {t(`import.sourceTypes.${type}` as MessageKey)}
    </span>
  );
}

export function AtomicNoteCard({
  note,
  focused = false,
  t,
  onOpenNote
}: {
  note: SourceDetail["atomicNotes"][number];
  focused?: boolean;
  t: Translator;
  onOpenNote?: ((noteId: string) => void) | undefined;
}) {
  const lang = note.language === "und" ? undefined : note.language;
  return (
    <article
      id={`atomic-note-${note.id}`}
      tabIndex={-1}
      className={cn(
        "scroll-my-4 flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 outline-none",
        focused && "ring-2 ring-accent"
      )}
    >
      {onOpenNote ? (
        <button
          type="button"
          className="text-left font-semibold hover:underline"
          onClick={() => onOpenNote(note.id)}
        >
          {note.title}
        </button>
      ) : (
        <span className="font-semibold">{note.title}</span>
      )}
      <p lang={lang} className="font-reading text-base">
        {note.ideaStatement}
      </p>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t(noteStatusKey(note.status))}</span>
        <AiNoteBadge t={t} status={note.status} humanProtected={note.humanProtected} />
        {note.supersessionStatus !== "current" ? (
          <span>{t("knowledgeEvolution.supersededNote")}</span>
        ) : null}
        <span>
          {t(
            note.ownership === "knowledge"
              ? "knowledgeEvolution.knowledgeOwned"
              : "knowledgeEvolution.sourceOwned"
          )}
        </span>
      </p>
    </article>
  );
}

export function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  openSignal = 0,
  children
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  /** Opens the section each time it grows (a citation needs the passage it holds on screen). */
  openSignal?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen || openSignal > 0);
  const [seenSignal, setSeenSignal] = useState(openSignal);
  if (openSignal !== seenSignal) {
    setSeenSignal(openSignal);
    if (openSignal > 0) setOpen(true);
  }
  const sectionRef = useExpandedCardViewport(open);
  return (
    <section
      ref={sectionRef}
      className="scroll-my-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-950/40"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex items-center gap-2 font-semibold">
          {title}
          {count !== undefined ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold tabular-nums text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {count}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-slate-400 transition-transform",
            open && "rotate-180"
          )}
          aria-hidden="true"
        />
      </button>
      <div className={cn("section-collapse", open && "section-collapse-open")}>
        <div>
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function StatTile({
  icon: Icon,
  label,
  value,
  tone
}: {
  icon: typeof FileText;
  label: string;
  value: number;
  tone: "cyan" | "emerald" | "violet" | "amber";
}) {
  const tones = {
    cyan: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200",
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
    violet: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-lg", tones[tone])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-slate-500">{label}</span>
        <span className="mt-0.5 block text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">
          {value}
        </span>
      </span>
    </div>
  );
}

export function StateCard({ children }: { children: string }) {
  return (
    <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
      {children}
    </p>
  );
}

export function noteStatusKey(status: string): MessageKey {
  return `knowledge.notes.status.${status}` as MessageKey;
}

const legacyRelationTypes = new Set(AtomicNoteRelationTypeSchema.options as readonly string[]);

/** The legacy types keep their Library words; the relations v2 write types read as on the Note page. */
export function relationTypeKey(type: string): MessageKey {
  return legacyRelationTypes.has(type)
    ? (`knowledge.relations.types.${type}` as MessageKey)
    : relationTypeView(type).wordKey;
}

export function metadataEntries(metadata: Record<string, unknown>): Array<[string, string]> {
  const descriptor = metadata.descriptor;
  if (!descriptor || typeof descriptor !== "object") return [];
  const values = descriptor as Record<string, unknown>;
  return [
    "title",
    "subtitle",
    "creators",
    "language",
    "publicationDate",
    "publisher",
    "edition",
    "isbn10",
    "isbn13",
    "doi",
    "issn",
    "venue",
    "year",
    "series",
    "volume",
    "issue",
    "chapterNumber",
    "sectionNumber",
    "pageCount",
    "url",
    "siteName",
    "platform",
    "channel",
    "durationSeconds",
    "tags",
    "subjects",
    "keywords",
    "abstract",
    "description"
  ].flatMap((key): Array<[string, string]> => {
    const value = values[key];
    if (value === undefined || value === null || value === "") return [];
    const formatted = Array.isArray(value)
      ? value
          .map((item) =>
            typeof item === "object" && item && "name" in item ? String(item.name) : String(item)
          )
          .join(", ")
      : String(value);
    return formatted ? [[key, formatted]] : [];
  });
}
