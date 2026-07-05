import type { FormEvent } from "react";
import {
  Archive,
  FileX,
  HardDrive,
  Languages,
  Moon,
  Paintbrush,
  Save,
  ServerCog,
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
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

interface SettingsViewProps {
  appSettings: AppSettings;
  settings: StorageSettings;
  status: MessageKey;
  isSaving: boolean;
  t: (key: MessageKey) => string;
  onAppSettingsChange: (settings: AppSettingsUpdate) => void;
  onChange: (settings: StorageSettings) => void;
  onSave: () => void;
}

const deletionPolicies: Array<{
  policy: StorageSettings["deletionPolicy"];
  icon: typeof FileX;
  label: MessageKey;
}> = [
  { policy: "tombstone", icon: FileX, label: "settings.storage.deletePolicies.tombstone" },
  { policy: "archive", icon: Archive, label: "settings.storage.deletePolicies.archive" },
  { policy: "delete", icon: Trash2, label: "settings.storage.deletePolicies.delete" }
];

const themeModes: Array<{
  mode: ThemeMode;
  icon: typeof Moon;
  label: MessageKey;
}> = [
  { mode: "dark", icon: Moon, label: "settings.appearance.themeModes.dark" },
  { mode: "light", icon: Sun, label: "settings.appearance.themeModes.light" }
];

export function SettingsView({
  appSettings,
  settings,
  status,
  isSaving,
  t,
  onAppSettingsChange,
  onChange,
  onSave
}: SettingsViewProps) {
  function update<K extends keyof StorageSettings>(key: K, value: StorageSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave();
  }

  return (
    <form className="grid gap-6" onSubmit={submit}>
      <section className="grid gap-4 border-b border-slate-200 pb-6 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Paintbrush className="h-5 w-5 text-violet-700 dark:text-violet-300" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-slate-950 dark:text-slate-50">{t("settings.appearance.title")}</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="uiLocale">
              <span className="inline-flex items-center gap-2">
                <Languages className="h-4 w-4" aria-hidden="true" />
                {t("settings.language.uiLocale")}
              </span>
            </Label>
            <select
              id="uiLocale"
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition focus:border-cyan-700 focus:ring-2 focus:ring-cyan-100 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-50 dark:focus:border-cyan-400 dark:focus:ring-cyan-950"
              value={appSettings.language}
              onChange={(event) => onAppSettingsChange({ language: event.target.value as AppSettings["language"] })}
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
            <div className="grid grid-cols-2 overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
              {themeModes.map(({ mode, icon: Icon, label }) => (
                <button
                  key={mode}
                  type="button"
                  aria-label={t(label)}
                  aria-pressed={appSettings.themeMode === mode}
                  className={
                    appSettings.themeMode === mode
                      ? "flex h-9 items-center justify-center gap-2 bg-cyan-700 text-sm font-medium text-white dark:bg-cyan-600"
                      : "flex h-9 items-center justify-center gap-2 bg-white text-sm font-medium text-slate-700 hover:bg-slate-100 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-900"
                  }
                  onClick={() => onAppSettingsChange({ themeMode: mode })}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 border-b border-slate-200 pb-6 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <ServerCog className="h-5 w-5 text-cyan-700 dark:text-cyan-300" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-slate-950 dark:text-slate-50">{t("integrations.obsidianPlugin")}</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="obsidianVaultPath">{t("settings.storage.obsidianVaultPath")}</Label>
            <Input
              id="obsidianVaultPath"
              value={settings.obsidianVaultPath ?? ""}
              onChange={(event) => update("obsidianVaultPath", event.target.value || null)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="managedRoot">{t("settings.storage.obsidianRootFolder")}</Label>
            <Input
              id="managedRoot"
              value={settings.managedRoot}
              onChange={(event) => update("managedRoot", event.target.value)}
            />
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex min-h-12 items-center gap-3 rounded-md border border-slate-200 px-3 dark:border-slate-800">
            <Switch
              checked={settings.obsidianSyncEnabled}
              onChange={(event) => update("obsidianSyncEnabled", event.target.checked)}
            />
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{t("settings.storage.obsidianSyncEnabled")}</span>
          </label>
          <label className="flex min-h-12 items-center gap-3 rounded-md border border-slate-200 px-3 dark:border-slate-800">
            <Switch
              checked={settings.obsidianSyncPaused}
              onChange={(event) => update("obsidianSyncPaused", event.target.checked)}
            />
            <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{t("settings.storage.obsidianSyncPaused")}</span>
          </label>
          <div className="grid gap-2">
            <Label>{t("settings.storage.obsidianDeletePolicy")}</Label>
            <div className="grid grid-cols-3 overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
              {deletionPolicies.map(({ policy, icon: Icon, label }) => (
                <button
                  key={policy}
                  type="button"
                  aria-label={t(label)}
                  aria-pressed={settings.deletionPolicy === policy}
                  className={
                    settings.deletionPolicy === policy
                      ? "flex h-9 items-center justify-center bg-cyan-700 text-white dark:bg-cyan-600"
                      : "flex h-9 items-center justify-center bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-950 dark:text-slate-300 dark:hover:bg-slate-900"
                  }
                  onClick={() => update("deletionPolicy", policy as StorageSettings["deletionPolicy"])}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-4 border-b border-slate-200 pb-6 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-slate-950 dark:text-slate-50">{t("settings.storage.title")}</h2>
        </div>
        <label className="flex min-h-12 items-center gap-3 rounded-md border border-slate-200 px-3 dark:border-slate-800">
          <Switch
            checked={settings.uploadCopiesEnabled}
            onChange={(event) => update("uploadCopiesEnabled", event.target.checked)}
          />
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{t("settings.storage.copyUploadedFilesEnabled")}</span>
        </label>
        <div className="grid gap-2">
          <Label htmlFor="uploadCopiesFolderPath">{t("settings.storage.uploadedFilesPath")}</Label>
          <Input
            id="uploadCopiesFolderPath"
            value={settings.uploadCopiesFolderPath ?? ""}
            disabled={!settings.uploadCopiesEnabled}
            onChange={(event) => update("uploadCopiesFolderPath", event.target.value || null)}
          />
        </div>
      </section>

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-600 dark:text-slate-300" role="status">
          {t(status)}
        </p>
        <Button type="submit" disabled={isSaving}>
          <Save className="h-4 w-4" aria-hidden="true" />
          {t("shell.actions.save")}
        </Button>
      </div>
    </form>
  );
}
