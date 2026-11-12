import { Fragment, type ReactNode } from "react";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { InlineAction } from "../../InlineAction";
import { ReadOnlyValue, RegistryRow } from "../../SettingRow";
import { SettingsGroup } from "../../SettingControls";
import { useSettings } from "../../settings-context";
import { groupLabelOf, groupsOf } from "../../settings-model";
import { requestSettingsTarget } from "../../settings-target";
import { BookLookupRow, GoogleBooksKeyRow } from "./BookRows";
import { GatewayRow } from "./GatewayRow";
import { AttachmentsRow } from "./ObsidianLayoutRow";
import { SyncRow, VaultRow } from "./ObsidianRows";
import { ObsidianReview } from "./ObsidianReview";
import { WikiDescendantsRow, WikiScopeRow } from "./ObsidianWikiRows";
import {
  useGateway,
  useLayoutStatus,
  useStorage,
  useSyncStatus,
  useWikiStatus
} from "./use-integrations-data";

/**
 * Settings › Integrations (design record §7.6, the Settings v2 mockup): Obsidian first (the vault,
 * then the sync, then which sources become pages and whether the original files come along), then
 * the lookup of book data on the internet, then the local connection with the apps paired to it.
 * Registry-driven: one row for each entry of the section, in the registry's groups. Each status is
 * read once and follows the bus; a read that fails says so in its row, with the way to try again.
 */
export function IntegrationsSection() {
  const { t, section } = useSettings();
  const storage = useStorage();
  const sync = useSyncStatus();
  const wiki = useWikiStatus();
  const layout = useLayoutStatus();
  const gateway = useGateway();

  const rowOf = (entry: SettingEntryV2): ReactNode => {
    switch (entry.id) {
      case "obsidianVaultPath":
        return (
          <VaultRow
            entry={entry}
            storage={storage.storage}
            apply={storage.apply}
            retry={storage.retry}
          />
        );
      case "obsidianSync":
        return (
          <SyncRow
            entry={entry}
            storage={storage.storage}
            apply={storage.apply}
            retry={storage.retry}
            sync={sync.sync}
            retrySync={sync.retry}
          />
        );
      case "obsidian.wiki.scope":
        return <WikiScopeRow entry={entry} handle={wiki} />;
      case "obsidian.wiki.includeDescendants":
        return <WikiDescendantsRow entry={entry} handle={wiki} />;
      case "obsidian.layout.attachments":
        return <AttachmentsRow entry={entry} layout={layout} />;
      case "bookLookup":
        return <BookLookupRow entry={entry} />;
      case "metadata:google-books":
        return <GoogleBooksKeyRow entry={entry} />;
      case "integrations.gateway":
        return <GatewayRow entry={entry} handle={gateway} />;
      default:
        // A setting added to this section that the section does not draw yet still shows its value.
        return <RegistryRow entry={entry} control={<ReadOnlyValue entry={entry} />} />;
    }
  };

  return (
    <>
      {groupsOf("integrations").map(({ group, entries }, index) => (
        <SettingsGroup
          key={group}
          section={section}
          group={group}
          title={groupLabelOf(t, section, group)}
          first={index === 0}
        >
          {entries.map((entry) => (
            <Fragment key={entry.id}>{rowOf(entry)}</Fragment>
          ))}
          {group === "obsidian" ? <ObsidianReview handle={wiki} /> : null}
        </SettingsGroup>
      ))}
      <p className="m-0 mt-8 text-sm text-secondary-foreground [text-wrap:pretty]">
        {t("settingsIntegrations.moreInAdvanced")}{" "}
        <InlineAction
          onClick={() => requestSettingsTarget({ section: "advanced", setting: "managedRoot" })}
        >
          {t("settingsIntegrations.openAdvanced")}
        </InlineAction>
      </p>
    </>
  );
}

export const section = { id: "integrations" as const, Section: IntegrationsSection };
