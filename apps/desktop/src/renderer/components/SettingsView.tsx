import { useState } from "react";
import {
  Archive,
  Bot,
  ChevronRight,
  CircleGauge,
  Cpu,
  DatabaseBackup,
  FileX,
  HardDrive,
  FolderOpen,
  Languages,
  Moon,
  Network,
  Paintbrush,
  PlugZap,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2
} from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type {
  AppSettings,
  AppSettingsUpdate,
  StorageSettings,
  ThemeMode
} from "../../shared/ipc";
import { appLanguageCodes } from "../../shared/ipc";
import { cn } from "../lib/cn";
import { AiSettingsView } from "./AiSettingsView";
import { BackupView } from "./BackupView";
import { IntegrationGatewaySettings } from "./IntegrationGatewaySettings";
import { LocalModelsView } from "./LocalModelsView";
import { ObsidianSyncStatusCard } from "./ObsidianSyncStatusCard";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

interface SettingsViewProps {
  appSettings: AppSettings;
  settings: StorageSettings;
  isSaving: boolean;
  t: (key: MessageKey) => string;
  onAppSettingsChange: (settings: AppSettingsUpdate) => void;
  onChange: (settings: StorageSettings) => void;
  onSelectObsidianVault: () => Promise<void>;
}

type SettingsScope = "overview" | "personalization" | "intelligence" | "models" | "connections" | "data";

const deletionPolicies: Array<{
  policy: StorageSettings["deletionPolicy"];
  icon: typeof FileX;
  label: MessageKey;
  description: MessageKey;
}> = [
  {
    policy: "tombstone",
    icon: FileX,
    label: "settings.storage.deletePolicies.tombstone",
    description: "settings.dashboard.deletePolicyDescriptions.tombstone"
  },
  {
    policy: "archive",
    icon: Archive,
    label: "settings.storage.deletePolicies.archive",
    description: "settings.dashboard.deletePolicyDescriptions.archive"
  },
  {
    policy: "delete",
    icon: Trash2,
    label: "settings.storage.deletePolicies.delete",
    description: "settings.dashboard.deletePolicyDescriptions.delete"
  }
];

const themeModes: Array<{
  mode: ThemeMode;
  icon: typeof Moon;
  label: MessageKey;
}> = [
  { mode: "dark", icon: Moon, label: "settings.appearance.themeModes.dark" },
  { mode: "light", icon: Sun, label: "settings.appearance.themeModes.light" }
];

const scopes: Array<{
  id: SettingsScope;
  icon: typeof CircleGauge;
  label: MessageKey;
  description: MessageKey;
  accent: string;
  iconStyle: string;
}> = [
  {
    id: "overview",
    icon: CircleGauge,
    label: "settings.dashboard.navigation.overview",
    description: "settings.dashboard.navigation.overviewDescription",
    accent: "from-cyan-500/20 via-sky-500/10 to-transparent",
    iconStyle: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200"
  },
  {
    id: "personalization",
    icon: Paintbrush,
    label: "settings.dashboard.navigation.personalization",
    description: "settings.dashboard.navigation.personalizationDescription",
    accent: "from-violet-500/20 via-fuchsia-500/10 to-transparent",
    iconStyle: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200"
  },
  {
    id: "intelligence",
    icon: Bot,
    label: "settings.dashboard.navigation.intelligence",
    description: "settings.dashboard.navigation.intelligenceDescription",
    accent: "from-fuchsia-500/20 via-violet-500/10 to-transparent",
    iconStyle: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200"
  },
  {
    id: "models",
    icon: Cpu,
    label: "settings.dashboard.navigation.models",
    description: "settings.dashboard.navigation.modelsDescription",
    accent: "from-emerald-500/20 via-teal-500/10 to-transparent",
    iconStyle: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
  },
  {
    id: "connections",
    icon: PlugZap,
    label: "settings.dashboard.navigation.connections",
    description: "settings.dashboard.navigation.connectionsDescription",
    accent: "from-amber-500/20 via-orange-500/10 to-transparent",
    iconStyle: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
  },
  {
    id: "data",
    icon: DatabaseBackup,
    label: "settings.dashboard.navigation.data",
    description: "settings.dashboard.navigation.dataDescription",
    accent: "from-rose-500/20 via-orange-500/10 to-transparent",
    iconStyle: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200"
  }
];

