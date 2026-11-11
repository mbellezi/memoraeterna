import { PromptsSettingsView } from "./PromptsSettingsView";
import { ObsidianWikiCard } from "./ObsidianWikiCard";
import { RelationLabelsCard, ContentLanguageSelect } from "./RelationLabelsCard";
import { useEffect, useState } from "react";
import {
  Bot,
  ChevronRight,
  CircleGauge,
  Cpu,
  DatabaseBackup,
  HardDrive,
  FolderOpen,
  Globe,
  Languages,
  Monitor,
  Moon,
  Network,
  Paintbrush,
  PlugZap,
  RotateCcw,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Sprout,
  Sun,
  Trash2
} from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import type { AppSettings, AppSettingsUpdate, StorageSettings, ThemeMode } from "../../shared/ipc";
import { appLanguageCodes } from "../../shared/ipc";
import type { SettingsScope } from "../../shared/settings-registry";
import { cn } from "../lib/cn";
import { AiSettingsView } from "./AiSettingsView";
import { BackupView } from "./BackupView";
import { IntegrationGatewaySettings } from "./IntegrationGatewaySettings";
import { LocalModelsView } from "./LocalModelsView";
import { ObsidianSyncStatusCard } from "./ObsidianSyncStatusCard";
import { AdvancedDisclosure } from "./settings/AdvancedDisclosure";
import { KnowledgeControlsPanel } from "./settings/KnowledgeControls";
import { MatchingSettingsGroup } from "./settings/MatchingSettingsGroup";
import { matchingGroupModel } from "./settings/matching-group-model";
import {
  bookLookupModeOf,
  bookLookupModes,
  bookLookupPatch,
  obsidianSyncModeOf,
  obsidianSyncModePatch,
  obsidianSyncModes,
  type BookLookupMode,
  type ObsidianSyncMode
} from "./settings/merged-controls";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import type { ToastTone } from "./ui/toast";

interface SettingsViewProps {
  activeScope: SettingsScope;
  appSettings: AppSettings;
  settings: StorageSettings;
  isSaving: boolean;
  t: (key: MessageKey) => string;
  onAppSettingsChange: (settings: AppSettingsUpdate) => void;
  onChange: (settings: StorageSettings) => void;
  onSelectObsidianVault: () => Promise<void>;
  onScopeChange: (scope: SettingsScope) => void;
  onToast: (message: MessageKey, tone: ToastTone) => void;
  onReset?: () => Promise<void>;
}

export type { SettingsScope };

