import { RegistrySection, type EntryRow } from "../general/registry-section";
import { BackupRow } from "./BackupRow";
import { PlansRow } from "./PlansRow";
import { StorageRow } from "./StorageRow";
import { UploadCopiesRow } from "./UploadCopiesRow";

const rows: Readonly<Record<string, EntryRow>> = {
  "library.storage": StorageRow,
  uploadCopies: UploadCopiesRow,
  "library.backup": BackupRow,
  processingPresets: PlansRow
};

/**
 * Library and storage (design record 7.6, docs/f5-decisions.md D17): where the data is kept, the copy
 * of uploaded files merged with its folder into one control, the backup, and the saved import plans.
 * Drawn from the registry, so each of its entries has its row and nothing else is shown.
 */
export function LibrarySection() {
  return <RegistrySection rows={rows} />;
}

export const section = { id: "library", Section: LibrarySection } as const;
