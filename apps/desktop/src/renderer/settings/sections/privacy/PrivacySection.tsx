import { Skeleton } from "../../../components/ui/skeleton";
import { BarsGroup, BarsRow, BarsTableRow } from "../../SectionBars";
import { RegistrySection, type EntryRow } from "../general/registry-section";
import { LeavesRow } from "./LeavesRow";
import { CallLogRow, ClearQuestionsRow, ClearRecentsRow, ResetRow } from "./PrivacyRows";

const rows: Readonly<Record<string, EntryRow>> = {
  "privacy.summary": LeavesRow,
  "privacy.clearViewHistory": ClearRecentsRow,
  "privacy.clearQuestions": ClearQuestionsRow,
  "privacy.callLog": CallLogRow,
  "privacy.reset": ({ entry }) => <ResetRow entry={entry} />
};

/**
 * Privacy and data (design record 7.6, docs/f5-decisions.md D17): first what leaves this Mac, read
 * only; then the things that erase (Recents, the questions) and the log, and, last, the reset. The
 * rows that erase ask first, in a dialog that says what stays. The diagnostics log has no retention
 * setting: this section says how much it holds and points to Advanced, where it is read and pruned.
 * `leaving` and `reset` hold one row that carries the group's own name, so their headings are left out.
 */
export function PrivacySection() {
  return <RegistrySection rows={rows} skipHeadings={["leaving", "reset"]} />;
}

/** What Privacy looks like while it loads: the table of what leaves, then the erasing rows. */
function PrivacyBars() {
  return (
    <>
      <div className="mt-4">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="mt-2 h-3 w-80" />
        <div className="mt-6 grid grid-cols-[30%_36%_1fr] gap-4 pb-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
        </div>
        {Array.from({ length: 7 }, (_, index) => (
          <BarsTableRow
            key={index}
            columns={index % 2 === 0 ? ["w-24", "w-32", "w-20"] : ["w-28", "w-24", "w-28"]}
          />
        ))}
      </div>
      <BarsGroup width="w-36" />
      <BarsRow label="w-36" help="w-72" control="w-24" />
      <BarsRow label="w-32" help="w-72" control="w-36" />
      <BarsRow label="w-44" help="w-64" />
      <BarsRow label="w-36" help="w-80" control="w-44" />
    </>
  );
}

export const section = { id: "privacy", Section: PrivacySection, Skeleton: PrivacyBars } as const;
