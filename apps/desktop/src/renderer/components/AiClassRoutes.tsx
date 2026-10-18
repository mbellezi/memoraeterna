import { useEffect, useId, useRef, useState } from "react";
import { Check, Cloud, Cpu, LoaderCircle, TestTubeDiagonal, TriangleAlert } from "lucide-react";
import {
  aiClassIds,
  supportsTask,
  type AiClassId,
  type AiPresetId,
  type AiPresetMode,
  type NoteDeciderMode
} from "@app/domain";
import type { LanguageCode, MessageKey } from "@app/i18n";

import type {
  AiApplyPresetResult,
  AiClassRouteTarget,
  AiClassRoutes,
  AiClassTest,
  AiProfile
} from "../../shared/ipc";
import { DecisionsDeciderPanel } from "./DecisionsDecider";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import type { ToastTone } from "./ui/toast";

type T = (key: MessageKey) => string;
type RouteName = AiClassRouteTarget;

const routeOrder: readonly RouteName[] = [...aiClassIds, "judge"];
const deciderModes: readonly NoteDeciderMode[] = ["ranker", "ranker-else-generative", "generative"];

const selectClass =
  "h-9 min-w-0 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground";

/** Message keys of the localized parts that depend on a class, a mode or a test state. */
const classKeys: Record<AiClassId, { name: MessageKey; description: MessageKey }> = {
  embed: {
    name: "settings.ai.classes.classes.embed.name",
    description: "settings.ai.classes.classes.embed.description"
  },
  decide: {
    name: "settings.ai.classes.classes.decide.name",
    description: "settings.ai.classes.classes.decide.description"
  },
  "write-fast": {
    name: "settings.ai.classes.classes.writeFast.name",
    description: "settings.ai.classes.classes.writeFast.description"
  },
  "write-quality": {
    name: "settings.ai.classes.classes.writeQuality.name",
    description: "settings.ai.classes.classes.writeQuality.description"
  },
  answer: {
    name: "settings.ai.classes.classes.answer.name",
    description: "settings.ai.classes.classes.answer.description"
  }
};
const modeKeys: Record<AiPresetMode, MessageKey> = {
  local: "settings.ai.classes.setup.local",
  hybrid: "settings.ai.classes.setup.hybrid",
  cloud: "settings.ai.classes.setup.cloud",
  custom: "settings.ai.classes.setup.custom"
};
const modeHintKeys: Record<AiPresetMode, MessageKey> = {
  local: "settings.ai.classes.setup.localHint",
  hybrid: "settings.ai.classes.setup.hybridHint",
  cloud: "settings.ai.classes.setup.cloudHint",
  custom: "settings.ai.classes.setup.customHint"
};
const deciderKeys: Record<NoteDeciderMode, { label: MessageKey; help: MessageKey }> = {
  ranker: {
    label: "settings.ai.classes.decider.ranker",
    help: "settings.ai.classes.decider.rankerHelp"
  },
  "ranker-else-generative": {
    label: "settings.ai.classes.decider.rankerElse",
    help: "settings.ai.classes.decider.rankerElseHelp"
  },
  generative: {
    label: "settings.ai.classes.decider.generative",
    help: "settings.ai.classes.decider.generativeHelp"
  }
};

/** Whether a profile can be offered for a route; the main process checks the choice again. */
export function profileOffered(profile: AiProfile, route: RouteName): boolean {
  if (profile.status !== "active" || !profile.modelId) return false;
  const generates = profile.capabilities.some((capability) =>
    ["text-generation", "structured-output", "summarization", "embedding"].includes(capability)
  );
  const generative =
    profile.providerConfigId !== null || (profile.localModelId !== null && generates);
  if (route === "embed") return supportsTask("embedding", profile.capabilities);
  if (route === "decide")
    return (
      profile.localModelId !== null && !generative && profile.capabilities.includes("reranking")
    );
  if (route === "judge") return generative && supportsTask("reranking", profile.capabilities);
  return supportsTask("structured-output", profile.capabilities);
}