const themeModes: Array<{
  mode: ThemeMode;
  icon: typeof Moon;
  label: MessageKey;
}> = [
  { mode: "light", icon: Sun, label: "settings.appearance.themeModes.light" },
  { mode: "dark", icon: Moon, label: "settings.appearance.themeModes.dark" },
  { mode: "system", icon: Monitor, label: "settings.appearance.themeModes.system" }
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
    id: "prompts",
    icon: Sparkles,
    label: "prompts.title",
    description: "prompts.navigationDescription",
    accent: "from-cyan-500/20 via-teal-500/10 to-transparent",
    iconStyle: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200"
  },
  {
    id: "knowledge",
    icon: Sprout,
    label: "settings.dashboard.navigation.knowledge",
    description: "settings.dashboard.navigation.knowledgeDescription",
    accent: "from-amber-500/20 via-orange-500/10 to-transparent",
    iconStyle: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
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
    id: "external-services",
    icon: Globe,
    label: "settings.dashboard.navigation.externalServices",
    description: "settings.dashboard.navigation.externalServicesDescription",
    accent: "from-sky-500/20 via-blue-500/10 to-transparent",
    iconStyle: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200"
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

export function SettingsScopeMenu({
  activeScope,
  t,
  onScopeChange,
  collapsed = false
}: {
  collapsed?: boolean;
  activeScope: SettingsScope;
  t: SettingsViewProps["t"];
  onScopeChange: (scope: SettingsScope) => void;
}) {
  return (
    <div className="mt-2 border-t border-slate-200 pt-3 dark:border-slate-800">
      <p
        className={cn(
          "px-3 pb-2 text-[0.68rem] font-bold uppercase tracking-[0.18em] text-slate-400",
          collapsed && "sr-only"
        )}
      >
        {t("settings.dashboard.navigation.label")}
      </p>
      <div
        className="grid gap-1"
        role="tablist"
        aria-label={t("settings.dashboard.navigation.label")}
      >
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
              aria-label={t(scope.label)}
              title={collapsed ? t(scope.label) : undefined}
              aria-controls={`settings-panel-${scope.id}`}
              className={cn(
                "group flex min-w-0 w-full items-center rounded-lg py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                collapsed ? "min-h-9 justify-center px-1" : "min-h-12 gap-3 px-3",
                isActive
                  ? "bg-slate-900 text-white dark:bg-white dark:text-slate-950"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-900"
              )}
              onClick={() => onScopeChange(scope.id)}
            >
              <span
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                  isActive ? "bg-white/10 dark:bg-slate-950/10" : scope.iconStyle
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className={cn("min-w-0 flex-1", collapsed && "sr-only")}>
                <span className="block text-sm font-semibold">{t(scope.label)}</span>
                <span
                  className={cn(
                    "mt-0.5 block truncate text-[0.69rem]",
                    isActive ? "text-slate-300 dark:text-slate-600" : "text-slate-500"
                  )}
                >
                  {t(scope.description)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SettingsView({
  activeScope,
  appSettings,
  settings,
  isSaving,
  t,
  onAppSettingsChange,
  onChange,
  onSelectObsidianVault,
  onScopeChange,
  onToast,
  onReset
}: SettingsViewProps) {
  const [isResetting, setIsResetting] = useState(false);
  const [resetStatus, setResetStatus] = useState<MessageKey | null>(null);
  const activeScopeDefinition = scopes.find((scope) => scope.id === activeScope) ?? scopes[0]!;
  // The header tile names the matching preset; away from the calibrated set it reads "Custom".
  const matchingModel = matchingGroupModel(appSettings, t as Translator);
  const activeMatchingPresetName =
    matchingModel.options.find((option) => option.id === matchingModel.selectedPresetId)?.label ??
    t("settings.matching.presets.recommended");

  function update<K extends keyof StorageSettings>(key: K, value: StorageSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function updateMany(patch: Partial<StorageSettings>) {
    onChange({ ...settings, ...patch });
  }

  async function resetLibrary() {
    if (!window.confirm(t("settings.reset.confirmation"))) return;
    setIsResetting(true);
    setResetStatus(null);
    try {
      const result = await window.app.settings.resetLibrary();
      await onReset?.();
      setResetStatus(
        result.failedFiles > 0 ? "settings.reset.completedWithWarnings" : "settings.reset.completed"
      );
    } catch {
      setResetStatus("settings.reset.failed");
    } finally {
      setIsResetting(false);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-[1480px] gap-5">
      {activeScope === "overview" ? (
        <header className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 p-6 text-white shadow-sm dark:border-slate-800">
          <div className="pointer-events-none absolute -right-14 -top-28 h-72 w-72 rounded-full bg-cyan-400/20 blur-3xl" />
          <div className="pointer-events-none absolute bottom-[-8rem] left-1/3 h-64 w-64 rounded-full bg-violet-500/20 blur-3xl" />
          <div className="relative flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-2xl">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t("settings.dashboard.eyebrow")}
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">
                {t("settings.dashboard.title")}
              </h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-slate-300">
                {t("settings.dashboard.description")}
              </p>
            </div>
            <div className="grid min-w-[16rem] gap-2 rounded-xl border border-white/10 bg-white/5 p-3 backdrop-blur">
              <div className="flex items-center justify-between gap-4 text-xs text-slate-300">
                <span>{t("settings.dashboard.summary.interface")}</span>
                <strong className="text-white">
                  {t(`settings.language.languages.${appSettings.language}` as MessageKey)}
                </strong>
              </div>
              <div className="flex items-center justify-between gap-4 text-xs text-slate-300">
                <span>{t("settings.dashboard.summary.knowledgeMatching")}</span>
                <strong className="text-amber-300">{activeMatchingPresetName}</strong>
              </div>
              <div className="flex items-center justify-between gap-4 text-xs text-slate-300">
                <span>{t("settings.dashboard.summary.obsidian")}</span>
                <strong
                  className={
                    settings.obsidianSyncEnabled && settings.obsidianVaultPath
                      ? "text-emerald-300"
                      : "text-slate-400"
                  }
                >
                  {t(
                    settings.obsidianSyncEnabled && settings.obsidianVaultPath
                      ? "settings.dashboard.states.active"
                      : "settings.dashboard.states.needsSetup"
                  )}
                </strong>
              </div>
            </div>
          </div>
        </header>
      ) : null}

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
            onNavigate={onScopeChange}
          />
        ) : null}

        {activeScope === "personalization" ? (
          <div className="grid gap-5">
            <ScopeHeader scope={activeScopeDefinition} t={t} />
            <div className="grid gap-5 xl:grid-cols-2">
              <AppearanceCard appSettings={appSettings} t={t} onChange={onAppSettingsChange} />
            </div>
          </div>
        ) : null}

        {activeScope === "prompts" ? (
          <PromptsSettingsView t={t as Translator} language={appSettings.language} />
        ) : null}

        {activeScope === "knowledge" ? (
          <div className="grid gap-5">
            <ScopeHeader scope={activeScopeDefinition} t={t} />
            <KnowledgeControlsPanel t={t as Translator} />
            <AdvancedDisclosure t={t} hint={t("settings.knowledge.advanced.hint")}>
              <MatchingSettingsGroup
                appSettings={appSettings}
                t={t as Translator}
                onChange={onAppSettingsChange}
              />
              <div className="grid gap-5 xl:grid-cols-2">
                <SummarizationCard appSettings={appSettings} t={t} onChange={onAppSettingsChange} />
              </div>
            </AdvancedDisclosure>
          </div>
        ) : null}

        {activeScope === "intelligence" ? (
          <div className="grid gap-5">
            <ScopeHeader scope={activeScopeDefinition} t={t} />
            <AiSettingsView t={t} interfaceLanguage={appSettings.language} onToast={onToast} />
            <AdvancedDisclosure t={t} hint={t("settings.advanced.hint")}>
              <LocalEmbeddingRuntimeCard
                appSettings={appSettings}
                t={t}
                onChange={onAppSettingsChange}
              />
            </AdvancedDisclosure>
          </div>
        ) : null}

        {activeScope === "models" ? (
          <div className="grid gap-5">
            <ScopeHeader scope={activeScopeDefinition} t={t} />
            <LocalModelsView t={t} onToast={onToast} />
          </div>
        ) : null}

        {activeScope === "external-services" ? (
          <div className="grid min-w-0 gap-5">
            <ScopeHeader scope={activeScopeDefinition} t={t} />
            <ExternalServicesCard appSettings={appSettings} t={t} onChange={onAppSettingsChange} />
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
              onUpdateMany={updateMany}
              onSelectVault={onSelectObsidianVault}
            />
            <ObsidianWikiCard t={t} />
          </div>
        ) : null}

        {activeScope === "data" ? (
          <div className="grid gap-5">
            <ScopeHeader scope={activeScopeDefinition} t={t} />
            <StorageCard settings={settings} t={t} onUpdate={update} />
            <ObsidianSyncStatusCard
              available={
                Boolean(settings.obsidianVaultPath) &&
                settings.obsidianSyncEnabled &&
                !settings.obsidianSyncPaused
              }
              showAction
              t={t}
            />
            <RelationLabelsCard appSettings={appSettings} onChange={onAppSettingsChange} t={t} />
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
    </section>
  );
}

function LocalEmbeddingRuntimeCard({
  appSettings,
  t,
  onChange
}: {
  appSettings: AppSettings;
  t: SettingsViewProps["t"];
  onChange: SettingsViewProps["onAppSettingsChange"];
}) {
  return (
    <section className="flex items-start justify-between gap-4 rounded-xl border border-border bg-surface p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-soft text-accent">
          <Cpu className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <Label htmlFor="keepLocalEmbeddingModelsLoaded">
            {t("settings.ai.keepLocalEmbeddingModelsLoaded")}
          </Label>
          <p className="mt-1 text-sm leading-5 text-secondary-foreground">
            {t("settings.ai.keepLocalEmbeddingModelsLoadedDescription")}
          </p>
        </div>
      </div>
      <Switch
        id="keepLocalEmbeddingModelsLoaded"
        checked={appSettings.keepLocalEmbeddingModelsLoaded}
        aria-label={t("settings.ai.keepLocalEmbeddingModelsLoaded")}
        onChange={(event) => onChange({ keepLocalEmbeddingModelsLoaded: event.target.checked })}
      />
    </section>
  );
}

function OverviewPanel({
  appSettings,
  settings,
  t,
  onNavigate
}: {
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
            <h3 className="font-semibold text-slate-950 dark:text-white">
              {t("settings.dashboard.overview.title")}
            </h3>
            <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-400">
              {t("settings.dashboard.overview.description")}
            </p>
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
            value={t(
              settings.obsidianSyncEnabled && settings.obsidianVaultPath
                ? "settings.dashboard.states.active"
                : "settings.dashboard.states.needsSetup"
            )}
            tone="amber"
          />
          <StatusTile
            icon={HardDrive}
            label={t("settings.dashboard.summary.uploadCopies")}
            value={t(
              settings.uploadCopiesEnabled
                ? "settings.dashboard.states.enabled"
                : "settings.dashboard.states.internalOnly"
            )}
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
              <span
                className={cn(
                  "pointer-events-none absolute inset-0 bg-gradient-to-br opacity-70",
                  scope.accent
                )}
              />
              <span className="relative flex h-full flex-col">
                <span
                  className={cn("grid h-10 w-10 place-items-center rounded-xl", scope.iconStyle)}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <span className="mt-5 text-base font-semibold text-slate-950 dark:text-white">
                  {t(scope.label)}
                </span>
                <span className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-400">
                  {t(scope.description)}
                </span>
                <span className="mt-auto flex items-center gap-1 pt-4 text-xs font-bold uppercase tracking-[0.12em] text-slate-700 dark:text-slate-300">
                  {t("settings.dashboard.openScope")}
                  <ChevronRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-1"
                    aria-hidden="true"
                  />
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
      <span
        className={cn(
          "pointer-events-none absolute inset-0 bg-gradient-to-r opacity-70",
          scope.accent
        )}
      />
      <div className="relative flex items-start gap-3">
        <span
          className={cn("grid h-11 w-11 shrink-0 place-items-center rounded-xl", scope.iconStyle)}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-950 dark:text-white">
            {t(scope.label)}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-400">
            {t(scope.description)}
          </p>
        </div>
      </div>
    </section>
  );
}

function AppearanceCard({
  appSettings,
  t,
  onChange
}: {
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
          <h3 className="font-semibold text-slate-950 dark:text-white">
            {t("settings.appearance.title")}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {t("settings.dashboard.appearanceDescription")}
          </p>
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
          onChange={(event) =>
            onChange({ language: event.target.value as AppSettings["language"] })
          }
        >
          {appLanguageCodes.map((languageCode) => (
            <option key={languageCode} value={languageCode}>
              {t(`settings.language.languages.${languageCode}` as MessageKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <ContentLanguageSelect appSettings={appSettings} onChange={onChange} t={t} />
        <Label>{t("settings.appearance.themeMode")}</Label>
        <div className="grid grid-cols-3 gap-2">
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
      <AdvancedDisclosure t={t} hint={t("settings.advanced.hint")} nested>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="graphWheelZoomSensitivity">
              {t("settings.appearance.graphWheelZoomSensitivity")}
            </Label>
            <output className="text-sm font-semibold tabular-nums text-violet-700 dark:text-violet-300">
              {appSettings.graphWheelZoomSensitivity.toLocaleString(appSettings.language, {
                maximumFractionDigits: 2
              })}
              ×
            </output>
          </div>
          <input
            id="graphWheelZoomSensitivity"
            type="range"
            min="0.5"
            max="1.5"
            step="0.05"
            value={appSettings.graphWheelZoomSensitivity}
            aria-describedby="graphWheelZoomSensitivityDescription"
            className="h-2 w-full cursor-pointer accent-violet-600"
            onChange={(event) =>
              onChange({ graphWheelZoomSensitivity: event.currentTarget.valueAsNumber })
            }
          />
          <div
            className="flex justify-between text-xs text-slate-500 dark:text-slate-400"
            aria-hidden="true"
          >
            <span>{t("settings.appearance.zoomSensitivitySlower")}</span>
            <span>{t("settings.appearance.zoomSensitivityFaster")}</span>
          </div>
          <p
            id="graphWheelZoomSensitivityDescription"
            className="text-xs leading-5 text-slate-500 dark:text-slate-400"
          >
            {t("settings.appearance.graphWheelZoomSensitivityDescription")}
          </p>
        </div>
      </AdvancedDisclosure>
    </section>
  );
}

function ExternalServicesCard({
  appSettings,
  t,
  onChange
}: {
  appSettings: AppSettings;
  t: SettingsViewProps["t"];
  onChange: SettingsViewProps["onAppSettingsChange"];
}) {
  const modeLabels: Record<BookLookupMode, MessageKey> = {
    off: "settings.metadataEnrichment.off",
    auto: "settings.metadataEnrichment.auto",
    "open-library": "settings.metadataEnrichment.openLibrary",
    "google-books": "settings.metadataEnrichment.googleBooks"
  };
  return (
    <section className="grid min-w-0 gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="grid min-w-0 gap-1">
        <Label htmlFor="bookMetadataProvider">{t("settings.metadataEnrichment.title")}</Label>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          {t("settings.metadataEnrichment.description")}
        </p>
        <select
          id="bookMetadataProvider"
          value={bookLookupModeOf(appSettings)}
          onChange={(event) => onChange(bookLookupPatch(event.target.value as BookLookupMode))}
          className="mt-2 h-9 min-w-0 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground"
        >
          {bookLookupModes.map((mode) => (
            <option key={mode} value={mode}>
              {t(modeLabels[mode])}
            </option>
          ))}
        </select>
        <p className="text-xs leading-5 text-slate-500">
          {t("settings.metadataEnrichment.providerHint")}
        </p>
        <GoogleBooksKeySettings t={t} />
      </div>
    </section>
  );
}

function SummarizationCard({
  appSettings,
  t,
  onChange
}: {
  appSettings: AppSettings;
  t: SettingsViewProps["t"];
  onChange: SettingsViewProps["onAppSettingsChange"];
}) {
  return (
    <section className="grid content-start gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="font-semibold text-slate-950 dark:text-white">
            {t("settings.summarization.title")}
          </h3>
          <p className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-400">
            {t("settings.summarization.description")}
          </p>
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="summaryMinimumWordCount">
          {t("settings.summarization.minimumWordCount")}
        </Label>
        <Input
          id="summaryMinimumWordCount"
          type="number"
          min={0}
          max={1000}
          step={1}
          value={appSettings.summaryMinimumWordCount}
          onChange={(event) =>
            onChange({
              summaryMinimumWordCount: Math.max(
                0,
                Math.min(1000, Math.floor(Number(event.target.value)))
              )
            })
          }
        />
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
          {t("settings.summarization.minimumWordCountHint")}
        </p>
      </div>
    </section>
  );
}

function ObsidianCard({
  settings,
  isSaving,
  t,
  onUpdate,
  onUpdateMany,
  onSelectVault
}: {
  settings: StorageSettings;
  isSaving: boolean;
  t: SettingsViewProps["t"];
  onUpdate: <K extends keyof StorageSettings>(key: K, value: StorageSettings[K]) => void;
  onUpdateMany: (patch: Partial<StorageSettings>) => void;
  onSelectVault: () => Promise<void>;
}) {
  const syncMode = obsidianSyncModeOf(settings);
  const hasVault = Boolean(settings.obsidianVaultPath?.trim());
  const modeLabels: Record<ObsidianSyncMode, MessageKey> = {
    off: "settings.storage.obsidianSyncModes.off",
    on: "settings.storage.obsidianSyncModes.on",
    paused: "settings.storage.obsidianSyncModes.paused"
  };
  const modeHints: Record<ObsidianSyncMode, MessageKey> = {
    off: "settings.dashboard.syncDescriptions.off",
    on: "settings.dashboard.syncDescriptions.enabled",
    paused: "settings.dashboard.syncDescriptions.paused"
  };
  return (
    <section className="grid gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200">
            <ServerCog className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-semibold text-slate-950 dark:text-white">
              {t("integrations.obsidianPlugin")}
            </h3>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {t("settings.dashboard.obsidianDescription")}
            </p>
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-3 py-1 text-xs font-bold",
            settings.obsidianSyncEnabled && settings.obsidianVaultPath
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
              : "bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-300"
          )}
        >
          {t(
            settings.obsidianSyncEnabled && settings.obsidianVaultPath
              ? "settings.dashboard.states.active"
              : "settings.dashboard.states.needsSetup"
          )}
        </span>
      </div>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor="obsidianVaultPath">{t("settings.storage.obsidianVaultPath")}</Label>
        <div className="flex min-w-0 flex-wrap gap-2">
          <Input
            className="min-w-0 flex-1 basis-48"
            id="obsidianVaultPath"
            value={settings.obsidianVaultPath ?? ""}
            onChange={(event) => onUpdate("obsidianVaultPath", event.target.value || null)}
          />
          <Button
            type="button"
            className="shrink-0 whitespace-nowrap"
            disabled={isSaving}
            onClick={() => void onSelectVault()}
          >
            <FolderOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t("settings.storage.selectObsidianVault")}
          </Button>
        </div>
      </div>
      <div className="grid gap-1 md:max-w-sm">
        <Label htmlFor="obsidianSyncMode">{t("settings.storage.obsidianSyncEnabled")}</Label>
        <select
          id="obsidianSyncMode"
          className="h-9 min-w-0 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground"
          value={syncMode}
          aria-describedby="obsidianSyncMode-hint"
          onChange={(event) =>
            onUpdateMany(obsidianSyncModePatch(event.target.value as ObsidianSyncMode))
          }
        >
          {obsidianSyncModes.map((mode) => (
            <option
              key={mode}
              value={mode}
              disabled={mode !== "off" && !hasVault && mode !== syncMode}
            >
              {t(modeLabels[mode])}
            </option>
          ))}
        </select>
        <p id="obsidianSyncMode-hint" className="text-xs leading-5 text-muted-foreground">
          {t(modeHints[syncMode])}
          {!hasVault && syncMode === "off"
            ? ` ${t("settings.storage.obsidianSyncNeedsVault")}`
            : ""}
        </p>
      </div>
      <AdvancedDisclosure t={t} hint={t("settings.advanced.hint")} nested>
        <div className="grid gap-2 md:max-w-sm">
          <Label htmlFor="managedRoot">{t("settings.storage.obsidianRootFolder")}</Label>
          <Input
            id="managedRoot"
            value={settings.managedRoot}
            onChange={(event) => onUpdate("managedRoot", event.target.value)}
          />
        </div>
      </AdvancedDisclosure>
    </section>
  );
}

function StorageCard({
  settings,
  t,
  onUpdate
}: {
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
          <h3 className="font-semibold text-slate-950 dark:text-white">
            {t("settings.storage.title")}
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {t("settings.dashboard.storageDescription")}
          </p>
        </div>
      </div>
      <ToggleCard
        id="uploadCopiesEnabled"
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

function ResetCard({
  isResetting,
  resetStatus,
  t,
  onReset
}: {
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
            <p className="text-[0.68rem] font-bold uppercase tracking-[0.18em] text-rose-700 dark:text-rose-300">
              {t("settings.dashboard.dangerZone")}
            </p>
            <h3 className="mt-1 font-semibold text-rose-950 dark:text-rose-100">
              {t("settings.reset.title")}
            </h3>
            <p className="mt-1 text-sm leading-5 text-rose-900 dark:text-rose-200">
              {t("settings.reset.description")}
            </p>
            <p className="mt-2 text-sm text-rose-800 dark:text-rose-200" role="status">
              {resetStatus ? t(resetStatus) : ""}
            </p>
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

function ToggleCard({
  id,
  checked,
  label,
  description,
  onChange
}: {
  id?: string;
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex min-h-20 cursor-pointer items-center gap-4 rounded-xl border p-4 transition",
        checked
          ? "border-cyan-300 bg-cyan-50/70 dark:border-cyan-900 dark:bg-cyan-950/30"
          : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900"
      )}
    >
      <Switch id={id} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">
          {label}
        </span>
        <span className="mt-1 block text-xs leading-4 text-slate-500">{description}</span>
      </span>
    </label>
  );
}

function StatusTile({
  icon: Icon,
  label,
  value,
  tone
}: {
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
        <span className="mt-0.5 block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
          {value}
        </span>
      </span>
    </div>
  );
}

function GoogleBooksKeySettings({ t }: { t: SettingsViewProps["t"] }) {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void window.app.settings
      .getGoogleBooksKeyStatus()
      .then((status) => {
        if (active) setConfigured(status.configured);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function update(value: string | null) {
    setBusy(true);
    setError(false);
    try {
      const status = await window.app.settings.updateGoogleBooksKey({ apiKey: value });
      setConfigured(status.configured);
      setApiKey("");
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3 grid min-w-0 gap-2">
      <Label htmlFor="googleBooksApiKey">{t("settings.metadataEnrichment.apiKey")}</Label>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Input
          id="googleBooksApiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 basis-48"
          value={apiKey}
          disabled={busy}
          onChange={(event) => setApiKey(event.target.value)}
        />
        <Button
          className="shrink-0 whitespace-nowrap"
          disabled={busy || !apiKey.trim()}
          onClick={() => void update(apiKey.trim())}
        >
          {t("settings.metadataEnrichment.saveKey")}
        </Button>
        <Button
          className="shrink-0 whitespace-nowrap"
          disabled={busy || !configured}
          onClick={() => void update(null)}
        >
          {t("settings.metadataEnrichment.removeKey")}
        </Button>
      </div>
      <p role="status" className="text-xs text-slate-500">
        {t(
          busy
            ? "shell.states.loading"
            : configured
              ? "settings.metadataEnrichment.keySaved"
              : "settings.metadataEnrichment.noKey"
        )}
      </p>
      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {t("settings.metadataEnrichment.keyError")}
        </p>
      ) : null}
    </div>
  );
}
