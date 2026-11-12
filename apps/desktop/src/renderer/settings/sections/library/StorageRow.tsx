import type { ReactNode } from "react";
import { Database, FolderClosed } from "lucide-react";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { objectKindChanged, useSectionRead } from "../general/use-section-read";

/**
 * Where the data is kept: the local database (with how many sources it holds) and the stored files,
 * then the plain fact that their place is fixed and what to do for a copy of your own. Main gives the
 * renderer no path to the data folder, so the place is said in words, not drawn. The count is one
 * cheap read of the Library, read again only when a source is added or removed; while it is read,
 * or when it fails, the line simply has no count: nothing here is worth an error.
 */
export function StorageRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const { state } = useSectionRead(
    () => window.app.library.rows({ limit: 1 }),
    [{ type: "object.changed", when: objectKindChanged("source") }]
  );
  const total = state.status === "ready" ? state.value.total : null;
  const item = (icon: ReactNode, name: string, note: string | null) => (
    <li className="flex items-start gap-3 border-b border-border py-3 first:pt-1">
      <span aria-hidden="true" className="mt-0.5 text-muted-foreground [&>svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 text-sm text-foreground">
        <b className="font-medium">{name}</b>
        {note ? <span className="text-secondary-foreground"> · {note}</span> : null}
      </span>
    </li>
  );
  return (
    <RegistryRow
      entry={entry}
      stack
      control={
        <div className="w-full">
          <ul className="m-0 grid list-none p-0">
            {item(
              <Database />,
              t("settingsLibrary.storage.database"),
              total === null
                ? null
                : t(
                    total === 1
                      ? "settingsLibrary.storage.sourcesOne"
                      : "settingsLibrary.storage.sourcesMany",
                    { values: { count: total } }
                  )
            )}
            {item(
              <FolderClosed />,
              t("settingsLibrary.storage.files"),
              t("settingsLibrary.storage.filesNote")
            )}
          </ul>
          <p className="m-0 mt-3 max-w-[34rem] text-xs text-secondary-foreground [text-wrap:pretty]">
            {t("settingsLibrary.storage.where")}
          </p>
        </div>
      }
    />
  );
}
