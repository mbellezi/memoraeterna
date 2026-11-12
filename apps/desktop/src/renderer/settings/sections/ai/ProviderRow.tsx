import { useId, useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import type { AiProviderConfig } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { InlineAction } from "../../InlineAction";
import { SettingRow } from "../../SettingRow";
import type { AiSettingsController } from "./ai-controller";
import {
  errorKeyOf,
  providerOfEntryId,
  providerStateKeys,
  providerView,
  purposeCapabilities,
  purposeKeys,
  purposeOf,
  type ModelPurpose,
  type ProviderKind
} from "./ai-model";
import { AreaNotice, Field, StatusLine, TextField } from "./ai-parts";
import { useRowProps } from "./ai-rows";

type Mode = "add" | "replace" | "signIn" | null;

const purposes: readonly ModelPurpose[] = ["generation", "embedding", "reranking"];

/**
 * One provider and its credential (`ai.provider.<kind>`): whether a key or a sign-in is saved, the
 * way to add or replace it and the models added on it, each with its test and its removal. The key
 * is typed once into a password field and sent to the main process; the renderer never reads it
 * back. Removing a model asks first, in the line, and says what it unlinks.
 */
export function ProviderRow({
  entry,
  configs,
  waiting,
  controller,
  notice
}: {
  entry: SettingEntryV2;
  /** Null until the providers are read. */
  configs: readonly AiProviderConfig[] | null;
  waiting: boolean;
  controller: AiSettingsController;
  notice: string | undefined;
}) {
  const kind = providerOfEntryId(entry.id);
  const row = useRowProps(entry, { withReset: false });
  const { t } = row;
  const [mode, setMode] = useState<Mode>(null);
  if (!kind) return null;
  if (!configs)
    return (
      <SettingRow
        {...row}
        control={waiting ? <Skeleton className="h-8 w-32 rounded-lg" /> : undefined}
      />
    );
  const view = providerView(kind, configs);
  const codex = kind === "openai-codex";
  const hasCredential = view.state === "connected" || view.state === "keySaved";
  const primary = codex
    ? hasCredential
      ? t("settingsAi.providers.action.signInAgain")
      : t("settingsAi.providers.action.signIn")
    : hasCredential
      ? t("settingsAi.providers.action.replaceKey")
      : t("settingsAi.providers.action.addKey");

  return (
    <SettingRow
      {...row}
      stack={mode !== null}
      control={
        mode === null ? (
          <>
            <Button
              aria-label={`${primary}: ${row.label}`}
              onClick={() => setMode(codex ? "signIn" : hasCredential ? "replace" : "add")}
            >
              {codex ? <LogIn aria-hidden="true" /> : null}
              {primary}
            </Button>
          </>
        ) : undefined
      }
      note={
        <div className="grid gap-2">
          <StatusLine tone={hasCredential ? "ok" : "idle"}>
            {t(providerStateKeys[view.state])}
          </StatusLine>
          {mode !== null ? (
            <ProviderForm
              t={t}
              kind={kind}
              mode={mode}
              configs={view.configs}
              controller={controller}
              onClose={() => setMode(null)}
            />
          ) : null}
          {view.configs.length > 0 ? (
            <ConfiguredModels
              t={t}
              configs={view.configs}
              controller={controller}
              canAdd={mode === null}
              onAdd={() => setMode(codex ? "signIn" : "add")}
            />
          ) : null}
          <AreaNotice message={notice} />
        </div>
      }
    />
  );
}

function ConfiguredModels({
  t,
  configs,
  controller,
  canAdd,
  onAdd
}: {
  t: Translator;
  configs: readonly AiProviderConfig[];
  controller: AiSettingsController;
  canAdd: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="grid gap-1">
      <p className="m-0 text-xs font-medium text-secondary-foreground">
        {t("settingsAi.providers.modelsLabel")}
      </p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {configs.map((config) => (
          <ConfiguredModel key={config.id} t={t} config={config} controller={controller} />
        ))}
      </ul>
      {canAdd ? (
        <InlineAction size="xs" className="mt-0.5 w-fit" onClick={onAdd}>
          {t("settingsAi.providers.action.addModel")}
        </InlineAction>
      ) : null}
    </div>
  );
}

function ConfiguredModel({
  t,
  config,
  controller
}: {
  t: Translator;
  config: AiProviderConfig;
  controller: AiSettingsController;
}) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [asking, setAsking] = useState(false);
  const purpose = purposeOf(config.capabilities);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      await controller.app.ai.testProvider(config.id);
      setResult({ ok: true, text: t("settingsAi.providers.testOk") });
    } catch (error) {
      setResult({ ok: false, text: t(errorKeyOf(error, "errors.ai.connectionFailed")) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <li className="grid gap-1">
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs leading-5">
        <span className="min-w-0 break-words font-medium text-foreground">{config.modelId}</span>
        <span className="text-muted-foreground">{t(purposeKeys[purpose])}</span>
        {asking ? null : (
          <>
            <InlineAction
              size="xs"
              disabled={testing}
              aria-label={`${t("settingsAi.providers.action.test")}: ${config.modelId}`}
              onClick={() => void test()}
            >
              {testing
                ? t("settingsAi.providers.action.testing")
                : t("settingsAi.providers.action.test")}
            </InlineAction>
            <InlineAction
              size="xs"
              aria-label={`${t("settingsAi.providers.action.remove")}: ${config.modelId}`}
              onClick={() => setAsking(true)}
            >
              {t("settingsAi.providers.action.remove")}
            </InlineAction>
          </>
        )}
      </span>
      {result && !asking ? (
        <StatusLine tone={result.ok ? "ok" : "warn"} live>
          {result.text}
        </StatusLine>
      ) : null}
      {asking ? (
        <span role="group" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="text-foreground">
            {t("settingsAi.providers.removeAsk", { values: { model: config.modelId } })}
          </span>
          <Button
            aria-label={`${t("settingsAi.providers.action.remove")}: ${config.modelId}`}
            onClick={() => {
              setAsking(false);
              void controller.mutate("providers", () =>
                controller.app.ai.deleteProvider(config.id)
              );
            }}
          >
            {t("settingsAi.providers.action.remove")}
          </Button>
          <Button variant="ghost" onClick={() => setAsking(false)}>
            {t("shell.actions.cancel")}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/**
 * The inline form that adds a key and a model, replaces the key of the models already added, or
 * signs in with ChatGPT and picks the model to use. Models are looked up with the key just typed (the
 * provider lists them) or typed by name.
 */
function ProviderForm({
  t,
  kind,
  mode,
  configs,
  controller,
  onClose
}: {
  t: Translator;
  kind: ProviderKind;
  mode: Exclude<Mode, null>;
  configs: readonly AiProviderConfig[];
  controller: AiSettingsController;
  onClose: () => void;
}) {
  const ids = { key: useId(), address: useId(), model: useId(), list: useId() };
  const codex = kind === "openai-codex";
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelId, setModelId] = useState("");
  const [found, setFound] = useState<string[]>([]);
  const [purpose, setPurpose] = useState<ModelPurpose>("generation");
  const [finding, setFinding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const fail = (error: unknown, fallback: MessageKey = "settingsAi.errors.write") =>
    setProblem(t(errorKeyOf(error, fallback)));

  const find = async () => {
    setFinding(true);
    setProblem(null);
    try {
      const models = await controller.app.ai.discoverModels({
        provider: kind,
        apiKey,
        ...(baseUrl ? { baseUrl } : {})
      });
      setFound(models);
      setModelId((current) => current || models[0] || "");
    } catch (error) {
      fail(error, "errors.ai.connectionFailed");
    } finally {
      setFinding(false);
    }
  };

  const signIn = async () => {
    setFinding(true);
    setProblem(null);
    try {
      const models = await controller.app.ai.connectOpenAiCodex();
      setFound(models);
      setModelId((current) => current || models[0] || "");
      setSignedIn(true);
      // Signing in again for models already added renews their sign-in and is done.
      if (configs[0]) {
        const first = configs[0];
        const ok = await controller.mutate("providers", () =>
          controller.app.ai.saveProvider({
            id: first.id,
            provider: first.provider,
            displayName: first.displayName,
            baseUrl: first.baseUrl,
            modelId: first.modelId,
            capabilities: first.capabilities,
            defaultParameters: first.defaultParameters
          })
        );
        if (ok) onClose();
      }
    } catch (error) {
      setSignedIn(false);
      fail(error, "errors.ai.oauthLoginFailed");
    } finally {
      setFinding(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setProblem(null);
    const ok = await controller.mutate("providers", async () => {
      if (mode === "replace") {
        for (const config of configs)
          await controller.app.ai.saveProvider({
            id: config.id,
            provider: config.provider,
            displayName: config.displayName,
            baseUrl: config.baseUrl,
            modelId: config.modelId,
            capabilities: config.capabilities,
            defaultParameters: config.defaultParameters,
            apiKey
          });
        return;
      }
      await controller.app.ai.saveProvider({
        provider: kind,
        displayName: modelId.trim(),
        modelId: modelId.trim(),
        capabilities: purposeCapabilities(codex ? "generation" : purpose, kind),
        defaultParameters: {},
        ...(!codex && baseUrl ? { baseUrl } : {}),
        ...(!codex && apiKey ? { apiKey } : {})
      });
    });
    setSaving(false);
    if (ok) onClose();
    else setProblem(t("settingsAi.errors.write"));
  };

  const canSave =
    !saving &&
    (mode === "replace"
      ? apiKey.trim() !== ""
      : modelId.trim() !== "" && (codex ? signedIn : apiKey.trim() !== ""));

  return (
    <form
      onSubmit={(event) => void save(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="grid max-w-[30rem] gap-3 rounded-lg border border-border bg-soft p-3 text-sm"
    >
      {codex ? (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={finding || saving} onClick={() => void signIn()}>
              <LogIn aria-hidden="true" />
              {signedIn
                ? t("settingsAi.providers.action.signInAgain")
                : t("settingsAi.providers.action.signIn")}
            </Button>
            {finding ? (
              <StatusLine tone="working" live>
                {t("settingsAi.providers.action.finding")}
              </StatusLine>
            ) : signedIn ? (
              <StatusLine tone="ok" live>
                {t("settingsAi.providers.form.signedIn")}
              </StatusLine>
            ) : null}
          </div>
          <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">
            {t("settingsAi.providers.form.signInHint")}
          </p>
        </div>
      ) : (
        <>
          {kind === "openai-compatible" && mode !== "replace" ? (
            <Field
              label={t("settingsAi.providers.form.address")}
              htmlFor={ids.address}
              hint={t("settingsAi.providers.form.addressHint")}
            >
              <TextField
                id={ids.address}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setFound([]);
                }}
              />
            </Field>
          ) : null}
          <Field label={t("settingsAi.providers.form.key")} htmlFor={ids.key}>
            <TextField
              id={ids.key}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </Field>
        </>
      )}

      {mode !== "replace" && (!codex || signedIn) ? (
        <div className="grid gap-3">
          <Field
            label={t("settingsAi.providers.form.model")}
            htmlFor={ids.model}
            hint={t("settingsAi.providers.form.modelHint")}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <TextField
                id={ids.model}
                list={ids.list}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 basis-48"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              />
              <datalist id={ids.list}>
                {found.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
              {!codex ? (
                <Button disabled={!apiKey.trim() || finding} onClick={() => void find()}>
                  {finding
                    ? t("settingsAi.providers.action.finding")
                    : t("settingsAi.providers.action.find")}
                </Button>
              ) : null}
            </div>
          </Field>
          {!codex ? (
            <div
              role="group"
              aria-label={t("settingsAi.providers.form.purpose")}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="text-xs font-medium text-secondary-foreground">
                {t("settingsAi.providers.form.purpose")}
              </span>
              {purposes.map((candidate) => (
                <Button
                  key={candidate}
                  variant="chip"
                  size="sm"
                  aria-pressed={purpose === candidate}
                  onClick={() => setPurpose(candidate)}
                >
                  {t(purposeKeys[candidate])}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {problem ? <AreaNotice message={problem} /> : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!canSave}>
          {saving ? t("settingsAi.providers.action.saving") : t("settingsAi.providers.action.save")}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("shell.actions.cancel")}
        </Button>
      </div>
    </form>
  );
}
