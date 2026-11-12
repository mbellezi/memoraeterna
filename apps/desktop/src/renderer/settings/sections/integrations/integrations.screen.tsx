import { useEffect, useState } from "react";

import type { SettingDescription } from "../../../../shared/ipc-settings-describe";
import { settingsRegistryV2, type Json } from "../../../../shared/settings-registry";
import { screenTranslator } from "../../../workspace/screen-locale";
import type { ScreenModule } from "../../../workspace/surfaces";
import { SettingsSurface } from "../../SettingsSurface";
import { section } from "./IntegrationsSection";

/** Settings fills the content area of the window: the rail's width stands empty beside it. */
export const fullWindow = true;

export const surface = "settings-integrations";

const t = screenTranslator();
const noop = () => undefined;

/**
 * What the Integrations section reads, over a library with an Obsidian vault in sync: the vault, the
 * sync on, two sources chosen for the vault's pages, the original files not copied, the book lookup
 * on its default, no Google Books key and two apps paired with the local gateway.
 */
const values: Record<string, { value: Json; default: Json | null }> = {
  obsidianVaultPath: { value: true, default: null },
  obsidianSync: { value: "on", default: "off" },
  "obsidian.wiki.scope": { value: 2, default: null },
  "obsidian.wiki.includeDescendants": { value: true, default: true },
  "obsidian.layout.attachments": { value: "omit", default: "omit" },
  bookLookup: { value: "auto", default: "auto" },
  "metadata:google-books": { value: null, default: null }
};
const changed = new Set(["obsidianVaultPath", "obsidianSync", "obsidian.wiki.scope"]);

function describeEntries(): SettingDescription[] {
  return settingsRegistryV2
    .filter((entry) => entry.store.kind !== "none")
    .map((entry) => {
      const known = values[entry.id];
      const value: Json = known?.value ?? (entry.control === "switch" ? false : null);
      return {
        id: entry.id,
        value,
        default: known ? known.default : value,
        changed: changed.has(entry.id)
      };
    });
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const today = (hour: number, minute: number) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
};

const client = (id: string, clientType: string, displayName: string, age: number) => ({
  id,
  clientType,
  displayName,
  scopes: [],
  capabilities: [],
  contractVersion: "1",
  status: "paired",
  lastSeenAt: daysAgo(0),
  createdAt: daysAgo(age),
  updatedAt: daysAgo(0)
});

const shared = {
  "settings.describe": { entries: describeEntries() },
  "settings.get": {
    obsidianVaultPath: "~/Documentos/Cofre de exemplo",
    managedRoot: "Memora",
    obsidianSyncEnabled: true,
    obsidianSyncPaused: false,
    uploadCopiesEnabled: false,
    uploadCopiesFolderPath: null,
    updatedAt: new Date().toISOString()
  },
  "settings.getApp": { contentLanguage: "pt-BR" },
  "obsidian.getSyncStatus": {
    state: "completed",
    stage: "completed",
    progress: 1,
    processed: 214,
    total: 214,
    synced: 0,
    conflicts: 0,
    projected: 214,
    startedAt: today(9, 11).toISOString(),
    finishedAt: today(9, 12).toISOString(),
    error: null
  },
  "obsidian.wikiStatus": {
    active: true,
    job: null,
    delivery: { state: "done", total: 214, delivered: 214, failed: 0 },
    scope: {
      sourceIds: ["6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e01", "6f1f8b2e-1c10-4d3a-9a39-3a9c2b1d7e02"],
      includeDescendants: true
    },
    conflicts: [],
    retired: { archived: 0, absent: 0, keptTotal: 0, kept: [] }
  },
  "obsidian.layoutStatus": {
    config: { version: 2, language: "pt-BR", attachments: "omit" },
    migrations: []
  },
  "obsidian.editorialConflicts": [],
  "integrations.getGatewayStatus": {
    state: "ready",
    host: "127.0.0.1",
    port: 47613,
    baseUrl: "http://127.0.0.1:47613"
  },
  "integrations.listClients": [
    client("0b6c9a40-7a41-4f10-8c0b-5a0b7f3a9c11", "chrome-extension", "Navegador de exemplo", 12),
    client("0b6c9a40-7a41-4f10-8c0b-5a0b7f3a9c12", "obsidian-plugin", "Cofre de exemplo", 3)
  ]
};

export const fixtures: ScreenModule["fixtures"] = {
  success: shared,
  // "Nothing found": the surface starts from a search that no setting answers.
  empty: { "settings.describe": { entries: [] } }
};

/**
 * The real surface on the Integrations section. In the "empty" mode (the fixture holds no saved
 * values at all) it starts from a search that nothing answers, which is Settings' own empty state.
 */
function Screen() {
  const [query, setQuery] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.app.settings
      .describe()
      .then((result) => live && setQuery(result.entries.length === 0 ? "impressora" : ""))
      .catch(() => live && setQuery(""));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="h-screen bg-background text-foreground">
      <SettingsSurface
        key={query ?? "waiting"}
        t={t}
        surface={surface}
        initialSection="integrations"
        sections={{ integrations: section }}
        initialQuery={query ?? ""}
        onOpenClassic={noop}
      />
    </div>
  );
}

export function render() {
  return <Screen />;
}
