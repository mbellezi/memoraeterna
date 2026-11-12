import { useState } from "react";
import { FileInput } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import type { AiModelParameters, LocalModelView } from "../../../../shared/ipc";
import { AiParameterFields } from "../../../components/AiParameterFields";
import { Button } from "../../../components/ui/button";
import { ErrorState } from "../../../components/ui/error-state";
import { LoadingState, SkeletonRows } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { InlineAction } from "../../InlineAction";
import type { AiSettingsController, Load, ModelsData } from "./ai-controller";
import {
  etaText,
  filterModels,
  formatSize,
  isRankerModel,
  modelCompatibilityKeys,
  modelStatusKeys,
  rankerNoteKey,
  sortModels,
  type ModelFilter
} from "./ai-model";
import { AreaNotice, StatusLine } from "./ai-parts";

const filters: ReadonlyArray<{ id: ModelFilter; label: MessageKey }> = [
  { id: "all", label: "settingsAi.models.filter.all" },
  { id: "generation", label: "settingsAi.models.filter.writing" },
  { id: "embedding", label: "settingsAi.models.filter.search" },
  { id: "ranking", label: "settingsAi.models.filter.ranking" }
];

/**
 * The catalog of local models, opened in place under "Models on this Mac": what is installed and what
 * could be, with the downloads arriving as pushed events (never a timer), a model's test and its
 * removal, and its default parameters. A filter by what a model is for and a switch for those that fit
 * this Mac keep a long catalog short. Removal asks first, in the line; a model a profile uses cannot be
 * removed, and the line says which profiles.
 */
