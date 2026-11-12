import {
  statusSentence,
  type GardenerAutonomy,
  type KnowledgeControls,
  type TreeShape
} from "@app/domain";
import type { MessageKey } from "@app/i18n";

import { knowledgeControlDomIds, type SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { ErrorState } from "../../../components/ui/error-state";
import { Skeleton } from "../../../components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { ReadOnlyValue, RegistryRow } from "../../SettingRow";
import {
  ChoiceCards,
  NumberField,
  SettingsGroup,
  StatusLine,
  SwitchControl
} from "../../SettingControls";
import { useSettings } from "../../settings-context";
import { groupLabelOf, groupsOf, labelOf, type SettingsSectionId } from "../../settings-model";
import {
  autonomyOptions,
  currencySymbol,
  formatAmount,
  formatMoney,
  gardenerTone,
  monthlyCapMaxUsd,
  parseCap,
  spendView,
  treeShapeOptions
} from "./knowledge-model";
import { RelationLabelsRow } from "./RelationLabelsRow";
import {
  useGardenerStatus,
  useKnowledgeControls,
  useSpend,
  type KnowledgeControlsHandle
} from "./use-knowledge-data";

/** The id each of the six controls goes by in the registry. */
const idOf = (field: keyof typeof knowledgeControlDomIds) => `knowledge.controls.v1.${field}`;

type ReadyControls = { controls: KnowledgeControls; edit: KnowledgeControlsHandle["edit"] } | null;

/**
 * Settings › Knowledge (design record §7.6, the Settings v2 mockup): the Gardener (how far it goes
 * alone, in three cards; pause; the month's cap), the shape of the topic tree, when it may work, and
 * the descriptions of the connections. Registry-driven: one row for each entry of the section, in
 * the registry's groups. While the controls are read the rows keep their place with bars for the
 * controls; when they cannot be read the section says so once, quietly, with the way to try again.
 */
export function KnowledgeSection() {
  const { t, section } = useSettings();
  const handle = useKnowledgeControls();
  const { state } = handle;
  const spend = useSpend();
  const gardener = useGardenerStatus();
  const ready: ReadyControls =
    state.phase === "ready" ? { controls: state.shown, edit: handle.edit } : null;
  const failed = state.phase === "error";
  const controlIds = new Set(
    Object.keys(knowledgeControlDomIds).map((field) => idOf(field as never))
  );

  return (
    <>
      <p className="m-0 mt-4 max-w-[34rem] text-sm text-secondary-foreground [text-wrap:pretty]">
        {t("settingsKnowledge.intro")}
      </p>
      <SaveNote handle={handle} />
      {groupsOf("knowledge").map(({ group, entries }, index) => {
        const shown = failed ? entries.filter((entry) => !controlIds.has(entry.id)) : entries;
        return (
          <KnowledgeGroup
            key={group}
            section={section}
            group={group}
            first={index === 0}
            // A failed read is said once, in the first group; the rows that need it wait for it.
            problem={failed && index === 0}
            onRetry={handle.retry}
            entries={shown}
            ready={ready}
            spend={spend}
            gardener={gardener}
          />
        );
      })}
    </>
  );
}

function SaveNote({ handle }: { handle: KnowledgeControlsHandle }) {
  const { t } = useSettings();
  const { state } = handle;
  if (state.phase !== "ready") return null;
  return (
    <>
      <p role="status" className="sr-only">
        {state.outcome === "saved" ? t("settingsKnowledge.saving.saved") : ""}
      </p>
      {state.saving > 0 ? (
        <div className="mt-3">
          <StatusLine tone="working">{t("settingsKnowledge.saving.saving")}</StatusLine>
        </div>
      ) : state.outcome === "failed" ? (
        <div className="mt-3">
          <StatusLine tone="warn" role="status">
            {t("settingsKnowledge.saving.failed")}
          </StatusLine>
        </div>
      ) : null}
    </>
  );
}

function KnowledgeGroup({
  section,
  group,
  first,
  problem,
  onRetry,
  entries,
  ready,
  spend,
  gardener
}: {
  section: SettingsSectionId;
  group: string;
  first: boolean;
  problem: boolean;
  onRetry: () => void;
  entries: SettingEntryV2[];
  ready: ReadyControls;
  spend: ReturnType<typeof useSpend>;
  gardener: ReturnType<typeof useGardenerStatus>;
}) {
  const { t } = useSettings();
  if (entries.length === 0 && !problem) return null;
  const intro: MessageKey | null =
    group === "schedule" ? "settingsKnowledge.groups.scheduleIntro" : null;
  return (
    <SettingsGroup
      section={section}
      group={group}
      title={groupLabelOf(t, section, group)}
      first={first}
      intro={intro ? t(intro) : undefined}
    >
      {problem ? (
        <ErrorState
          t={t}
          className="mt-4"
          message={t("settingsKnowledge.states.controlsError")}
          kept={t("settingsKnowledge.states.controlsKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={onRetry}
        />
      ) : null}
      {entries.map((entry) => (
        <KnowledgeRow
          key={entry.id}
          entry={entry}
          ready={ready}
          spend={spend}
          gardener={gardener}
        />
      ))}
    </SettingsGroup>
  );
}

function KnowledgeRow({
  entry,
  ready,
  spend,
  gardener
}: {
  entry: SettingEntryV2;
  ready: ReadyControls;
  spend: ReturnType<typeof useSpend>;
  gardener: ReturnType<typeof useGardenerStatus>;
}) {
  const settings = useSettings();
  const { t } = settings;
  const label = labelOf(t, entry);
  const description = settings.describe(entry.id);
  const bar = (className: string) => <Skeleton className={className} />;

  switch (entry.id) {
    case idOf("autonomy"): {
      const fallback = autonomyOptions.find((option) => option.value === description?.default);
      return (
        <RegistryRow
          entry={entry}
          stack
          {...(fallback ? { defaultLabel: t(fallback.label) } : {})}
          control={
            ready ? (
              <ChoiceCards<GardenerAutonomy>
                label={label}
                value={ready.controls.autonomy}
                onChange={(autonomy) => ready.edit({ autonomy })}
                options={autonomyOptions.map((option) => ({
                  value: option.value,
                  label: t(option.label),
                  description: t(option.description)
                }))}
              />
            ) : (
              <div className="grid w-full grid-cols-3 gap-2">
                {[0, 1, 2].map((key) => (
                  <Skeleton key={key} className="h-[5.5rem] rounded-lg" />
                ))}
              </div>
            )
          }
        />
      );
    }
    case idOf("paused"): {
      const status = gardener ? statusSentence(gardener, t.locale) : null;
      return (
        <RegistryRow
          entry={entry}
          defaultLabel={t("settingsKnowledge.pause.default")}
          control={
            ready ? (
              <Button
                variant={ready.controls.paused ? "primary" : "secondary"}
                onClick={() => ready.edit({ paused: !ready.controls.paused })}
              >
                {t(
                  ready.controls.paused
                    ? "settingsKnowledge.pause.resume"
                    : "settingsKnowledge.pause.action"
                )}
              </Button>
            ) : (
              bar("h-8 w-28 rounded-lg")
            )
          }
          note={
            status && gardener ? (
              <StatusLine tone={gardenerTone(gardener)} role="status">
                {status.text}
              </StatusLine>
            ) : undefined
          }
        />
      );
    }
    case idOf("monthlyCapUsd"): {
      const view = spendView(spend);
      const money = (amount: number) => formatMoney(t.locale, amount);
      const defaultCap = typeof description?.default === "number" ? description.default : null;
      return (
        <RegistryRow
          entry={entry}
          {...(defaultCap !== null ? { defaultLabel: money(defaultCap) } : {})}
          control={
            ready ? (
              <NumberField
                value={ready.controls.monthlyCapUsd}
                format={(value) => formatAmount(t.locale, value)}
                parse={parseCap}
                onCommit={(monthlyCapUsd) => ready.edit({ monthlyCapUsd })}
                label={label}
                prefix={currencySymbol(t.locale)}
                invalidMessage={t("settingsKnowledge.cap.invalid", {
                  values: { max: money(monthlyCapMaxUsd) }
                })}
              />
            ) : (
              bar("h-8 w-28 rounded-md")
            )
          }
          note={
            view ? (
              <div className="grid gap-1.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    role="progressbar"
                    aria-label={t("settingsKnowledge.cap.meter")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(view.percent)}
                    aria-valuetext={t("settingsKnowledge.cap.spent", {
                      values: { spent: money(view.spent), cap: money(view.cap) }
                    })}
                    className="inline-block h-2 w-24 shrink-0 overflow-hidden rounded-full bg-soft [box-shadow:inset_0_0_0_1px_var(--border-strong)]"
                  >
                    <span
                      className="block h-full rounded-full bg-muted-foreground"
                      style={{ width: `${view.percent}%` }}
                    />
                  </span>
                  <span>
                    {t("settingsKnowledge.cap.spent", {
                      values: { spent: money(view.spent), cap: money(view.cap) }
                    })}
                  </span>
                </div>
                {view.state !== "open" ? (
                  <StatusLine tone="warn" role="status">
                    {t(
                      view.state === "paused"
                        ? "settingsKnowledge.cap.statePaused"
                        : "settingsKnowledge.cap.stateExhausted"
                    )}
                  </StatusLine>
                ) : null}
              </div>
            ) : undefined
          }
        />
      );
    }
    case idOf("treeShape"): {
      const fallback = treeShapeOptions.find((option) => option.value === description?.default);
      return (
        <RegistryRow
          entry={entry}
          {...(fallback ? { defaultLabel: t(fallback.label) } : {})}
          control={
            ready ? (
              <ToggleGroup<TreeShape>
                label={label}
                value={ready.controls.treeShape}
                onValueChange={(treeShape) => ready.edit({ treeShape })}
              >
                {treeShapeOptions.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    {t(option.label)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              bar("h-8 w-56 rounded-lg")
            )
          }
        />
      );
    }
    case idOf("onlyIdle"):
    case idOf("onlyOnAc"): {
      const field = entry.id === idOf("onlyIdle") ? "onlyIdle" : "onlyOnAc";
      return (
        <RegistryRow
          entry={entry}
          control={
            ready ? (
              <SwitchControl
                t={t}
                label={label}
                checked={ready.controls[field]}
                onChange={(next) => ready.edit({ [field]: next })}
              />
            ) : (
              bar("h-5 w-20 rounded-full")
            )
          }
        />
      );
    }
    case "relationLabels":
      return <RelationLabelsRow t={t} entry={entry} />;
    default:
      // A setting added to this section that the section does not draw yet still shows its value.
      return <RegistryRow entry={entry} control={<ReadOnlyValue entry={entry} />} />;
  }
}

export const section = { id: "knowledge" as const, Section: KnowledgeSection };