/** The text of a stored test error: a localized key when the message catalog has it, else as is. */
export function testErrorText(t: T, error: string): string {
  if (/^[a-z][A-Za-z]*(\.[A-Za-z0-9_-]+)+$/u.test(error)) {
    const text = t(error as MessageKey);
    if (!text.startsWith("[[missing:")) return text;
  }
  return error;
}

export interface AiClassRoutesViewProps {
  t: T;
  routes: AiClassRoutes;
  profiles: readonly AiProfile[];
  /** The route being tested or changed, `preset` while a setup is applied. */
  busy: RouteName | "preset" | null;
  /** A setup the person asked for and has not confirmed. */
  pendingSetup: AiPresetId | null;
  /** A remote judge profile the person chose and has not confirmed (disclosure first). */
  pendingJudge: string | null;
  blocked: AiApplyPresetResult["blocked"];
  blockedSetup: AiPresetId | null;
  status: string;
  onSelectSetup: (mode: AiPresetMode) => void;
  onConfirmSetup: () => void;
  onCancelSetup: () => void;
  onTest: (route: RouteName) => void;
  onChooseProfile: (route: RouteName, profileId: string) => void;
  onConfirmJudge: () => void;
  onCancelJudge: () => void;
  onChooseDecider: (mode: NoteDeciderMode | null) => void;
}

