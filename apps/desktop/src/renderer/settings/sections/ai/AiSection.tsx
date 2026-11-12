import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { CircleDollarSign } from "lucide-react";
import type { Translator } from "@app/i18n";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { ErrorState } from "../../../components/ui/error-state";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { ReadOnlyValue, RegistryRow, SettingRow } from "../../SettingRow";
import type { SettingsSectionModule } from "../../sections-registry";
import { useSettings } from "../../settings-context";
import { groupLabelOf, groupsOf } from "../../settings-model";
import { settingsStoreOf } from "../../settings-store";
import { requestSettingsTarget } from "../../settings-target";
import { AiSettingsController, type AiSnapshot, type Load } from "./ai-controller";
import {
  formatUsd,
  modelsSummary,
  profilesSummary,
  providerOfEntryId,
  routeOfEntryId,
  routesAreEmpty,
  setupCards,
  setupNameKeys
} from "./ai-model";
import { AreaNotice, ExpandButton, GroupHeading, GroupIntro } from "./ai-parts";
import { useRowProps } from "./ai-rows";
import { CredentialRow } from "./CredentialRow";
import { DecisionsRow } from "./DecisionsRow";
import { LocalModelsPage } from "./LocalModelsPage";
import { PresetChoice } from "./PresetChoice";
import { ProfilesPage } from "./ProfilesPage";
import { ProviderRow } from "./ProviderRow";
import { RouteRow } from "./RouteRow";
import { ThisMacBlock } from "./ThisMacBlock";

/**
 * Settings › AI (design record §7.6, docs/f5-decisions.md D17): the setup first, then the providers,
 * what this Mac can run, the model of each job, the local models and profiles, and the opt-in
 * decider. Its rows are the registry's rows for the section, in the registry's order, each with the
 * label, help, "changed" marker and way back to the default of every row, and the controls here are
 * the AI service's own calls: nothing is written by this file except through `window.app`. The
 * recommendation of This Mac informs and never changes a route (decision 26).
 */
