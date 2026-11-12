import { Skeleton } from "../../../components/ui/skeleton";
import { BarsGroup, BarsItem, BarsRow } from "../../SectionBars";
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
 * Drawn from the registry, so each of its entries has its row and nothing else is shown. The first
 * group's row carries the group's own name, so its heading is left out.
 */
export function LibrarySection() {
  return <RegistrySection rows={rows} skipHeadings={["data"]} />;
}

/** What Library looks like while it loads: the storage lines, the copy's switch, the backup button, the plans. */
function LibraryBars() {
  return (
    <>
      <div className="mt-4">
        <Skeleton className="h-3.5 w-48" />
        <Skeleton className="mt-2 h-3 w-72" />
        <div className="mt-4">
          <BarsItem width="w-44" />
          <BarsItem width="w-64" />
        </div>
      </div>
      <BarsGroup width="w-32" />
      <BarsRow label="w-56" help="w-80" control="w-32" />
      <BarsGroup width="w-36" />
      <BarsRow label="w-20" help="w-72" control="w-36" />
      <BarsGroup width="w-36" />
      <BarsRow label="w-44" help="w-64" />
    </>
  );
}

export const section = { id: "library", Section: LibrarySection, Skeleton: LibraryBars } as const;
