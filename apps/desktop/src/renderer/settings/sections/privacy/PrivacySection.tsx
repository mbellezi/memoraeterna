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
 * `leaving` is the first group and its row carries its own name, so its heading is left out.
 */
export function PrivacySection() {
  return <RegistrySection rows={rows} skipHeadings={["leaving"]} />;
}

export const section = { id: "privacy", Section: PrivacySection } as const;
