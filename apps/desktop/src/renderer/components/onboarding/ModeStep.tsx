import { useId } from "react";
import { Check, LoaderCircle, LogIn, TriangleAlert } from "lucide-react";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  keyProviders,
  writerReady,
  type KeyProvider,
  type OnboardingController,
  type OnboardingSnapshot
} from "./onboarding-controller";
import {
  formatSize,
  formatUsd,
  modeOptions,
  presetHintKeys,
  presetNameKeys,
  type ModeOption
} from "./onboarding-model";

const selectClass =
  "h-9 min-w-0 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export type ModeActions = Pick<
  OnboardingController,
  | "selectPreset"
  | "retryCard"
  | "setWriterMethod"
  | "signInCodex"
  | "setCodexModel"
  | "setKeyProvider"
  | "setKeyField"
  | "setApiKey"
  | "startSetup"
  | "back"
>;

export interface ModeStepProps {
  t: Translator;
  mode: OnboardingSnapshot["mode"];
  canStart: boolean;
  actions: ModeActions;
}

/** Step 2: this computer, the three setups and, for the ones with a cloud writer, its sign-in. */
export function ModeStep({ t, mode, canStart, actions }: ModeStepProps) {
  const hardware = mode.hardware.status === "ready" ? mode.hardware.value : null;
  const models = mode.catalog.status === "ready" ? mode.catalog.value : null;
  const options = modeOptions(hardware, models);
  const needsWriter = mode.selected !== "local";
  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        actions.startSetup();
      }}
    >
      <p className="text-sm text-secondary-foreground">{t("onboarding.mode.description")}</p>
      <TierCard t={t} mode={mode} onRetry={() => actions.retryCard()} />
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium text-foreground">
          {t("onboarding.mode.choices")}
        </legend>
        {options.map((option) => (
          <OptionRow
            key={option.preset}
            t={t}
            option={option}
            selected={mode.selected === option.preset}
            hardwareReady={hardware !== null}
            onSelect={() => actions.selectPreset(option.preset)}
          />
        ))}
        {mode.refusal ? (
          <p role="alert" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            {t("onboarding.mode.unavailable")}
          </p>
        ) : null}
      </fieldset>
      <p className="text-xs text-secondary-foreground">
        {t(needsWriter ? "onboarding.mode.privacyRemote" : "onboarding.mode.privacyLocal")}
      </p>
      {needsWriter ? <WriterPanel t={t} mode={mode} actions={actions} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={() => actions.back()}>
          {t("onboarding.back")}
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {needsWriter && !writerReady(mode.writer) ? (
            <span className="text-xs text-muted-foreground">
              {t("onboarding.mode.needsWriter")}
            </span>
          ) : null}
          <Button type="submit" variant="primary" disabled={!canStart}>
            {t("onboarding.mode.start")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function TierCard({
  t,
  mode,
  onRetry
}: {
  t: Translator;
  mode: OnboardingSnapshot["mode"];
  onRetry: () => void;
}) {
  const titleId = useId();
  const { hardware } = mode;
  return (
    <section
      aria-labelledby={titleId}
      className="grid gap-1.5 rounded-lg border border-border bg-surface px-4 py-3"
    >
      <h3 id={titleId} className="text-sm font-medium text-foreground">
        {t("onboarding.mode.card.title")}
      </h3>
      {hardware.status === "loading" ? (
        <p role="status" className="flex items-center gap-2 text-sm text-secondary-foreground">
          <LoaderCircle
            className="h-4 w-4 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t("onboarding.mode.card.loading")}
        </p>
      ) : hardware.status === "error" ? (
        <div
          role="alert"
          className="grid justify-items-start gap-2 text-sm text-secondary-foreground"
        >
          <p className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            {t("onboarding.mode.card.error")}
          </p>
          <Button type="button" onClick={onRetry}>
            {t("onboarding.mode.card.retry")}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-sm text-secondary-foreground">
            {hardware.value.chip
              ? t("onboarding.mode.card.summary", {
                  values: {
                    chip: hardware.value.chip,
                    memory: formatSize(t.locale, hardware.value.memoryBytes)
                  }
                })
              : t("onboarding.mode.card.summaryNoChip", {
                  values: { memory: formatSize(t.locale, hardware.value.memoryBytes) }
                })}
          </p>
          {hardware.value.translated ? (
            <p className="text-xs text-muted-foreground">{t("onboarding.mode.card.translated")}</p>
          ) : null}
        </>
      )}
      {mode.catalog.status === "error" ? (
        <p className="text-xs text-muted-foreground">{t("onboarding.mode.card.catalogError")}</p>
      ) : null}
    </section>
  );
}

function OptionRow({
  t,
  option,
  selected,
  hardwareReady,
  onSelect
}: {
  t: Translator;
  option: ModeOption;
  selected: boolean;
  hardwareReady: boolean;
  onSelect: () => void;
}) {
  const download =
    option.downloadBytes === null
      ? t("onboarding.mode.downloadUnknown")
      : option.downloadBytes === 0
        ? t("onboarding.mode.downloadNone")
        : t("onboarding.mode.download", {
            values: { size: formatSize(t.locale, option.downloadBytes) }
          });
  const cost = !option.remoteWriter
    ? t("onboarding.mode.costLocal")
    : option.monthlyUsd === null
      ? t("onboarding.mode.costUnknown")
      : t("onboarding.mode.costEstimate", {
          values: { amount: formatUsd(t.locale, option.monthlyUsd) }
        });
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border bg-surface px-4 py-3",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        selected ? "border-accent bg-accent-soft" : "border-border-strong hover:bg-soft",
        !option.available && "border-dashed"
      )}
    >
      <input
        type="radio"
        name="onboarding-setup"
        className="mt-1 h-4 w-4 shrink-0 accent-accent"
        checked={selected}
        aria-disabled={!option.available}
        onChange={onSelect}
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          {t(presetNameKeys[option.preset])}
          {option.recommended && hardwareReady ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
              <Check className="h-3 w-3" aria-hidden="true" />
              {t("onboarding.mode.card.recommended")}
            </span>
          ) : null}
        </span>
        <span className="text-xs text-secondary-foreground">
          {t(presetHintKeys[option.preset])}
        </span>
        {option.available ? (
          <span className="text-xs text-muted-foreground">
            {download} · {cost}
          </span>
        ) : (
          <span className="text-xs text-warning">{t("onboarding.mode.unavailable")}</span>
        )}
      </span>
    </label>
  );
}

