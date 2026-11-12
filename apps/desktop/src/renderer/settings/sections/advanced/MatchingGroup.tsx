import { useId, useState } from "react";
import { RotateCcw } from "lucide-react";
import { recommendedMatchingPresetId, type MatchingValueControlId } from "@app/domain";
import type { Translator } from "@app/i18n";

import { settingsRegistryV2, type SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { ErrorState } from "../../../components/ui/error-state";
import { Input } from "../../../components/ui/input";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { SolidTriangle } from "../../../components/ui/solid-glyphs";
import { ConfirmDialog } from "../../diagnostics/ConfirmDialog";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import { NumberField, SettingSelect, SettingSwitch, useHeldValue } from "./advanced-controls";
import {
  deletePresetUpdate,
  differenceText,
  differencesOf,
  formatValue,
  isRecommended,
  matchingSpecOf,
  matchingSubgroups,
  presetLimit,
  presetNameMax,
  presetBaseName,
  presetOptions,
  restoreCalibratedUpdate,
  savePresetUpdate,
  selectPresetUpdate,
  subgroupKeys,
  updateForValue,
  valueOf,
  validPresetName,
  type MatchingControlSpec,
  type PresetEdit
} from "./matching-model";
import type { AppSettingsState } from "./use-app-settings";

/** The preset selector's DOM id: focus goes back to it when the calibrated values are restored. */
const presetSelectId = "matching-preset";

const entryLabelOf = (t: Translator, id: MatchingValueControlId): string => {
  const entry = settingsRegistryV2.find((candidate) => candidate.id === id);
  return entry ? labelOf(t, entry) : id;
};

/** What the matching rows wait on: skeleton rows while the presets are read, a quiet error if they could not be. */
function MatchingLoading({ t }: { t: Translator }) {
  return (
    <LoadingState t={t} className="mt-4">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border-b border-border py-4"
        >
          <Skeleton className="h-3.5 w-52" />
          <Skeleton className="row-span-2 h-8 w-28 rounded-md" />
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
      ))}
    </LoadingState>
  );
}

/** "1 value differs from the calibrated set", which, and the way back; in text as well as colour. */
function CalibrationNotice({
  app,
  t
}: {
  app: AppSettingsState & { settings: NonNullable<AppSettingsState["settings"]> };
  t: Translator;
}) {
  const differences = differencesOf(app.settings);
  if (differences.length === 0) return null;
  const list = differences
    .map((difference) => differenceText(t, difference, (id) => entryLabelOf(t, id)))
    .join("; ");
  return (
    <div
      role="status"
      className="mt-4 grid gap-2 rounded-lg bg-warning-soft px-4 py-3 text-sm text-foreground"
    >
      <p className="m-0 flex items-start gap-3 [text-wrap:pretty]">
        <SolidTriangle className="mt-0.5 text-warning" />
        <span>
          <b className="font-semibold">
            {t(
              differences.length === 1
                ? "settingsAdvanced.matching.differsOne"
                : "settingsAdvanced.matching.differsMany",
              { values: { count: differences.length } }
            )}
          </b>{" "}
          {t("settingsAdvanced.matching.differsNote")}{" "}
          <span className="text-secondary-foreground">
            {t("settingsAdvanced.matching.differsList", { values: { list } })}
          </span>
        </span>
      </p>
      <div className="pl-7">
        <InlineAction
          onClick={() => {
            void app
              .save((current) => restoreCalibratedUpdate(current))
              .then((ok) => {
                if (ok) queueMicrotask(() => document.getElementById(presetSelectId)?.focus());
              });
          }}
        >
          <RotateCcw aria-hidden="true" />
          {t("settingsAdvanced.matching.restoreCalibrated")}
        </InlineAction>
      </div>
    </div>
  );
}

