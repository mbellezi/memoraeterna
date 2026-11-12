import { formatObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import type { LibraryRow } from "../../../../shared/ipc-library";
import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import type { Density } from "../../state";
import type { LibraryTab } from "../../route";
import { LibraryGrid } from "./LibraryGrid";
import type { LibraryFacets } from "./library-model";
import type { PagedData } from "./use-library-data";

/**
 * The compact form of the Library (design record §3, §7.3): once a Source or a Question is open
 * beside it, the table is the previous panel and shows only its titles, one per row, with the open
 * row marked (`aria-current`, the accent bar). It is the grid's `list` variant, with no header.
 */

/** What the frame of the screens tool reports for the list (`LibraryRoot` `mode="compact"`). */
export const libraryCompactSurface = "library-compact";

export const sourceAddress = (id: string) => formatObjectAddress({ kind: "source", id });
export const questionAddress = (id: string) => formatObjectAddress({ kind: "question", id });

export interface LibraryListProps {
  t: Translator;
  tab: LibraryTab;
  sources: PagedData<LibraryRow, LibraryFacets>;
  questions: PagedData<QuestionListItemView, never>;
  density: Density;
  selected: string | null;
  /** The key of the open row. */
  currentKey: string | null;
  onSelect: (key: string) => void;
  onPeek: (key: string) => void;
  onOpen: (address: string) => void;
}

export function LibraryList({
  t,
  tab,
  sources,
  questions,
  density,
  selected,
  currentKey,
  onSelect,
  onPeek,
  onOpen
}: LibraryListProps) {
  const common = { t, density, selectedKey: selected, onSelect, onPeek, currentKey };
  if (tab === "sources")
    return (
      <LibraryGrid<LibraryRow>
        {...common}
        onOpen={(row) => onOpen(sourceAddress(row.id))}
        label={t("libraryTable.compact.label")}
        variant="list"
        columns={[{ id: "title", label: t("libraryTable.columns.source"), track: "minmax(0,1fr)" }]}
        items={sources.state.items}
        itemKey={(row) => row.id}
        renderCell={(_column, row) => (
          <span className="flex min-w-0 items-center gap-2 text-sm leading-5 text-foreground">
            <ObjectKindGlyph kind="source" size={14} className={objectKindTextClass.source} />
            <span className="min-w-0 truncate" title={row.title}>
              {row.title.trim() === "" ? t("panelFrame.untitled") : row.title}
            </span>
          </span>
        )}
        hasMore={sources.state.hasMore}
        loadingMore={sources.state.loadingMore}
        moreFailed={sources.state.moreFailed}
        onMore={sources.more}
        onRetryMore={sources.retry}
        stale={sources.state.stale}
      />
    );
  return (
    <LibraryGrid<QuestionListItemView>
      {...common}
      onOpen={(question) => onOpen(questionAddress(question.id))}
      label={t("libraryTable.compact.questionsLabel")}
      variant="list"
      columns={[{ id: "text", label: t("libraryTable.columns.question"), track: "minmax(0,1fr)" }]}
      items={questions.state.items}
      itemKey={(question) => question.id}
      renderCell={(_column, question) => (
        <span className="flex min-w-0 items-center gap-2 text-sm leading-5 text-foreground">
          <ObjectKindGlyph kind="question" size={14} className={objectKindTextClass.question} />
          <span className="min-w-0 truncate" title={question.text}>
            {question.text}
          </span>
        </span>
      )}
      hasMore={questions.state.hasMore}
      loadingMore={questions.state.loadingMore}
      moreFailed={questions.state.moreFailed}
      onMore={questions.more}
      onRetryMore={questions.retry}
      stale={questions.state.stale}
    />
  );
}