function WriterPanel({
  t,
  mode,
  actions
}: {
  t: Translator;
  mode: OnboardingSnapshot["mode"];
  actions: ModeActions;
}) {
  const titleId = useId();
  const modelId = useId();
  const providerId = useId();
  const baseUrlId = useId();
  const keyModelId = useId();
  const apiKeyId = useId();
  const { writer } = mode;
  const connecting = writer.codex.status === "connecting";
  return (
    <section
      aria-labelledby={titleId}
      className="grid gap-4 rounded-lg border border-border bg-surface px-4 py-4"
    >
      <div className="grid gap-1">
        <h3 id={titleId} className="text-sm font-medium text-foreground">
          {t("onboarding.mode.writer.title")}
        </h3>
        <p className="text-xs text-secondary-foreground">
          {t("onboarding.mode.writer.description")}
        </p>
      </div>
      <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <legend className="mb-1 text-xs text-muted-foreground">
          {t("onboarding.mode.writer.method")}
        </legend>
        {(["codex", "key"] as const).map((method) => (
          <label key={method} className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="radio"
              name="onboarding-writer-method"
              className="h-4 w-4 accent-accent"
              checked={writer.method === method}
              disabled={connecting}
              onChange={() => actions.setWriterMethod(method)}
            />
            {t(method === "codex" ? "onboarding.mode.writer.codex" : "onboarding.mode.writer.key")}
          </label>
        ))}
      </fieldset>
      {writer.method === "codex" ? (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={connecting}
              variant={writer.codex.status === "connected" ? "secondary" : "primary"}
              onClick={() => void actions.signInCodex()}
            >
              {connecting ? (
                <LoaderCircle
                  className="animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <LogIn aria-hidden="true" />
              )}
              {t("onboarding.mode.writer.signIn")}
            </Button>
            <span
              role="status"
              className="flex items-center gap-1.5 text-xs text-secondary-foreground"
            >
              {connecting ? (
                t("onboarding.mode.writer.signingIn")
              ) : writer.codex.status === "connected" ? (
                <>
                  <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  {t("onboarding.mode.writer.signedIn")}
                </>
              ) : null}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("onboarding.mode.writer.codexHint")}</p>
          {writer.codex.error ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {t(writer.codex.error.key)}
            </p>
          ) : null}
          {writer.codex.status === "connected" ? (
            <div className="grid gap-1.5 sm:max-w-sm">
              <Label htmlFor={modelId}>{t("settings.ai.model")}</Label>
              {writer.codex.models.length > 0 ? (
                <select
                  id={modelId}
                  className={selectClass}
                  value={writer.codex.modelId}
                  onChange={(event) => actions.setCodexModel(event.target.value)}
                >
                  {writer.codex.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <Input
                    id={modelId}
                    autoComplete="off"
                    value={writer.codex.modelId}
                    onChange={(event) => actions.setCodexModel(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("onboarding.mode.writer.noModels")}
                  </p>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={providerId}>{t("settings.ai.provider")}</Label>
            <select
              id={providerId}
              className={selectClass}
              value={writer.key.provider}
              onChange={(event) => actions.setKeyProvider(event.target.value as KeyProvider)}
            >
              {keyProviders.map((provider) => (
                <option key={provider} value={provider}>
                  {t(provider === "google" ? "settings.ai.google" : "settings.ai.openAiCompatible")}
                </option>
              ))}
            </select>
          </div>
          {writer.key.provider === "openai-compatible" ? (
            <div className="grid gap-1.5">
              <Label htmlFor={baseUrlId}>{t("settings.ai.baseUrl")}</Label>
              <Input
                id={baseUrlId}
                type="url"
                autoComplete="off"
                value={writer.key.baseUrl}
                onChange={(event) => actions.setKeyField("baseUrl", event.target.value)}
              />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={keyModelId}>{t("settings.ai.model")}</Label>
            <Input
              id={keyModelId}
              autoComplete="off"
              value={writer.key.modelId}
              onChange={(event) => actions.setKeyField("modelId", event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={apiKeyId}>{t("settings.ai.apiKey")}</Label>
            <Input
              id={apiKeyId}
              type="password"
              autoComplete="off"
              spellCheck={false}
              defaultValue=""
              onChange={(event) => actions.setApiKey(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">
            {t("onboarding.mode.writer.keyHint")}
          </p>
        </div>
      )}
    </section>
  );
}
