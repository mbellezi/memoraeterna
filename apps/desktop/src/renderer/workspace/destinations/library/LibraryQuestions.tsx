import type { Translator } from "@app/i18n";

import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import type { Density } from "../../state";
import { LibraryGrid, RowSkeleton, type GridColumn } from "./LibraryGrid";
import { NotesCell, DateCell, QuestionStateCell, QuestionTitleCell } from "./library-cells";
import type { PagedData } from "./use-library-data";

/**
 * The Perguntas tab's table (design record §7.3: the same table grammar as Fontes): the question
 * with what it was asked about, the answers, its state and when it was asked, newest first.
 */

/** What the frame of the screens tool reports for the Perguntas tab (`memora://library?tab=questions`). */
export const libraryQuestionsSurface = "library-questions";

export function QuestionsTable({
  t,
  columns,
  questions,
  titles,
  density,
  selected,
  now,
  onSelect,
  onPeek,
  onOpen
}: {
  t: Translator;
  columns: readonly GridColumn[];
  questions: PagedData<QuestionListItemView, never>;
  titles: ReadonlyMap<string, string | null>;
  density: Density;
  selected: string | null;
  now: Date;
  onSelect: (key: string) => void;
  onPeek: (key: string) => void;
  onOpen: (question: QuestionListItemView) => void;
}) {
  return (
    <LibraryGrid<QuestionListItemView>
      t={t}
      density={density}
      selectedKey={selected}
      onSelect={onSelect}
      onPeek={onPeek}
      onOpen={onOpen}
      label={t("libraryTable.tabs.questions")}
      columns={columns}
      items={questions.state.items}
      itemKey={(question) => question.id}
      renderCell={(column, question, cell) => {
        switch (column.id) {
          case "text":
            return <QuestionTitleCell t={t} question={question} titles={titles} cell={cell} />;
          case "answers":
            return <NotesCell count={question.answerCount} />;
          case "status":
            return <QuestionStateCell t={t} question={question} />;
          default:
            return <DateCell t={t} iso={question.createdAt} now={now} />;
        }
      }}
      sort={{ id: "asked", dir: "desc" }}
      hasMore={questions.state.hasMore}
      loadingMore={questions.state.loadingMore}
      moreFailed={questions.state.moreFailed}
      onMore={questions.more}
      onRetryMore={questions.retry}
      stale={questions.state.stale}
      skeleton={<RowSkeleton />}
    />
  );
}