/** Create, duplicate or rename: a small form in the row's line, with the name checked as it is typed. */
function PresetNameForm({
  t,
  edit,
  initial,
  onSave,
  onCancel
}: {
  t: Translator;
  edit: PresetEdit;
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [tried, setTried] = useState(false);
  const inputId = useId();
  const invalid = tried && !validPresetName(name);
  return (
    <form
      className="mt-2 grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (validPresetName(name)) onSave(name);
        else setTried(true);
      }}
    >
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {t(
          edit === "rename"
            ? "settingsAdvanced.matching.nameRename"
            : "settingsAdvanced.matching.nameNew"
        )}
      </label>
      <Input
        id={inputId}
        autoFocus
        maxLength={presetNameMax}
        value={name}
        aria-invalid={invalid ? true : undefined}
        onChange={(event) => {
          setName(event.target.value);
          setTried(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="max-w-72 text-sm"
      />
      {invalid ? (
        <p role="alert" className="m-0 text-sm text-danger">
          {t("settingsAdvanced.matching.nameInvalid")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit">{t("settingsAdvanced.matching.nameSave")}</Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("shell.actions.cancel")}
        </Button>
      </div>
    </form>
  );
}

type PresetUi = { kind: "none" } | { kind: "edit"; edit: PresetEdit } | { kind: "delete" };

/** The preset row: the selector and, in its line, the four things a person does with presets. */
function PresetRow({
  entry,
  app
}: {
  entry: SettingEntryV2;
  app: AppSettingsState & { settings: NonNullable<AppSettingsState["settings"]> };
}) {
  const { t } = useSettings();
  const { settings } = app;
  const active = settings.activeMatchingPresetId ?? recommendedMatchingPresetId;
  const [shown, hold] = useHeldValue(active);
  const [ui, setUi] = useState<PresetUi>({ kind: "none" });
  const options = presetOptions(t, settings);
  const selected = settings.matchingPresets.find((preset) => preset.id === active);
  const full = settings.matchingPresets.length >= presetLimit;
  // What the selector shows ("Custom: name") is for reading; a name to edit or to copy is the plain one.
  const selectedName = presetBaseName(t, settings, active);

  const choose = (id: string) => {
    hold(id);
    setUi({ kind: "none" });
    void app
      .save((current) => selectPresetUpdate(current, id))
      .then((ok) => {
        if (!ok) hold(null);
      });
  };
  const saveName = (name: string) => {
    const edit = ui.kind === "edit" ? ui.edit : "create";
    setUi({ kind: "none" });
    void app.save((current) => savePresetUpdate(current, edit, name, () => crypto.randomUUID()));
  };

  const links = (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
      <InlineAction disabled={full} onClick={() => setUi({ kind: "edit", edit: "create" })}>
        {t("settingsAdvanced.matching.presetCreate")}
      </InlineAction>
      <InlineAction disabled={full} onClick={() => setUi({ kind: "edit", edit: "duplicate" })}>
        {t("settingsAdvanced.matching.presetDuplicate")}
      </InlineAction>
      <InlineAction disabled={!selected} onClick={() => setUi({ kind: "edit", edit: "rename" })}>
        {t("settingsAdvanced.matching.presetRename")}
      </InlineAction>
      <InlineAction disabled={!selected} onClick={() => setUi({ kind: "delete" })}>
        {t("settingsAdvanced.matching.presetDelete")}
      </InlineAction>
    </div>
  );

  return (
    <>
      <RegistryRow
        entry={entry}
        defaultLabel={t("settingsAdvanced.matching.presetRecommended")}
        // The calibration notice above already offers the way back to this same preset.
        withoutReset={differencesOf(settings).length > 0}
        control={
          <SettingSelect
            id={presetSelectId}
            label={labelOf(t, entry)}
            value={shown}
            options={options.map((option) => ({ value: option.id, label: option.label }))}
            onChange={choose}
            width="16.5rem"
          />
        }
        note={
          <>
            {links}
            {full ? (
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                {t("settingsAdvanced.matching.presetLimit")}
              </p>
            ) : null}
            {ui.kind === "edit" ? (
              <PresetNameForm
                key={ui.edit}
                t={t}
                edit={ui.edit}
                initial={
                  ui.edit === "create"
                    ? ""
                    : ui.edit === "rename"
                      ? selectedName
                      : t("settingsAdvanced.matching.presetCopyName", {
                          values: { name: selectedName }
                        }).slice(0, presetNameMax)
                }
                onSave={saveName}
                onCancel={() => setUi({ kind: "none" })}
              />
            ) : null}
          </>
        }
      />
      <ConfirmDialog
        t={t}
        open={ui.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) setUi({ kind: "none" });
        }}
        title={t("settingsAdvanced.matching.deleteTitle", { values: { name: selectedName } })}
        description={t("settingsAdvanced.matching.deleteBody")}
        confirmLabel={t("settingsAdvanced.matching.deleteConfirm")}
        danger
        onConfirm={() => {
          setUi({ kind: "none" });
          void app.save((current) => deletePresetUpdate(current));
        }}
      />
    </>
  );
}

/** One matching value: a number field (with its unit) or a switch; read-only while Balanced is selected. */
function ValueRow({
  entry,
  spec,
  app
}: {
  entry: SettingEntryV2;
  spec: MatchingControlSpec;
  app: AppSettingsState & { settings: NonNullable<AppSettingsState["settings"]> };
}) {
  const settings = useSettings();
  const { t } = settings;
  const locked = isRecommended(app.settings);
  const value = valueOf(app.settings, spec.id);
  const label = labelOf(t, entry);
  const [failures, setFailures] = useState(0);
  const [held, hold] = useHeldValue(value);
  const write = (next: number | boolean) => {
    hold(next);
    void app
      .save((current) => updateForValue(current, spec.id, next))
      .then((ok) => {
        if (!ok) {
          hold(null);
          setFailures((count) => count + 1);
        }
      });
  };
  const defaultValue = settings.describe(entry.id)?.default;
  const defaultLabel =
    typeof defaultValue === "number"
      ? formatValue(spec, defaultValue, t.locale)
      : typeof defaultValue === "boolean"
        ? t(defaultValue ? "settingsAdvanced.matching.on" : "settingsAdvanced.matching.off")
        : undefined;
  const unit = spec.unit ? t(`settingsAdvanced.units.${spec.unit}`) : undefined;
  return (
    <RegistryRow
      entry={entry}
      {...(defaultLabel !== undefined ? { defaultLabel } : {})}
      control={
        spec.kind === "switch" ? (
          <SettingSwitch
            id={`matching-${spec.id}`}
            label={label}
            checked={held === true}
            disabled={locked}
            onChange={write}
          />
        ) : (
          <NumberField
            key={failures}
            id={`matching-${spec.id}`}
            label={label}
            value={typeof held === "number" ? held : 0}
            control={spec}
            locale={t.locale}
            disabled={locked}
            onCommit={write}
            {...(unit ? { suffix: unit } : {})}
          />
        )
      }
    />
  );
}

/**
 * Advanced › Matching (F4 Q4): the preset selector with its four actions, the calibration notice and
 * the 16 matching values in three subgroups. Reads the app settings once for the section; while they
 * are read it shows rows shaped like the rows, and when they could not be it says so in place, with
 * one retry and the values kept as they were.
 */
export function MatchingGroup({
  entries,
  app
}: {
  entries: readonly SettingEntryV2[];
  app: AppSettingsState;
}) {
  const { t } = useSettings();
  if (app.status === "loading" || app.settings === null) {
    if (app.status === "error")
      return (
        <ErrorState
          t={t}
          className="mt-4"
          message={t("settingsAdvanced.matching.errorTitle")}
          kept={t("settingsAdvanced.matching.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={app.retry}
        />
      );
    return <MatchingLoading t={t} />;
  }
  const ready = app as AppSettingsState & { settings: NonNullable<AppSettingsState["settings"]> };
  const preset = entries.find((entry) => entry.id === "activeMatchingPresetId");
  const bySubgroup = matchingSubgroups.map((subgroup) => ({
    subgroup,
    rows: entries
      .map((entry) => ({ entry, spec: matchingSpecOf(entry.id) }))
      .filter(
        (row): row is { entry: SettingEntryV2; spec: MatchingControlSpec } =>
          row.spec !== null && row.spec.subgroup === subgroup
      )
  }));
  return (
    <>
      <CalibrationNotice app={ready} t={t} />
      {preset ? <PresetRow entry={preset} app={ready} /> : null}
      {bySubgroup.map(({ subgroup, rows }) =>
        rows.length === 0 ? null : (
          <div key={subgroup}>
            <h4 className="m-0 mt-8 text-sm font-semibold text-foreground">
              {t(subgroupKeys(subgroup).title)}
            </h4>
            <p className="m-0 mt-1 max-w-[27.5rem] text-sm text-secondary-foreground [text-wrap:pretty]">
              {t(subgroupKeys(subgroup).intro)}
            </p>
            {rows.map(({ entry, spec }) => (
              <ValueRow key={entry.id} entry={entry} spec={spec} app={ready} />
            ))}
          </div>
        )
      )}
      {app.saveFailed ? (
        <p role="status" className="m-0 mt-3 text-sm text-secondary-foreground">
          {t("settingsAdvanced.saveFailed")}
        </p>
      ) : null}
    </>
  );
}