/** The mode select, the five class rows and the generative judge row (D34, R21). */
export function AiClassRoutesView(props: AiClassRoutesViewProps) {
  const { t, routes, profiles, busy, pendingSetup, blocked, status } = props;
  const setupId = useId();
  const custom = routes.preset === "custom";
  const pendingJudgeProfile = props.pendingJudge
    ? profiles.find((profile) => profile.id === props.pendingJudge)
    : undefined;
  return (
    <div className="grid gap-5">
      <div className="grid gap-2">
        <h3 className="font-medium">{t("settings.ai.classes.title")}</h3>
        <p className="text-sm text-secondary-foreground">{t("settings.ai.classes.description")}</p>
      </div>

      <div className="grid gap-1 md:max-w-sm">
        <Label htmlFor={setupId}>{t("settings.ai.classes.setup.label")}</Label>
        <select
          id={setupId}
          className={selectClass}
          value={routes.preset ?? ""}
          disabled={busy !== null}
          aria-describedby={`${setupId}-hint`}
          onChange={(event) => props.onSelectSetup(event.target.value as AiPresetMode)}
        >
          {routes.preset === null ? (
            <option value="" disabled>
              {t("settings.ai.classes.setup.unset")}
            </option>
          ) : null}
          {routes.presets.map((preset) => (
            <option key={preset.id} value={preset.id} disabled={!preset.available}>
              {t(modeKeys[preset.id])}
            </option>
          ))}
          <option value="custom">{t(modeKeys.custom)}</option>
        </select>
        <p id={`${setupId}-hint`} className="text-xs text-muted-foreground">
          {routes.preset
            ? t(modeHintKeys[routes.preset])
            : routes.presets.some((preset) => !preset.available)
              ? t("settings.ai.classes.setup.localUnavailable")
              : t("settings.ai.classes.setup.unsetHint")}
        </p>
      </div>

      {pendingSetup ? (
        <SetupConfirmation
          t={t}
          setup={pendingSetup}
          busy={busy !== null}
          onConfirm={props.onConfirmSetup}
          onCancel={props.onCancelSetup}
        />
      ) : null}

      {blocked.length > 0 && props.blockedSetup ? (
        <div
          role="alert"
          className="grid gap-1 rounded-lg border border-warning bg-warning-soft p-3 text-sm text-foreground"
        >
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" aria-hidden="true" />
            {t("settings.ai.classes.blocked.title").replace(
              "{setup}",
              t(modeKeys[props.blockedSetup])
            )}
          </p>
          <ul className="grid gap-1 pl-6">
            {blocked.map((entry, index) => (
              <li key={`${entry.route ?? "all"}-${index}`} className="list-disc">
                {t(blockedKey(entry.reason))
                  .replace(
                    "{name}",
                    entry.route === null
                      ? ""
                      : entry.route === "judge"
                        ? t("settings.ai.classes.judge.title")
                        : t(classKeys[entry.route].name)
                  )
                  .replace("{model}", entry.modelName ?? "")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p role="status" aria-live="polite" className="min-h-5 text-sm text-secondary-foreground">
        {status}
      </p>

      <ul className="grid gap-3">
        {routeOrder.map((route) => (
          <li key={route}>
            {route === "judge" ? (
              <JudgeRow {...props} custom={custom} pendingJudgeProfile={pendingJudgeProfile} />
            ) : (
              <ClassRow {...props} route={route} custom={custom} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function blockedKey(reason: AiApplyPresetResult["blocked"][number]["reason"]): MessageKey {
  return reason === "model_missing"
    ? "settings.ai.classes.blocked.modelMissing"
    : reason === "no_remote_profile"
      ? "settings.ai.classes.blocked.noRemoteProfile"
      : "settings.ai.classes.blocked.localRequiresAppleSilicon";
}

function SetupConfirmation({
  t,
  setup,
  busy,
  onConfirm,
  onCancel
}: {
  t: T;
  setup: AiPresetId;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
      className="grid gap-2 rounded-lg border border-border-strong bg-soft p-3 text-sm"
    >
      <p id={headingId} className="font-medium">
        {t("settings.ai.classes.confirm.title").replace("{setup}", t(modeKeys[setup]))}
      </p>
      <p className="text-secondary-foreground">{t(modeHintKeys[setup])}</p>
      <p className="text-secondary-foreground">{t("settings.ai.classes.confirm.body")}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" disabled={busy} onClick={onConfirm}>
          {t("settings.ai.classes.confirm.apply")}
        </Button>
        <Button type="button" disabled={busy} onClick={onCancel}>
          {t("settings.ai.classes.confirm.cancel")}
        </Button>
      </div>
    </div>
  );
}

function TestState({
  t,
  test,
  route,
  busy
}: {
  t: T;
  test: AiClassTest;
  route: RouteName;
  busy: boolean;
}) {
  if (busy)
    return (
      <span className="inline-flex items-center gap-1 text-xs text-secondary-foreground">
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
        {t("settings.ai.classes.test.running")}
      </span>
    );
  if (test.state === "passed")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
        <Check className="size-3.5" aria-hidden="true" />
        {test.ms === null
          ? t("settings.ai.classes.test.passed")
          : t("settings.ai.classes.test.passedIn").replace("{ms}", String(test.ms))}
      </span>
    );
  if (test.state === "failed")
    return (
      <span className="inline-flex items-start gap-1 text-xs font-medium text-danger" role="alert">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {test.error
            ? t("settings.ai.classes.test.failedWith").replace(
                "{reason}",
                testErrorText(t, test.error)
              )
            : t("settings.ai.classes.test.failed")}
        </span>
      </span>
    );
  return (
    <span className="text-xs text-muted-foreground">
      {test.state === "none" && route === "decide"
        ? t("settings.ai.classes.test.none")
        : t("settings.ai.classes.test.untested")}
    </span>
  );
}

function ModelTag({ t, remote }: { t: T; remote: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-soft px-1.5 py-0.5 text-xs text-secondary-foreground">
      {remote ? (
        <Cloud className="size-3" aria-hidden="true" />
      ) : (
        <Cpu className="size-3" aria-hidden="true" />
      )}
      {remote ? t("settings.ai.classes.model.remote") : t("settings.ai.classes.model.local")}
    </span>
  );
}

function ProfileSelect({
  t,
  id,
  route,
  profiles,
  value,
  disabled,
  onChoose
}: {
  t: T;
  id: string;
  route: RouteName;
  profiles: readonly AiProfile[];
  value: string | null;
  disabled: boolean;
  onChoose: (profileId: string) => void;
}) {
  const options = profiles.filter((profile) => profileOffered(profile, route));
  return (
    <select
      id={id}
      className={selectClass}
      value={value ?? ""}
      disabled={disabled || options.length === 0}
      onChange={(event) => event.target.value && onChoose(event.target.value)}
    >
      <option value="" disabled>
        {t("settings.ai.classes.model.choose")}
      </option>
      {options.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.name}
        </option>
      ))}
    </select>
  );
}

function ClassRow(props: AiClassRoutesViewProps & { route: AiClassId; custom: boolean }) {
  const { t, route, routes, busy, custom } = props;
  const entry = routes.classes.find((candidate) => candidate.id === route);
  const selectId = useId();
  if (!entry) return null;
  const working = busy === route;
  return (
    <section
      aria-label={t(classKeys[route].name)}
      className="grid gap-2 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">{t(classKeys[route].name)}</h4>
          <p className="text-xs text-muted-foreground">{t(classKeys[route].description)}</p>
        </div>
        <div className="flex items-center gap-2">
          <TestState t={t} test={entry.test} route={route} busy={working} />
          <Button
            type="button"
            disabled={busy !== null || entry.profileId === null}
            onClick={() => props.onTest(route)}
          >
            <TestTubeDiagonal aria-hidden="true" />
            {t("settings.ai.classes.test.button")}
            <span className="sr-only"> {t(classKeys[route].name)}</span>
          </Button>
        </div>
      </div>
      {custom ? (
        <div className="grid gap-1 md:max-w-sm">
          <Label htmlFor={selectId}>{t("settings.ai.classes.model.label")}</Label>
          <ProfileSelect
            t={t}
            id={selectId}
            route={route}
            profiles={props.profiles}
            value={entry.profileId}
            disabled={busy !== null}
            onChoose={(profileId) => props.onChooseProfile(route, profileId)}
          />
        </div>
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          {entry.modelId ? (
            <>
              <span className="min-w-0 break-words font-medium">{entry.modelId}</span>
              <ModelTag t={t} remote={entry.remote} />
            </>
          ) : (
            <span className="text-secondary-foreground">
              {route === "decide"
                ? t("settings.ai.classes.model.noRanker")
                : t("settings.ai.classes.model.none")}
            </span>
          )}
        </p>
      )}
    </section>
  );
}

function JudgeRow(
  props: AiClassRoutesViewProps & {
    custom: boolean;
    pendingJudgeProfile: AiProfile | undefined;
  }
) {
  const { t, routes, busy, pendingJudgeProfile } = props;
  const judge = routes.judge;
  const selectId = useId();
  const modeId = useId();
  const working = busy === "judge";
  const provider = pendingJudgeProfile
    ? pendingJudgeProfile.name
    : (judge.providerName ?? judge.profileName ?? "");
  const disclose = pendingJudgeProfile ? true : judge.remote;
  return (
    <section
      aria-label={t("settings.ai.classes.judge.title")}
      className="grid gap-3 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-sm font-medium">{t("settings.ai.classes.judge.title")}</h4>
          <p className="text-xs text-muted-foreground">
            {t("settings.ai.classes.judge.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <TestState t={t} test={judge.test} route="judge" busy={working} />
          <Button
            type="button"
            disabled={busy !== null || judge.profileId === null}
            onClick={() => props.onTest("judge")}
          >
            <TestTubeDiagonal aria-hidden="true" />
            {t("settings.ai.classes.test.button")}
            <span className="sr-only"> {t("settings.ai.classes.judge.title")}</span>
          </Button>
        </div>
      </div>

      <div className="grid gap-1 md:max-w-sm">
        <Label htmlFor={selectId}>{t("settings.ai.classes.judge.model")}</Label>
        <ProfileSelect
          t={t}
          id={selectId}
          route="judge"
          profiles={props.profiles}
          value={pendingJudgeProfile?.id ?? judge.profileId}
          disabled={busy !== null}
          onChoose={(profileId) => props.onChooseProfile("judge", profileId)}
        />
        {judge.profileId === null ? (
          <p className="text-xs text-secondary-foreground">{t("settings.ai.classes.judge.none")}</p>
        ) : (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ModelTag t={t} remote={judge.remote} />
            {judge.modelId}
            {!judge.routed ? <span>{t("settings.ai.classes.judge.partial")}</span> : null}
          </p>
        )}
      </div>

      {disclose ? (
        <div
          role="note"
          className="grid gap-1 rounded-lg border border-border-strong bg-soft p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <Cloud className="size-4 shrink-0" aria-hidden="true" />
            {t("settings.ai.classes.disclosure.title").replace("{provider}", provider)}
          </p>
          <p className="text-secondary-foreground">
            {t("settings.ai.classes.disclosure.body").replaceAll("{provider}", provider)}
          </p>
          {pendingJudgeProfile ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="primary" onClick={props.onConfirmJudge}>
                {t("settings.ai.classes.disclosure.confirm")}
              </Button>
              <Button type="button" onClick={props.onCancelJudge}>
                {t("settings.ai.classes.confirm.cancel")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-1 md:max-w-sm">
        <Label htmlFor={modeId}>{t("settings.ai.classes.decider.label")}</Label>
        <select
          id={modeId}
          className={selectClass}
          value={judge.deciderMode ?? ""}
          disabled={busy !== null}
          aria-describedby={`${modeId}-help`}
          onChange={(event) =>
            props.onChooseDecider((event.target.value || null) as NoteDeciderMode | null)
          }
        >
          <option value="">{t("settings.ai.classes.decider.automatic")}</option>
          {deciderModes.map((mode) => (
            <option key={mode} value={mode}>
              {t(deciderKeys[mode].label)}
            </option>
          ))}
        </select>
      </div>
      <ul id={`${modeId}-help`} className="grid gap-1 text-xs text-muted-foreground">
        <li className={judge.deciderMode === null ? "font-medium text-secondary-foreground" : ""}>
          {t("settings.ai.classes.decider.automatic")}:{" "}
          {t("settings.ai.classes.decider.automaticHelp")}
        </li>
        {deciderModes.map((mode) => (
          <li
            key={mode}
            className={judge.deciderMode === mode ? "font-medium text-secondary-foreground" : ""}
          >
            {t(deciderKeys[mode].label)}: {t(deciderKeys[mode].help)}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ClassRoutesLoading({ t }: { t: T }) {
  return (
    <p role="status" className="flex items-center gap-2 text-sm text-secondary-foreground">
      <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
      {t("settings.ai.classes.states.loading")}
    </p>
  );
}

export function ClassRoutesError({ t, onRetry }: { t: T; onRetry: () => void }) {
  return (
    <div role="alert" className="grid gap-2 text-sm">
      <p className="text-danger">{t("settings.ai.classes.states.error")}</p>
      <Button type="button" className="w-fit" onClick={onRetry}>
        {t("settings.ai.classes.states.retry")}
      </Button>
    </div>
  );
}

export function ClassRoutesEmpty({ t }: { t: T }) {
  return (
    <p className="text-sm text-secondary-foreground">{t("settings.ai.classes.states.empty")}</p>
  );
}

// --- The container ------------------------------------------------------------------------

type LoadState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; routes: AiClassRoutes; profiles: AiProfile[] };

/** The routes and the profiles to choose from, or the error state when either cannot be read. */
async function readState(): Promise<LoadState> {
  try {
    const [routes, profiles] = await Promise.all([
      window.app.ai.classRoutes(),
      window.app.ai.listProfiles()
    ]);
    return { phase: "ready", routes, profiles };
  } catch {
    return { phase: "error" };
  }
}

export interface AiClassRoutesPanelProps {
  t: T;
  /** The interface language, passed to the cards that write money. */
  interfaceLanguage?: LanguageCode;
  onToast?: (message: MessageKey, tone: ToastTone) => void;
}

/** Settings › AI: loads the routes and runs the setups, tests and choices of the view above. */
export function AiClassRoutesPanel({
  t,
  interfaceLanguage = "en",
  onToast = () => undefined
}: AiClassRoutesPanelProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState<RouteName | "preset" | null>(null);
  const [pendingSetup, setPendingSetup] = useState<AiPresetId | null>(null);
  const [pendingJudge, setPendingJudge] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<AiApplyPresetResult["blocked"]>([]);
  const [blockedSetup, setBlockedSetup] = useState<AiPresetId | null>(null);
  const [status, setStatus] = useState("");
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    void readState().then((next) => {
      if (active) setState(next);
    });
    return () => {
      active = false;
    };
  }, [reloads]);

  const replace = (routes: AiClassRoutes) =>
    setState((current) => (current.phase === "ready" ? { ...current, routes } : current));

  async function guarded<R>(route: RouteName | "preset", action: () => Promise<R>) {
    setBusy(route);
    try {
      return await action();
    } catch (error) {
      const key =
        error instanceof Error ? error.message.match(/errors\.[a-zA-Z0-9_.-]+/)?.[0] : null;
      onToast((key as MessageKey | undefined) ?? "errors.common.unknown", "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function testRoute(route: RouteName, announce = true) {
    if (announce) setStatus("");
    const routes = await guarded(route, () => window.app.ai.testClassRoute(route));
    if (routes) replace(routes);
  }

  async function applySetup() {
    const setup = pendingSetup;
    if (!setup) return;
    setPendingSetup(null);
    setBlocked([]);
    setBlockedSetup(null);
    setStatus(t("settings.ai.classes.status.applying").replace("{setup}", t(modeKeys[setup])));
    const result = await guarded("preset", () =>
      window.app.ai.applyPreset({ preset: setup, test: false })
    );
    if (!result) return;
    replace(result.view);
    if (!result.applied) {
      setBlocked(result.blocked);
      setBlockedSetup(setup);
      setStatus("");
      return;
    }
    // The tests run one by one so each class shows its own state as soon as it is known.
    for (const route of routeOrder) {
      setStatus(
        t("settings.ai.classes.status.testing").replace(
          "{name}",
          route === "judge" ? t("settings.ai.classes.judge.title") : t(classKeys[route].name)
        )
      );
      await testRoute(route, false);
    }
    setStatus(t("settings.ai.classes.status.applied").replace("{setup}", t(modeKeys[setup])));
  }

  if (state.phase === "loading") return <ClassRoutesLoading t={t} />;
  if (state.phase === "error")
    return (
      <ClassRoutesError
        t={t}
        onRetry={() => {
          setState({ phase: "loading" });
          setReloads((count) => count + 1);
        }}
      />
    );

  const { routes, profiles } = state;
  const noModels =
    profiles.length === 0 && routes.classes.every((entry) => entry.profileId === null);
  return (
    <div className="grid gap-4">
      {noModels ? <ClassRoutesEmpty t={t} /> : null}
      <AiClassRoutesView
        t={t}
        routes={routes}
        profiles={profiles}
        busy={busy}
        pendingSetup={pendingSetup}
        pendingJudge={pendingJudge}
        blocked={blocked}
        blockedSetup={blockedSetup}
        status={status}
        onSelectSetup={(mode) => {
          setBlocked([]);
          setBlockedSetup(null);
          if (mode === "custom") {
            setPendingSetup(null);
            void guarded("preset", () => window.app.ai.applyPreset({ preset: "custom" })).then(
              (result) => result && replace(result.view)
            );
          } else setPendingSetup(mode);
        }}
        onConfirmSetup={() => void applySetup()}
        onCancelSetup={() => setPendingSetup(null)}
        onTest={(route) => void testRoute(route)}
        onChooseProfile={(route, profileId) => {
          const profile = profiles.find((candidate) => candidate.id === profileId);
          // Choosing a remote model for the judge discloses what it receives before it applies.
          if (route === "judge" && profile?.providerConfigId) {
            setPendingJudge(profileId);
            return;
          }
          void guarded(route, () => window.app.ai.setClassRoute({ route, profileId })).then(
            (next) => next && replace(next)
          );
        }}
        onConfirmJudge={() => {
          const profileId = pendingJudge;
          setPendingJudge(null);
          if (profileId)
            void guarded("judge", () =>
              window.app.ai.setClassRoute({ route: "judge", profileId })
            ).then((next) => next && replace(next));
        }}
        onCancelJudge={() => setPendingJudge(null)}
        onChooseDecider={(mode) =>
          void guarded("judge", () => window.app.ai.setDeciderMode(mode)).then(
            (next) => next && replace(next)
          )
        }
      />
      <DecisionsDeciderPanel
        t={t}
        interfaceLanguage={interfaceLanguage}
        preset={routes.preset}
        onToast={onToast}
      />
    </div>
  );
}