export function AiSection() {
  const settings = useSettings();
  const { t, section } = settings;
  const controller = useMemo(
    () =>
      new AiSettingsController(() => window.app, {
        refreshMarkers: () => settingsStoreOf(window.app).load()
      }),
    []
  );
  useEffect(() => controller.retain(), [controller]);
  const snap = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  const notice = (area: keyof AiSnapshot["notices"]) =>
    snap.notices[area] ? t(snap.notices[area]!) : undefined;
  // Every row is there from the first paint, with its label and help; what is not read yet is a bar in
  // the place of its control, so the layout holds and a link to a row finds it at once.
  const core = snap.core.status === "ready" ? snap.core.value : null;
  const waiting = snap.core.status === "loading";
  const hardware = snap.hardware.status === "ready" ? snap.hardware.value : null;

  const render = (entry: SettingEntryV2): ReactNode => {
    if (entry.id === "ai.preset.v1")
      return (
        <>
          <PresetRow
            entry={entry}
            cards={core ? setupCards(core.routes, hardware) : null}
            unset={core !== null && core.routes.preset === null}
            waiting={waiting}
            hardware={hardware}
            snap={snap}
            controller={controller}
            notice={notice("setup")}
          />
          <CapLink t={t} snap={snap} />
        </>
      );
    if (providerOfEntryId(entry.id))
      return (
        <ProviderRow
          entry={entry}
          configs={core?.providers ?? null}
          waiting={waiting}
          controller={controller}
          notice={notice("providers")}
        />
      );
    if (entry.id === "ai.thisMac")
      return (
        <ThisMacBlock
          t={t}
          id={entry.id}
          heading={`settings-group-${section}-${entry.group}`}
          highlighted={settings.highlighted === entry.id}
          load={snap.hardware}
          redetecting={snap.redetecting}
          redetected={snap.redetected}
          notice={notice("hardware")}
          onRetry={() => void controller.loadHardware()}
          onRedetect={() => void controller.redetect()}
        />
      );
    if (routeOfEntryId(entry.id))
      return (
        <RouteRow
          entry={entry}
          routes={core?.routes ?? null}
          profiles={core?.profiles ?? []}
          waiting={waiting}
          snapshot={snap}
          onChoose={(profileId) => controller.chooseProfile(routeOfEntryId(entry.id)!, profileId)}
          onTest={() => void controller.testRoute(routeOfEntryId(entry.id)!)}
          onConfirmJudge={() => controller.confirmJudge()}
          onCancelJudge={() => controller.cancelJudge()}
        />
      );
    if (entry.id === "ai.models")
      return (
        <PageRow
          entry={entry}
          summary={
            snap.models.status === "ready" ? modelsSummary(t, snap.models.value.models) : "…"
          }
          page={(id) => (
            <LocalModelsPage
              t={t}
              id={id}
              load={snap.models}
              controller={controller}
              notice={notice("models")}
              onRetry={() => void controller.loadModels()}
            />
          )}
        />
      );
    if (entry.id === "ai.profiles")
      return (
        <PageRow
          entry={entry}
          summary={core ? profilesSummary(t, core.profiles.length) : "…"}
          page={(id) =>
            core ? (
              <ProfilesPage
                t={t}
                id={id}
                profiles={core.profiles}
                profileTasks={core.profileTasks}
                providers={core.providers}
                localModels={snap.models.status === "ready" ? snap.models.value.models : []}
                controller={controller}
                notice={notice("profiles")}
              />
            ) : null
          }
        />
      );
    if (entry.id === "local-models.repository-token-ref")
      return (
        <HfTokenRow entry={entry} snap={snap} controller={controller} notice={notice("models")} />
      );
    if (entry.id === "relations.decisions")
      return snap.decisions.status === "ready" ? (
        <DecisionsRow
          entry={entry}
          status={snap.decisions.value}
          asking={snap.decisionsAsking}
          busy={snap.decisionsBusy}
          note={snap.decisionsNote ? t(snap.decisionsNote) : null}
          notice={notice("decisions")}
          onToggle={() =>
            snap.decisions.status === "ready" && snap.decisions.value.enabled
              ? void controller.decisionsAction(
                  (ai) => ai.setDecisionsEnabled(false),
                  "settingsAi.decisions.turnedOff"
                )
              : controller.askEnableDecisions()
          }
          onConfirm={() =>
            void controller.decisionsAction(
              (ai) => ai.setDecisionsEnabled(true),
              "settingsAi.decisions.turnedOn"
            )
          }
          onCancel={() => controller.cancelEnableDecisions()}
        />
      ) : (
        <DecisionsPending
          entry={entry}
          load={snap.decisions}
          onRetry={() => void controller.loadDecisions()}
        />
      );
    if (entry.id === "ai:decisions-openai-platform")
      return (
        <DecisionsKeyRow
          entry={entry}
          snap={snap}
          controller={controller}
          notice={notice("decisions")}
        />
      );
    return <RegistryRow entry={entry} control={<ReadOnlyValue entry={entry} />} />;
  };

  const intros: Record<string, ReactNode> = {
    routes: (
      <>
        <GroupIntro>
          {core && routesAreEmpty(core.routes)
            ? t("settingsAi.routes.empty")
            : core?.routes.preset === "custom"
              ? t("settingsAi.routes.introCustom")
              : t("settingsAi.routes.intro")}
        </GroupIntro>
        <AreaNotice message={notice("routes")} className="mt-2" />
      </>
    ),
    thisMac: <GroupIntro>{t("settingsAi.thisMac.intro")}</GroupIntro>
  };

  return (
    <>
      {snap.core.status === "error" ? (
        <ErrorState
          t={t}
          className="mt-6"
          message={t("settingsAi.states.errorTitle")}
          kept={t("settingsAi.states.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={() => controller.retry()}
        />
      ) : null}
      <p className="m-0 mt-3 text-sm text-secondary-foreground [text-wrap:pretty]">
        {t("settingsAi.intro")}
      </p>
      {groupsOf(section).map(({ group, entries }, index) => (
        <section key={group} aria-labelledby={`settings-group-${section}-${group}`}>
          <GroupHeading id={`settings-group-${section}-${group}`} first={index === 0}>
            {groupLabelOf(t, section, group)}
          </GroupHeading>
          {intros[group] ?? null}
          <div>
            {entries.map((entry) => (
              <div key={entry.id}>{render(entry)}</div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** The registry's id of this section's body, for the surface to find it by file. */
export const section: SettingsSectionModule = {
  id: "ai",
  Section: AiSection,
  Skeleton: AiSkeleton
};

/**
 * The bars of the section while its values are read, in the shape of what arrives: a group title, the
 * row of four setup cards, the spending-limit line and the first rows of the providers.
 */
function AiSkeleton() {
  return (
    <>
      <Skeleton className="mt-8 h-3 w-28" />
      <Skeleton className="mt-4 h-3.5 w-36" />
      <Skeleton className="mt-2 h-3 w-80 max-w-full" />
      <SetupCardsSkeleton className="mt-4" />
      <div className="flex items-center gap-4 border-b border-border py-4">
        <Skeleton className="size-4 rounded-full" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-3.5 w-64 max-w-full" />
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
        <Skeleton className="h-8 w-44 rounded-lg" />
      </div>
      <Skeleton className="mt-10 h-3 w-36" />
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border-b border-border py-4">
        <Skeleton className="h-3.5 w-44" />
        <Skeleton className="row-span-2 h-8 w-32 rounded-lg" />
        <Skeleton className="h-3 w-80 max-w-full" />
      </div>
    </>
  );
}

/** Four cards at the height the setup cards take, so nothing moves when they arrive. */
function SetupCardsSkeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "grid w-full grid-cols-[repeat(auto-fit,minmax(9.25rem,1fr))] gap-2",
        className
      )}
    >
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-48 rounded-lg" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PresetRow({
  entry,
  cards,
  unset,
  waiting,
  hardware,
  snap,
  controller,
  notice
}: {
  entry: SettingEntryV2;
  /** Null until the routes are read. */
  cards: ReturnType<typeof setupCards> | null;
  unset: boolean;
  waiting: boolean;
  hardware: Parameters<typeof PresetChoice>[0]["hardware"];
  snap: AiSnapshot;
  controller: AiSettingsController;
  notice: string | undefined;
}) {
  const row = useRowProps(entry);
  const { t } = row;
  const recommended = row.description?.default;
  const defaultName =
    recommended === "local" || recommended === "hybrid" || recommended === "cloud"
      ? t(setupNameKeys[recommended])
      : undefined;
  // Putting the recommended setup back replaces every route, so it asks the way a card does.
  const restore =
    cards !== null &&
    (recommended === "local" || recommended === "hybrid" || recommended === "cloud")
      ? () => controller.selectSetup(recommended)
      : undefined;
  return (
    <SettingRow
      {...row}
      onReset={restore}
      confirmReset={false}
      stack
      defaultLabel={defaultName}
      control={
        cards === null ? (
          waiting ? (
            <SetupCardsSkeleton />
          ) : undefined
        ) : (
          <PresetChoice
            t={t}
            label={row.label}
            cards={cards}
            unset={unset}
            stage={snap.setup}
            hardware={hardware}
            notice={notice}
            onSelect={(id) => controller.selectSetup(id)}
            onConfirm={() => void controller.confirmSetup()}
            onCancel={() => controller.cancelSetup()}
          />
        )
      }
    />
  );
}

/** A line, not a setting: the spending limit lives in Knowledge, and this takes the person there. */
function CapLink({ t, snap }: { t: Translator; snap: AiSnapshot }) {
  const settings = useSettings();
  const cap =
    snap.budget.status === "ready"
      ? snap.budget.value.money.capUsd
      : typeof settings.describe("knowledge.controls.v1.monthlyCapUsd")?.value === "number"
        ? (settings.describe("knowledge.controls.v1.monthlyCapUsd")?.value as number)
        : null;
  if (cap === null) return null;
  const spent = snap.budget.status === "ready" ? snap.budget.value.money.spentUsd : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-4">
      <CircleDollarSign aria-hidden="true" className="size-4 shrink-0 text-secondary-foreground" />
      <div className="min-w-0 flex-1 basis-60">
        <p className="m-0 text-sm font-medium text-foreground">
          {t("settingsAi.cap.label", { values: { amount: formatUsd(t.locale, cap) } })}
        </p>
        <p className="m-0 max-w-[27.5rem] text-xs leading-5 text-secondary-foreground [text-wrap:pretty]">
          {spent !== null
            ? t("settingsAi.cap.spent", { values: { amount: formatUsd(t.locale, spent) } })
            : t("settingsAi.cap.noSpend")}
        </p>
      </div>
      <Button
        onClick={() =>
          requestSettingsTarget({
            section: "knowledge",
            setting: "knowledge.controls.v1.monthlyCapUsd"
          })
        }
      >
        {t("settingsAi.cap.change")}
      </Button>
    </div>
  );
}

/** A row whose page opens in place under it: "2 installed · 1.7 GB" and a chevron. */
function PageRow({
  entry,
  summary,
  page
}: {
  entry: SettingEntryV2;
  summary: string;
  page: (id: string) => ReactNode;
}) {
  const row = useRowProps(entry, { withReset: false });
  const [open, setOpen] = useState(false);
  const pageId = useId();
  // A link or a search result that takes the person to this row opens its page.
  const taken = row.highlighted === true;
  const [seen, setSeen] = useState(false);
  if (taken && !seen) {
    setSeen(true);
    setOpen(true);
  } else if (!taken && seen) setSeen(false);
  return (
    <>
      <SettingRow
        {...row}
        control={
          <ExpandButton
            summary={summary}
            label={row.label}
            expanded={open}
            controls={pageId}
            onToggle={() => setOpen((value) => !value)}
          />
        }
      />
      {open ? page(pageId) : null}
    </>
  );
}

function HfTokenRow({
  entry,
  snap,
  controller,
  notice
}: {
  entry: SettingEntryV2;
  snap: AiSnapshot;
  controller: AiSettingsController;
  notice: string | undefined;
}) {
  const settings = useSettings();
  const { t } = settings;
  const saved =
    settings.describe(entry.id)?.value === true ||
    (snap.models.status === "ready" && snap.models.value.token);
  return (
    <CredentialRow
      entry={entry}
      saved={saved}
      notice={notice}
      labels={{
        none: t("settingsAi.models.token.none"),
        set: t("settingsAi.models.token.set"),
        add: t("settingsAi.models.token.add"),
        replace: t("settingsAi.models.token.replace"),
        field: t("settingsAi.models.token.label")
      }}
      onSave={(secret) =>
        controller.mutate("models", () => controller.app.localModels.setRepositoryToken(secret), {
          models: true
        })
      }
    />
  );
}

function DecisionsKeyRow({
  entry,
  snap,
  controller,
  notice
}: {
  entry: SettingEntryV2;
  snap: AiSnapshot;
  controller: AiSettingsController;
  notice: string | undefined;
}) {
  const settings = useSettings();
  const { t } = settings;
  const status = snap.decisions.status === "ready" ? snap.decisions.value : null;
  const saved = status ? status.keyStored : settings.describe(entry.id)?.value === true;
  return (
    <CredentialRow
      entry={entry}
      saved={saved}
      invalid={status?.keyInvalid === true}
      notice={notice}
      busy={snap.decisionsBusy}
      hint={t("settingsAi.decisions.key.hint")}
      labels={{
        none: t("settingsAi.decisions.key.none"),
        set: t("settingsAi.decisions.key.set"),
        add: t("settingsAi.decisions.key.add"),
        replace: t("settingsAi.decisions.key.replace"),
        field: t("settingsAi.decisions.key.label"),
        invalid: t("settingsAi.decisions.key.invalid"),
        test: t("settingsAi.decisions.key.test"),
        testing: t("settingsAi.decisions.key.testing")
      }}
      onSave={(secret) =>
        controller.decisionsAction(
          (ai) => ai.saveDecisionsKey(secret),
          "settingsAi.decisions.keySaved"
        )
      }
      onTest={async () => {
        const answer = await controller.testDecisionsKey();
        return { ok: answer.ok, text: t(answer.key) };
      }}
    />
  );
}

/** The Decisions switch while its status is read, or when it could not be. */
function DecisionsPending({
  entry,
  load,
  onRetry
}: {
  entry: SettingEntryV2;
  load: Load<unknown>;
  onRetry: () => void;
}) {
  const row = useRowProps(entry, { withReset: false });
  const { t } = row;
  return (
    <SettingRow
      {...row}
      stack={load.status === "error"}
      control={
        load.status === "loading" ? <Skeleton className="h-5 w-9 rounded-full" /> : undefined
      }
      note={
        load.status === "error" ? (
          <ErrorState
            t={t}
            message={t("settingsAi.decisions.errorTitle")}
            retryLabel={t("shell.actions.retry")}
            onRetry={onRetry}
          />
        ) : undefined
      }
    />
  );
}
