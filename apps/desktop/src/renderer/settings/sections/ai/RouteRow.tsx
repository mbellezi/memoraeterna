import { useId } from "react";
import { CloudUpload } from "lucide-react";
import type { Translator } from "@app/i18n";

import type { AiClassRoutes, AiProfile } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { InlineAction } from "../../InlineAction";
import { SettingRow } from "../../SettingRow";
import type { AiSnapshot } from "./ai-controller";
import { routeOfEntryId, routeView, testLine, type RouteView } from "./ai-model";
import { NativeSelect, StatusLine } from "./ai-parts";
import { useRowProps } from "./ai-rows";

/**
 * One job's model (a class route or the generative judge): a select of the profiles that can serve
 * it, the result of its last test and "Test". Choosing writes the route at once (and the setup
 * becomes Custom, which the intro of the group says); a provider's model for the judge discloses
 * first what that provider receives. A select with nothing to choose from says why.
 */
export function RouteRow({
  entry,
  routes,
  profiles,
  waiting,
  snapshot,
  onChoose,
  onTest,
  onConfirmJudge,
  onCancelJudge
}: {
  entry: SettingEntryV2;
  /** Null until the routes are read: the row shows a bar where its select will be. */
  routes: AiClassRoutes | null;
  profiles: readonly AiProfile[];
  waiting: boolean;
  snapshot: Pick<AiSnapshot, "pendingJudge" | "testing" | "writing">;
  onChoose: (profileId: string) => void;
  onTest: () => void;
  onConfirmJudge: () => void;
  onCancelJudge: () => void;
}) {
  const route = routeOfEntryId(entry.id);
  const row = useRowProps(entry);
  const { t } = row;
  const selectId = useId();
  if (!route) return null;
  if (!routes)
    return (
      <SettingRow
        {...row}
        control={
          waiting ? <Skeleton className="h-8 w-[18.5rem] max-w-full rounded-md" /> : undefined
        }
      />
    );
  const view = routeView(routes, profiles, route);
  const testing = snapshot.testing.includes(route);
  const busy = snapshot.writing || snapshot.testing.length > 0;
  const pending =
    route === "judge" ? profiles.find((p) => p.id === snapshot.pendingJudge) : undefined;
  const defaultId = typeof row.description?.default === "string" ? row.description.default : null;
  const defaultName = defaultId ? profiles.find((p) => p.id === defaultId)?.name : undefined;

  return (
    <SettingRow
      {...row}
      defaultLabel={defaultName}
      defaultVaries={defaultName === undefined && row.description?.default === null}
      control={
        <ProfileSelect
          t={t}
          id={selectId}
          label={row.label}
          view={view}
          profiles={profiles}
          value={pending?.id ?? view.profileId}
          disabled={busy}
          onChoose={onChoose}
        />
      }
      note={
        <div className="grid gap-1.5">
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <TestStatus t={t} view={view} testing={testing} />
            <InlineAction
              size="xs"
              disabled={busy || view.profileId === null}
              aria-label={`${t("settingsAi.test.button")}: ${row.label}`}
              onClick={onTest}
            >
              {t("settingsAi.test.button")}
            </InlineAction>
            {view.modelId ? (
              <span className="text-muted-foreground">
                {view.remote
                  ? t("settingsAi.routes.where.remote")
                  : t("settingsAi.routes.where.local")}
              </span>
            ) : null}
          </span>
          {route === "decide" && view.profileId === null ? (
            <span className="text-muted-foreground [text-wrap:pretty]">
              {t("settingsAi.routes.noRanker")}
            </span>
          ) : null}
          {view.options.length === 0 && view.profileId === null && route !== "decide" ? (
            <span className="text-muted-foreground [text-wrap:pretty]">
              {t("settingsAi.routes.noModelsAvailable")}
            </span>
          ) : null}
          {route === "judge" && view.profileId !== null && !routes.judge.routed ? (
            <span className="text-muted-foreground [text-wrap:pretty]">
              {t("settingsAi.routes.partial")}
            </span>
          ) : null}
          {route === "judge" ? (
            <Disclosure
              t={t}
              provider={
                pending?.name ?? routes.judge.providerName ?? routes.judge.profileName ?? ""
              }
              show={pending !== undefined || routes.judge.remote}
              asking={pending !== undefined}
              onConfirm={onConfirmJudge}
              onCancel={onCancelJudge}
            />
          ) : null}
        </div>
      }
    />
  );
}

function ProfileSelect({
  t,
  id,
  label,
  view,
  profiles,
  value,
  disabled,
  onChoose
}: {
  t: Translator;
  id: string;
  label: string;
  view: RouteView;
  profiles: readonly AiProfile[];
  value: string | null;
  disabled: boolean;
  onChoose: (profileId: string) => void;
}) {
  // The profile the route points at stays in the list even when it could not be chosen now.
  const current = value ? profiles.find((profile) => profile.id === value) : undefined;
  const options =
    current && !view.options.some((option) => option.id === current.id)
      ? [current, ...view.options]
      : view.options;
  return (
    <NativeSelect
      id={id}
      aria-label={label}
      wrapperClassName="w-[18.5rem]"
      value={value ?? ""}
      disabled={disabled || options.length === 0}
      onChange={(event) => event.target.value && onChoose(event.target.value)}
    >
      <option value="" disabled>
        {options.length === 0 ? t("settingsAi.routes.noModel") : t("settingsAi.routes.choose")}
      </option>
      {options.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.name}
        </option>
      ))}
    </NativeSelect>
  );
}

function TestStatus({ t, view, testing }: { t: Translator; view: RouteView; testing: boolean }) {
  if (testing)
    return (
      <StatusLine tone="working" live>
        {t("settingsAi.test.running")}
      </StatusLine>
    );
  const line = testLine(t, view.test, view.route);
  return (
    <StatusLine tone={line.kind === "ok" ? "ok" : line.kind === "failed" ? "warn" : "idle"} live>
      {line.text}
    </StatusLine>
  );
}

/** What a provider receives when it judges: said while a provider's model is chosen or in use. */
function Disclosure({
  t,
  provider,
  show,
  asking,
  onConfirm,
  onCancel
}: {
  t: Translator;
  provider: string;
  show: boolean;
  asking: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!show) return null;
  if (!asking)
    return (
      <StatusLine
        tone="idle"
        icon={<CloudUpload aria-hidden="true" className="size-3.5 text-secondary-foreground" />}
      >
        {t("settingsAi.routes.disclosure.title", { values: { provider } })}
      </StatusLine>
    );
  return (
    <div
      role="note"
      className="grid gap-1.5 rounded-lg border border-border-strong bg-soft px-3 py-2 text-secondary-foreground"
    >
      <p className="m-0 font-semibold text-foreground">
        {t("settingsAi.routes.disclosure.title", { values: { provider } })}
      </p>
      <p className="m-0 [text-wrap:pretty]">
        {t("settingsAi.routes.disclosure.body", { values: { provider } })}
      </p>
      {asking ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button variant="primary" onClick={onConfirm}>
            {t("settingsAi.routes.disclosure.confirm")}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {t("shell.actions.cancel")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
