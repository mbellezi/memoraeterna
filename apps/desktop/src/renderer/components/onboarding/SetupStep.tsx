import { useId } from "react";
import { Circle, CircleCheck, LoaderCircle, Minus, TriangleAlert } from "lucide-react";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { testErrorText } from "../AiClassRoutes";
import type {
  BlockedView,
  OnboardingController,
  SetupState,
  SetupStepName,
  SetupStepStatus
} from "./onboarding-controller";
import {
  classTestNameKeys,
  classTestStateKeys,
  downloadShare,
  etaMinutes,
  failedTestCount,
  formatSize,
  modelRoleKeys,
  type ClassTestState,
  type DownloadView
} from "./onboarding-model";

export type SetupActions = Pick<OnboardingController, "retrySetup" | "continueToSource">;

const stepNameKeys = {
  writer: "onboarding.setup.steps.writer",
  models: "onboarding.setup.steps.models",
  preset: "onboarding.setup.steps.preset",
  tests: "onboarding.setup.steps.tests"
} as const;

const stepStateKeys = {
  pending: "onboarding.setup.state.pending",
  running: "onboarding.setup.state.running",
  done: "onboarding.setup.state.done",
  failed: "onboarding.setup.state.failed",
  skipped: "onboarding.setup.state.skipped"
} as const;

const downloadStateKeys = {
  waiting: "onboarding.setup.models.waiting",
  downloading: "onboarding.setup.models.downloading",
  verifying: "onboarding.setup.models.verifying",
  ready: "onboarding.setup.models.ready",
  failed: "onboarding.setup.models.failed"
} as const;

const blockedKeys = {
  model_missing: "onboarding.setup.blocked.modelMissing",
  no_remote_profile: "onboarding.setup.blocked.noWriter",
  local_requires_apple_silicon: "onboarding.setup.blocked.localUnavailable"
} as const;

const setupOrder: readonly SetupStepName[] = ["writer", "models", "preset", "tests"];

/** A state is a glyph and a word: colour only adds to them. */
function StepGlyph({ status }: { status: SetupStepStatus | ClassTestState }) {
  const className = "h-4 w-4 shrink-0";
  if (status === "running")
    return (
      <LoaderCircle
        className={`${className} animate-spin motion-reduce:animate-none`}
        aria-hidden="true"
      />
    );
  if (status === "done" || status === "passed")
    return <CircleCheck className={`${className} text-success`} aria-hidden="true" />;
  if (status === "failed")
    return <TriangleAlert className={`${className} text-danger`} aria-hidden="true" />;
  if (status === "skipped" || status === "none")
    return <Minus className={`${className} text-muted-foreground`} aria-hidden="true" />;
  return <Circle className={`${className} text-muted-foreground`} aria-hidden="true" />;
}

export interface SetupStepProps {
  t: Translator;
  setup: SetupState;
  actions: SetupActions;
}

/**
 * Step 2, after the choice: the writer, the models on this computer, the setup applied and one
 * check per part. A failure stays here with a retry and a way on; the ranker installs beside it.
 */