export function LocalModelsPage({
  t,
  load,
  controller,
  notice,
  onRetry
}: {
  t: Translator;
  load: Load<ModelsData>;
  controller: AiSettingsController;
  notice: string | undefined;
  onRetry: () => void;
}) {
  const [filter, setFilter] = useState<ModelFilter>("all");
  const [compatibleOnly, setCompatibleOnly] = useState(false);

  if (load.status === "loading")
    return (
      <div className="py-3">
        <LoadingState t={t}>
          <SkeletonRows rows={4} />
        </LoadingState>
      </div>
    );
  if (load.status === "error")
    return (
      <div className="py-3">
        <ErrorState
          t={t}
          message={t("settingsAi.models.errorTitle")}
          kept={t("settingsAi.models.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={onRetry}
        />
      </div>
    );

  const shown = filterModels(sortModels(load.value.models), filter, compatibleOnly);
  const run = (action: () => Promise<unknown>) =>
    controller.mutate("models", action, { models: true });
  return (
    <div className="grid gap-3 pt-1">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          role="group"
          aria-label={t("settingsAi.models.filter.label")}
          className="flex flex-wrap items-center gap-1.5"
        >
          {filters.map((candidate) => (
            <Button
              key={candidate.id}
              variant="chip"
              size="sm"
              aria-pressed={filter === candidate.id}
              onClick={() => setFilter(candidate.id)}
            >
              {t(candidate.label)}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-2 text-xs text-secondary-foreground">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={compatibleOnly}
            onChange={(event) => setCompatibleOnly(event.target.checked)}
          />
          {t("settingsAi.models.filter.compatible")}
        </label>
        <Button
          className="ml-auto"
          onClick={() => void run(() => controller.app.localModels.importGguf())}
        >
          <FileInput aria-hidden="true" />
          {t("settingsAi.models.action.import")}
        </Button>
      </div>
      <AreaNotice message={notice} />
      {shown.length === 0 ? (
        <p className="m-0 text-sm text-secondary-foreground">{t("settingsAi.models.empty")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0 p-0">
          {shown.map((model) => (
            <ModelItem key={model.id} t={t} model={model} controller={controller} run={run} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ModelItem({
  t,
  model,
  controller,
  run
}: {
  t: Translator;
  model: LocalModelView;
  controller: AiSettingsController;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [accepted, setAccepted] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string; output: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [params, setParams] = useState(false);
  const active = model.status === "downloading" || model.status === "verifying";
  const ready = model.status === "ready";
  const licenseOk = !model.requiresLicenseAcceptance || model.licenseAccepted || accepted;
  const ranker = isRankerModel(model);
  const rankerNote = ranker ? rankerNoteKey(model) : null;
  const progress =
    model.download && model.download.totalBytes > 0
      ? Math.min(
          100,
          Math.round((model.download.downloadedBytes / model.download.totalBytes) * 100)
        )
      : 0;

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const output = await controller.app.localModels.test(model.catalogId);
      setTest({ ok: true, text: t("settingsAi.models.testOk"), output });
    } catch (error) {
      const key =
        error instanceof Error ? error.message.match(/errors\.[a-zA-Z0-9_.-]+/u)?.[0] : null;
      setTest({
        ok: false,
        text: key ? t(key as MessageKey) : t("errors.common.unknown"),
        output: ""
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <li className="grid gap-1.5 border-t border-border py-3 first:border-t-0">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="m-0 flex flex-wrap items-center gap-x-2 text-sm font-medium leading-5 text-foreground">
            <span className="min-w-0 [overflow-wrap:anywhere]">{model.displayName}</span>
          </p>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            {model.runtime.toUpperCase()} · {model.quantization} ·{" "}
            {formatSize(
              t.locale,
              ready && model.installedSizeBytes ? model.installedSizeBytes : model.expectedSizeBytes
            )}
          </p>
          <p className="m-0 mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs leading-5">
            <StatusLine
              tone={ready ? "ok" : model.status === "failed" ? "warn" : active ? "working" : "idle"}
            >
              {t(modelStatusKeys[model.status])}
            </StatusLine>
            {!model.compatible && !ready ? (
              <span className="text-warning">
                {t(modelCompatibilityKeys[model.compatibilityReason])}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {model.status === "not_downloaded" ? (
            <Button
              disabled={!model.compatible || !licenseOk}
              aria-label={`${t("settingsAi.models.action.download")}: ${model.displayName}`}
              onClick={() =>
                void run(() =>
                  controller.app.localModels.download({
                    catalogId: model.catalogId,
                    acceptLicense: model.licenseAccepted || accepted
                  })
                )
              }
            >
              {t("settingsAi.models.action.download")}
            </Button>
          ) : null}
          {active ? (
            <Button
              aria-label={`${t("shell.actions.cancel")}: ${model.displayName}`}
              onClick={() => void run(() => controller.app.localModels.cancel(model.catalogId))}
            >
              {t("shell.actions.cancel")}
            </Button>
          ) : null}
          {model.status === "failed" ? (
            <Button
              aria-label={`${t("settingsAi.models.action.resume")}: ${model.displayName}`}
              onClick={() => void run(() => controller.app.localModels.resume(model.catalogId))}
            >
              {t("settingsAi.models.action.resume")}
            </Button>
          ) : null}
          {ready && !removing ? (
            <>
              <Button
                disabled={testing}
                aria-label={`${t("settingsAi.models.action.test")}: ${model.displayName}`}
                onClick={() => void runTest()}
              >
                {testing ? t("settingsAi.test.running") : t("settingsAi.models.action.test")}
              </Button>
              <Button
                variant="ghost"
                disabled={model.profilesUsing.length > 0}
                aria-label={`${t("settingsAi.models.action.remove")}: ${model.displayName}`}
                onClick={() => setRemoving(true)}
              >
                {t("settingsAi.models.action.remove")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {model.requiresLicenseAcceptance && !model.licenseAccepted ? (
        <label className="flex items-start gap-2 text-xs text-secondary-foreground">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-accent"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          <span>
            {t("settingsAi.models.license")}{" "}
            <a
              className="text-accent underline underline-offset-2"
              href={model.licenseUrl}
              target="_blank"
              rel="noreferrer"
            >
              {model.licenseName}
            </a>
          </span>
        </label>
      ) : null}

      {active && model.download ? (
        <div className="grid gap-1">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={model.displayName}
            className="h-1.5 overflow-hidden rounded-full bg-soft"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${progress}%` }} />
          </div>
          <p className="m-0 text-xs text-secondary-foreground tabular-nums">
            {formatSize(t.locale, model.download.downloadedBytes)} /{" "}
            {formatSize(t.locale, model.download.totalBytes)}
            {etaText(t, model.download.etaSeconds)
              ? ` · ${etaText(t, model.download.etaSeconds)}`
              : ""}
          </p>
        </div>
      ) : null}

      {rankerNote ? (
        <p className="m-0 max-w-[36rem] text-xs text-secondary-foreground [text-wrap:pretty]">
          {t(rankerNote)}
        </p>
      ) : null}
      {model.lastError ? (
        <StatusLine tone="warn">
          {model.lastError.startsWith("errors.")
            ? t(model.lastError.split(":")[0] as MessageKey)
            : t("errors.common.unknown")}
        </StatusLine>
      ) : null}
      {model.profilesUsing.length > 0 && ready ? (
        <p className="m-0 text-xs text-muted-foreground">
          {t("settingsAi.models.removeBlocked", {
            values: { profiles: model.profilesUsing.join(", ") }
          })}
        </p>
      ) : null}

      {removing ? (
        <span role="group" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-foreground">
            {t("settingsAi.models.removeAsk", { values: { model: model.displayName } })}
          </span>
          <Button
            aria-label={`${t("settingsAi.models.action.remove")}: ${model.displayName}`}
            onClick={() => {
              setRemoving(false);
              void run(() => controller.app.localModels.remove(model.catalogId));
            }}
          >
            {t("settingsAi.models.action.remove")}
          </Button>
          <Button variant="ghost" onClick={() => setRemoving(false)}>
            {t("shell.actions.cancel")}
          </Button>
        </span>
      ) : null}

      {test ? (
        <div className="grid gap-1">
          <StatusLine tone={test.ok ? "ok" : "warn"} live>
            {test.text}
          </StatusLine>
          {test.output ? (
            <pre className="m-0 max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-soft p-2 text-xs text-secondary-foreground [overflow-wrap:anywhere]">
              {test.output}
            </pre>
          ) : null}
        </div>
      ) : null}

      {ready && !ranker ? (
        <div className="grid gap-2">
          <InlineAction
            size="xs"
            className="w-fit"
            aria-expanded={params}
            onClick={() => setParams((value) => !value)}
          >
            {t("settingsAi.models.parameters")}
          </InlineAction>
          {params ? (
            <ModelDefaults
              t={t}
              model={model}
              onSave={(parameters) =>
                run(() => controller.app.localModels.setDefaults(model.id, parameters))
              }
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A model's default parameters (context, temperature, reasoning…) and the way back to the recommended ones. */
function ModelDefaults({
  t,
  model,
  onSave
}: {
  t: Translator;
  model: LocalModelView;
  onSave: (parameters: AiModelParameters) => Promise<unknown>;
}) {
  const [parameters, setParameters] = useState<AiModelParameters>(model.defaultParameters);
  const presets = model.recommendedParameters;
  const reasoning = parameters.reasoningLevel !== undefined && parameters.reasoningLevel !== "off";
  const recommended = presets
    ? reasoning
      ? (presets.reasoning ?? presets.nonReasoning)
      : (presets.nonReasoning ?? presets.reasoning)
    : undefined;
  return (
    <div className={cn("grid gap-3 rounded-lg border border-border bg-soft p-3")}>
      <AiParameterFields
        planningContext={model.runtime === "mlx"}
        value={parameters}
        onChange={setParameters}
        capabilities={model.parameterCapabilities}
        t={t}
        embeddingOnly={model.capabilities.includes("embedding")}
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void onSave(parameters)}>
          {t("settingsAi.models.saveDefaults")}
        </Button>
        {recommended ? (
          <Button onClick={() => setParameters({ ...recommended })}>
            {t("settingsAi.models.action.useRecommended")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