export function SettingsView({
  appSettings,
  settings,
  isSaving,
  t,
  onAppSettingsChange,
  onChange,
  onSelectObsidianVault
}: SettingsViewProps) {
  const [activeScope, setActiveScope] = useState<SettingsScope>("overview");
  const [isResetting, setIsResetting] = useState(false);
  const [resetStatus, setResetStatus] = useState<MessageKey | null>(null);
  const activeScopeDefinition = scopes.find((scope) => scope.id === activeScope) ?? scopes[0]!;

  function update<K extends keyof StorageSettings>(key: K, value: StorageSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  async function resetLibrary() {
    if (!window.confirm(t("settings.reset.confirmation"))) return;
    setIsResetting(true);
    setResetStatus(null);
    try {
      const result = await window.app.settings.resetLibrary();
      setResetStatus(result.failedFiles > 0 ? "settings.reset.completedWithWarnings" : "settings.reset.completed");
    } catch {
      setResetStatus("settings.reset.failed");
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-[1480px] gap-5">
      <header className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 p-6 text-white shadow-sm dark:border-slate-800">
        <div className="pointer-events-none absolute -right-14 -top-28 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
        <div className="pointer-events-none absolute bottom-[-8rem] left-1/3 h-64 w-64 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              {t("settings.dashboard.eyebrow")}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">{t("settings.dashboard.title")}</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">{t("settings.dashboard.description")}</p>
            <p className="mt-3 flex items-center gap-2 text-xs font-medium text-emerald-300">
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              {t("settings.dashboard.autoSaveHint")}
            </p>
          </div>
          <div className="grid min-w-[16rem] gap-2 rounded-xl border border-white/10 bg-white/5 p-3 backdrop-blur">
            <div className="flex items-center justify-between gap-4 text-xs text-slate-300">
              <span>{t("settings.dashboard.summary.interface")}</span>
              <strong className="text-white">{t(`settings.language.languages.${appSettings.language}` as MessageKey)}</strong>
            </div>
            <div className="flex items-center justify-between gap-4 text-xs text-slate-300">
              <span>{t("settings.dashboard.summary.knowledgeMatching")}</span>
              <strong className="text-amber-300">{appSettings.atomicNoteRelationThreshold.toFixed(2)}</strong>
            </div>
            <div className="flex items-center justify-between gap-4 text-xs text-slate-300">
              <span>{t("settings.dashboard.summary.obsidian")}</span>
              <strong className={settings.obsidianSyncEnabled && settings.obsidianVaultPath ? "text-emerald-300" : "text-slate-400"}>
                {t(settings.obsidianSyncEnabled && settings.obsidianVaultPath
                  ? "settings.dashboard.states.active"
                  : "settings.dashboard.states.needsSetup")}
              </strong>
            </div>
          </div>
        </div>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 shadow-sm dark:border-slate-800 dark:bg-slate-950 lg:sticky lg:top-0">
          <p className="px-3 pb-2 pt-3 text-[0.68rem] font-bold uppercase tracking-[0.18em] text-slate-400">
            {t("settings.dashboard.navigation.label")}
          </p>
          <nav className="grid gap-1" role="tablist" aria-label={t("settings.dashboard.navigation.label")}>
            {scopes.map((scope) => {
              const Icon = scope.icon;
              const isActive = activeScope === scope.id;
              return (
                <button
                  key={scope.id}
                  id={`settings-tab-${scope.id}`}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-controls={`settings-panel-${scope.id}`}
                  className={cn(
                    "group flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-left transition",
                    isActive
                      ? "bg-slate-900 text-white shadow-sm dark:bg-white dark:text-slate-950"
                      : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900"
                  )}
                  onClick={() => setActiveScope(scope.id)}
                >
                  <span className={cn(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-lg transition",
                    isActive ? "bg-white/10 dark:bg-slate-950/10" : scope.iconStyle
                  )}>
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{t(scope.label)}</span>
                    <span className={cn(
                      "mt-0.5 block truncate text-[0.69rem]",
                      isActive ? "text-slate-300 dark:text-slate-600" : "text-slate-500"
                    )}>{t(scope.description)}</span>
                  </span>
                  <ChevronRight className={cn("h-4 w-4 shrink-0 transition", isActive ? "opacity-100" : "opacity-0 group-hover:opacity-50")} aria-hidden="true" />
                </button>
              );
            })}
          </nav>
        </aside>

        <div
          key={activeScope}
          id={`settings-panel-${activeScope}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeScope}`}
          className="motion-fade-in-up min-w-0"
        >
          {activeScope === "overview" ? (
            <OverviewPanel
              appSettings={appSettings}
              settings={settings}
              t={t}
              onNavigate={setActiveScope}
            />
          ) : null}

          {activeScope === "personalization" ? (
            <div className="grid gap-5">
              <ScopeHeader scope={activeScopeDefinition} t={t} />
              <div className="grid gap-5 xl:grid-cols-2">
                <AppearanceCard appSettings={appSettings} t={t} onChange={onAppSettingsChange} />
                <MatchingCard
                  appSettings={appSettings}
                  t={t}
                  onChange={onAppSettingsChange}
                />
              </div>
            </div>
          ) : null}

          {activeScope === "intelligence" ? (
            <div className="grid gap-5">
              <ScopeHeader scope={activeScopeDefinition} t={t} />
              <AiSettingsView t={t} interfaceLanguage={appSettings.language} />
            </div>
          ) : null}

          {activeScope === "models" ? (
            <div className="grid gap-5">
              <ScopeHeader scope={activeScopeDefinition} t={t} />
              <LocalModelsView t={t} />
            </div>
          ) : null}

          {activeScope === "connections" ? (
            <div className="grid gap-5">
              <ScopeHeader scope={activeScopeDefinition} t={t} />
              <IntegrationGatewaySettings t={t} />
              <ObsidianCard
                settings={settings}
                isSaving={isSaving}
                t={t}
                onUpdate={update}
                onSelectVault={onSelectObsidianVault}
              />
            </div>
          ) : null}

          {activeScope === "data" ? (
            <div className="grid gap-5">
              <ScopeHeader scope={activeScopeDefinition} t={t} />
              <StorageCard settings={settings} t={t} onUpdate={update} />
              <ObsidianSyncStatusCard
                available={Boolean(settings.obsidianVaultPath) && settings.obsidianSyncEnabled && !settings.obsidianSyncPaused}
                showAction
                t={t}
              />
              <BackupView t={t} />
              <ResetCard
                isResetting={isResetting}
                resetStatus={resetStatus}
                t={t}
                onReset={resetLibrary}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function OverviewPanel({ appSettings, settings, t, onNavigate }: {
  appSettings: AppSettings;
  settings: StorageSettings;
  t: SettingsViewProps["t"];
  onNavigate: (scope: SettingsScope) => void;
}) {
  const overviewScopes = scopes.filter((scope) => scope.id !== "overview");
  return (
    <div className="grid gap-5">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-semibold text-slate-950 dark:text-white">{t("settings.dashboard.overview.title")}</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-400">{t("settings.dashboard.overview.description")}</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <StatusTile
            icon={Paintbrush}
            label={t("settings.dashboard.summary.interface")}
            value={`${t(`settings.appearance.themeModes.${appSettings.themeMode}` as MessageKey)} · ${t(`settings.language.languages.${appSettings.language}` as MessageKey)}`}
            tone="violet"
          />
          <StatusTile
            icon={Network}
            label={t("settings.dashboard.summary.obsidian")}
            value={t(settings.obsidianSyncEnabled && settings.obsidianVaultPath
              ? "settings.dashboard.states.active"
              : "settings.dashboard.states.needsSetup")}
            tone="amber"
          />
          <StatusTile
            icon={HardDrive}
            label={t("settings.dashboard.summary.uploadCopies")}
            value={t(settings.uploadCopiesEnabled
              ? "settings.dashboard.states.enabled"
              : "settings.dashboard.states.internalOnly")}
            tone="emerald"
          />
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {overviewScopes.map((scope) => {
          const Icon = scope.icon;
          return (
            <button
              key={scope.id}
              type="button"
              className="group relative min-h-44 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-md dark:border-slate-800 dark:bg-slate-950 dark:hover:border-slate-700"
              onClick={() => onNavigate(scope.id)}
            >
              <span className={cn("pointer-events-none absolute inset-0 bg-gradient-to-br opacity-70", scope.accent)} />
              <span className="relative flex h-full flex-col">
                <span className={cn("grid h-10 w-10 place-items-center rounded-xl", scope.iconStyle)}>
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="mt-5 text-base font-semibold text-slate-950 dark:text-white">{t(scope.label)}</span>
                <span className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-400">{t(scope.description)}</span>
                <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-bold uppercase tracking-[0.12em] text-slate-700 dark:text-slate-300">
                  {t("settings.dashboard.openScope")}
                  <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
                </span>
              </span>
            </button>
          );
        })}
      </section>
    </div>
  );
}

function ScopeHeader({ scope, t }: { scope: (typeof scopes)[number]; t: SettingsViewProps["t"] }) {
  const Icon = scope.icon;
  return (
    <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <span className={cn("pointer-events-none absolute inset-0 bg-gradient-to-r opacity-70", scope.accent)} />
      <div className="relative flex items-start gap-3">
        <span className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", scope.iconStyle)}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-950 dark:text-white">{t(scope.label)}</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-400">{t(scope.description)}</p>
        </div>
      </div>
    </section>
  );
}

function AppearanceCard({ appSettings, t, onChange }: {
  appSettings: AppSettings;
  t: SettingsViewProps["t"];
  onChange: SettingsViewProps["onAppSettingsChange"];
}) {
  return (
    <section className="grid content-start gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200">
          <Paintbrush className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="font-semibold text-slate-950 dark:text-white">{t("settings.appearance.title")}</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t("settings.dashboard.appearanceDescription")}</p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="uiLocale">
          <span className="inline-flex items-center gap-2">
            <Languages className="h-4 w-4" aria-hidden="true" />
            {t("settings.language.uiLocale")}
          </span>
        </Label>
        <select
          id="uiLocale"
          className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-violet-500 focus:ring-4 focus:ring-violet-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:focus:border-violet-400 dark:focus:ring-violet-950"
          value={appSettings.language}
          onChange={(event) => onChange({ language: event.target.value as AppSettings["language"] })}
        >
          {appLanguageCodes.map((languageCode) => (
            <option key={languageCode} value={languageCode}>
              {t(`settings.language.languages.${languageCode}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <Label>{t("settings.appearance.themeMode")}</Label>
        <div className="grid grid-cols-2 gap-2">
          {themeModes.map(({ mode, icon: Icon, label }) => (
            <button
              key={mode}
              type="button"
              aria-label={t(label)}
              aria-pressed={appSettings.themeMode === mode}
              className={cn(
                "flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border text-sm font-semibold transition",
                appSettings.themeMode === mode
                  ? "border-violet-500 bg-violet-50 text-violet-950 ring-4 ring-violet-100 dark:bg-violet-950 dark:text-violet-100 dark:ring-violet-950/60"
                  : "border-slate-200 bg-slate-50 text-slate-700 hover:border-violet-300 hover:bg-violet-50/60 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-violet-800 dark:hover:bg-violet-950/30"
              )}
              onClick={() => onChange({ themeMode: mode })}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
              {t(label)}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function MatchingCard({ appSettings, t, onChange }: {
  appSettings: AppSettings;
  t: SettingsViewProps["t"];
  onChange: SettingsViewProps["onAppSettingsChange"];
}) {
  return (
    <section className="grid content-start gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <Network className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-semibold text-slate-950 dark:text-white">{t("settings.matching.title")}</h3>
            <p className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-400">{t("settings.matching.description")}</p>
          </div>
        </div>
        <span className="rounded-xl bg-amber-100 px-3 py-2 text-xl font-bold tabular-nums text-amber-950 dark:bg-amber-950 dark:text-amber-100">
          {appSettings.atomicNoteRelationThreshold.toFixed(2)}
        </span>
      </div>
      <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-900">
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={appSettings.atomicNoteRelationThreshold}
          aria-label={t("settings.matching.minimumScore")}
          className="w-full accent-amber-600"
          onChange={(event) => onChange({ atomicNoteRelationThreshold: Number(event.target.value) })}
        />
        <div className="mt-2 flex justify-between text-xs font-medium text-slate-500">
          <span>{t("settings.matching.moreRelations")}</span>
          <span>{t("settings.matching.fewerRelations")}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />
        {t("settings.matching.savedAutomatically")}
      </div>
      <div className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 p-4 dark:border-slate-800">
        <div className="grid gap-1">
          <Label htmlFor="metadataEnrichmentEnabled">{t("settings.metadataEnrichment.title")}</Label>
          <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
            {t("settings.metadataEnrichment.description")}
          </p>
        </div>
        <Switch
          id="metadataEnrichmentEnabled"
          checked={appSettings.metadataEnrichmentEnabled}
          aria-label={t("settings.metadataEnrichment.title")}
          onChange={(event) => onChange({ metadataEnrichmentEnabled: event.target.checked })}
        />
      </div>
    </section>
  );
}

function ObsidianCard({ settings, isSaving, t, onUpdate, onSelectVault }: {
  settings: StorageSettings;
  isSaving: boolean;
  t: SettingsViewProps["t"];
  onUpdate: <K extends keyof StorageSettings>(key: K, value: StorageSettings[K]) => void;
  onSelectVault: () => Promise<void>;
}) {
  return (
    <section className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200">
            <ServerCog className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-semibold text-slate-950 dark:text-white">{t("integrations.obsidianPlugin")}</h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t("settings.dashboard.obsidianDescription")}</p>
          </div>
        </div>
        <span className={cn(
          "rounded-full px-3 py-1 text-xs font-bold",
          settings.obsidianSyncEnabled && settings.obsidianVaultPath
            ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
            : "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300"
        )}>
          {t(settings.obsidianSyncEnabled && settings.obsidianVaultPath
            ? "settings.dashboard.states.active"
            : "settings.dashboard.states.needsSetup")}
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="obsidianVaultPath">{t("settings.storage.obsidianVaultPath")}</Label>
          <div className="flex gap-2">
            <Input
              id="obsidianVaultPath"
              value={settings.obsidianVaultPath ?? ""}
              onChange={(event) => onUpdate("obsidianVaultPath", event.target.value || null)}
            />
            <Button type="button" disabled={isSaving} onClick={() => void onSelectVault()}>
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
              {t("settings.storage.selectObsidianVault")}
            </Button>
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="managedRoot">{t("settings.storage.obsidianRootFolder")}</Label>
          <Input
            id="managedRoot"
            value={settings.managedRoot}
            onChange={(event) => onUpdate("managedRoot", event.target.value)}
          />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <ToggleCard
          checked={settings.obsidianSyncEnabled}
          label={t("settings.storage.obsidianSyncEnabled")}
          description={t("settings.dashboard.syncDescriptions.enabled")}
          onChange={(checked) => onUpdate("obsidianSyncEnabled", checked)}
        />
        <ToggleCard
          checked={settings.obsidianSyncPaused}
          label={t("settings.storage.obsidianSyncPaused")}
          description={t("settings.dashboard.syncDescriptions.paused")}
          onChange={(checked) => onUpdate("obsidianSyncPaused", checked)}
        />
      </div>
      <div className="grid gap-3">
        <Label>{t("settings.storage.obsidianDeletePolicy")}</Label>
        <div className="grid gap-2 md:grid-cols-3">
          {deletionPolicies.map(({ policy, icon: Icon, label, description }) => (
            <button
              key={policy}
              type="button"
              aria-pressed={settings.deletionPolicy === policy}
              className={cn(
                "flex min-h-24 items-start gap-3 rounded-xl border p-3 text-left transition",
                settings.deletionPolicy === policy
                  ? "border-cyan-500 bg-cyan-50 ring-4 ring-cyan-100 dark:bg-cyan-950/50 dark:ring-cyan-950"
                  : "border-slate-200 bg-slate-50 hover:border-cyan-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-cyan-800"
              )}
              onClick={() => onUpdate("deletionPolicy", policy)}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-cyan-700 dark:text-cyan-300" aria-hidden="true" />
              <span>
                <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{t(label)}</span>
                <span className="mt-1 block text-xs leading-4 text-slate-500">{t(description)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function StorageCard({ settings, t, onUpdate }: {
  settings: StorageSettings;
  t: SettingsViewProps["t"];
  onUpdate: <K extends keyof StorageSettings>(key: K, value: StorageSettings[K]) => void;
}) {
  return (
    <section className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
          <HardDrive className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="font-semibold text-slate-950 dark:text-white">{t("settings.storage.title")}</h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t("settings.dashboard.storageDescription")}</p>
        </div>
      </div>
      <ToggleCard
        checked={settings.uploadCopiesEnabled}
        label={t("settings.storage.copyUploadedFilesEnabled")}
        description={t("settings.dashboard.uploadCopiesDescription")}
        onChange={(checked) => onUpdate("uploadCopiesEnabled", checked)}
      />
      <div className="grid gap-2">
        <Label htmlFor="uploadCopiesFolderPath">{t("settings.storage.uploadedFilesPath")}</Label>
        <Input
          id="uploadCopiesFolderPath"
          value={settings.uploadCopiesFolderPath ?? ""}
          disabled={!settings.uploadCopiesEnabled}
          onChange={(event) => onUpdate("uploadCopiesFolderPath", event.target.value || null)}
        />
      </div>
    </section>
  );
}

function ResetCard({ isResetting, resetStatus, t, onReset }: {
  isResetting: boolean;
  resetStatus: MessageKey | null;
  t: SettingsViewProps["t"];
  onReset: () => Promise<void>;
}) {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-rose-300 bg-rose-50 p-5 dark:border-rose-900 dark:bg-rose-950/25">
      <div className="pointer-events-none absolute -right-10 -top-16 h-40 w-40 rounded-full bg-rose-300/30 blur-3xl dark:bg-rose-700/20" />
      <div className="relative flex flex-wrap items-center justify-between gap-5">
        <div className="flex max-w-2xl items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200">
            <RotateCcw className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-rose-700 dark:text-rose-300">{t("settings.dashboard.dangerZone")}</p>
            <h3 className="mt-1 font-semibold text-rose-950 dark:text-rose-100">{t("settings.reset.title")}</h3>
            <p className="mt-1 text-sm leading-5 text-rose-900 dark:text-rose-200">{t("settings.reset.description")}</p>
            <p className="mt-2 text-sm text-rose-800 dark:text-rose-200" role="status">{resetStatus ? t(resetStatus) : ""}</p>
          </div>
        </div>
        <Button
          type="button"
          disabled={isResetting}
          className="border-rose-700 bg-rose-700 hover:bg-rose-800 dark:border-rose-700 dark:bg-rose-700 dark:hover:bg-rose-800"
          onClick={() => void onReset()}
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          {t("settings.reset.action")}
        </Button>
      </div>
    </section>
  );
}

function ToggleCard({ checked, label, description, onChange }: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn(
      "flex min-h-20 cursor-pointer items-center gap-4 rounded-xl border p-4 transition",
      checked
        ? "border-cyan-300 bg-cyan-50/70 dark:border-cyan-900 dark:bg-cyan-950/30"
        : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900"
    )}>
      <Switch checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{label}</span>
        <span className="mt-1 block text-xs leading-4 text-slate-500">{description}</span>
      </span>
    </label>
  );
}

function StatusTile({ icon: Icon, label, value, tone }: {
  icon: typeof Paintbrush;
  label: string;
  value: string;
  tone: "violet" | "amber" | "emerald";
}) {
  const tones = {
    violet: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
    emerald: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
  };
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900">
      <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg", tones[tone])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs text-slate-500">{label}</span>
        <span className="mt-0.5 block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{value}</span>
      </span>
    </div>
  );
}