export function SetupStep({ t, setup, actions }: SetupStepProps) {
  const failedCount = failedTestCount(setup.tests);
  return (
    <div className="grid gap-5">
      <p className="text-sm text-secondary-foreground">{t("onboarding.setup.description")}</p>
      <ol className="grid gap-2">
        {setupOrder.map((name) => (
          <li
            key={name}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm"
          >
            <span className="flex items-center gap-2 text-foreground">
              <StepGlyph status={setup.steps[name]} />
              {t(stepNameKeys[name])}
            </span>
            <span className="text-xs text-secondary-foreground">
              {t(stepStateKeys[setup.steps[name]])}
            </span>
          </li>
        ))}
      </ol>
      {setup.downloads.length > 0 ? <Downloads t={t} downloads={setup.downloads} /> : null}
      {setup.steps.tests !== "pending" ? <Checks t={t} setup={setup} /> : null}
      {setup.failure ? (
        <div
          role="alert"
          className="grid gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <p className="font-medium">{t(setup.failure.message.key)}</p>
          {setup.blocked.map((entry) => (
            <p key={`${entry.reason}|${entry.route ?? ""}|${entry.modelName ?? ""}`}>
              {blockedText(t, entry)}
            </p>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-secondary-foreground">
          {setup.status === "done"
            ? failedCount === 0
              ? t("onboarding.setup.summaryOk")
              : failedCount === 1
                ? t("onboarding.setup.summaryProblemsOne")
                : t("onboarding.setup.summaryProblems", { values: { count: failedCount } })
            : null}
        </p>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {setup.status === "failed" ? (
            <>
              <Button type="button" onClick={() => actions.retrySetup()}>
                {t("onboarding.setup.retry")}
              </Button>
              <Button type="button" variant="primary" onClick={() => actions.continueToSource()}>
                {t("onboarding.setup.continueAnyway")}
              </Button>
            </>
          ) : setup.status === "done" ? (
            <Button type="button" variant="primary" onClick={() => actions.continueToSource()}>
              {t("onboarding.continue")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function blockedText(t: Translator, entry: BlockedView): string {
  return t(blockedKeys[entry.reason], {
    values: { model: entry.modelName ?? "" }
  });
}

function Downloads({ t, downloads }: { t: Translator; downloads: readonly DownloadView[] }) {
  const titleId = useId();
  const rankerState = downloads.find((download) => download.role === "ranker")?.state;
  return (
    <section aria-labelledby={titleId} className="grid gap-2">
      <h3 id={titleId} className="text-sm font-medium text-foreground">
        {t("onboarding.setup.models.title")}
      </h3>
      <ul className="grid gap-2">
        {downloads.map((download) => (
          <DownloadRow key={download.catalogId} t={t} download={download} />
        ))}
      </ul>
      {rankerState && rankerState !== "ready" ? (
        <p className="text-xs text-secondary-foreground">
          {t(
            rankerState === "failed"
              ? "onboarding.setup.rankerFailed"
              : "onboarding.setup.rankerWaiting"
          )}
        </p>
      ) : null}
    </section>
  );
}

function DownloadRow({ t, download }: { t: Translator; download: DownloadView }) {
  const share = downloadShare(download);
  const name = t(modelRoleKeys[download.role]);
  const minutes = etaMinutes(download.etaSeconds);
  return (
    <li className="grid gap-1.5 rounded-lg border border-border bg-surface px-4 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="flex items-center gap-2 text-foreground">
          <StepGlyph
            status={
              download.state === "ready"
                ? "done"
                : download.state === "failed"
                  ? "failed"
                  : download.state === "waiting"
                    ? "pending"
                    : "running"
            }
          />
          {name}
        </span>
        <span className="text-xs text-secondary-foreground">
          {download.state === "failed" && download.error
            ? t(download.error)
            : t(downloadStateKeys[download.state])}
        </span>
      </div>
      {download.state === "downloading" || download.state === "verifying" ? (
        <>
          <div
            role="progressbar"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(share === null ? {} : { "aria-valuenow": Math.round(share * 100) })}
            className="h-1.5 overflow-hidden rounded-full bg-soft"
          >
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.round((share ?? 0) * 100)}%` }}
            />
          </div>
          {download.totalBytes > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("onboarding.setup.models.progress", {
                values: {
                  done: formatSize(t.locale, download.downloadedBytes),
                  total: formatSize(t.locale, download.totalBytes)
                }
              })}
              {minutes === null
                ? ""
                : ` · ${t("onboarding.setup.models.eta", { values: { minutes } })}`}
            </p>
          ) : null}
        </>
      ) : null}
    </li>
  );
}

function Checks({ t, setup }: { t: Translator; setup: SetupState }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="grid gap-2">
      <h3 id={titleId} className="text-sm font-medium text-foreground">
        {t("onboarding.setup.tests.title")}
      </h3>
      <ul className="grid gap-1.5">
        {setup.tests.map((test) => (
          <li
            key={test.route}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-4 py-2 text-sm"
          >
            <span className="flex items-center gap-2 text-foreground">
              <StepGlyph status={test.state} />
              {t(classTestNameKeys[test.route])}
            </span>
            <span className="text-xs text-secondary-foreground">
              {t(classTestStateKeys[test.state])}
              {test.state === "passed" && test.ms !== null
                ? ` · ${t("onboarding.setup.tests.duration", { values: { ms: test.ms } })}`
                : ""}
              {test.state === "failed" && test.error ? ` · ${testErrorText(t, test.error)}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
