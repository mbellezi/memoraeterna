import { useEffect, useId, useState } from "react";
import { Check, Cloud, KeyRound, LoaderCircle, ShieldAlert, TriangleAlert } from "lucide-react";
import type { AiPresetMode, DecisionsFallbackReason } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type { AiDecisionsStatus } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import type { ToastTone } from "./ui/toast";

type T = (key: MessageKey) => string;

/** Characters of each note's text the request carries (`relations.decide.bodyCharacters`). */
const bodyCharacters = 600;

const reasonKeys: Record<DecisionsFallbackReason, MessageKey> = {
  no_key: "settings.ai.decisions.reasons.noKey",
  invalid_key: "settings.ai.decisions.reasons.invalidKey",
  spend_cap: "settings.ai.decisions.reasons.spendCap",
  quota: "settings.ai.decisions.reasons.quota",
  breaker_open: "settings.ai.decisions.reasons.breakerOpen",
  network: "settings.ai.decisions.reasons.network",
  error: "settings.ai.decisions.reasons.error"
};

const money = (value: number) => (value < 0.01 ? value.toFixed(4) : value.toFixed(2));

/** The sentence under the title: what decides note relations now, and why when it is not OpenAI. */
export function decisionsStatusLine(t: T, status: AiDecisionsStatus): string {
  if (status.state === "unavailable_preset")
    return t("settings.ai.decisions.state.unavailablePreset");
  if (status.state === "off") return t("settings.ai.decisions.state.off");
  const reason = status.fallbackReason ? t(reasonKeys[status.fallbackReason]) : "";
  if (status.state === "fallback")
    return t("settings.ai.decisions.state.fallback").replace("{reason}", reason);
  // On and able to decide; the last use may still have fallen back (a failed request).
  return status.fallbackReason
    ? `${t("settings.ai.decisions.state.ready")} ${t("settings.ai.decisions.state.lastFallback").replace("{reason}", reason)}`
    : t("settings.ai.decisions.state.ready");
}

export function decisionsPrivacyBody(t: T, status: Pick<AiDecisionsStatus, "model">): string {
  return t("settings.ai.decisions.privacy.body")
    .replace("{characters}", String(bodyCharacters))
    .replace("{model}", status.model);
}

export interface DecisionsDeciderViewProps {
  t: T;
  status: AiDecisionsStatus;
  /** An action is running: nothing else can start. */
  busy: boolean;
  /** The person asked to turn it on and has not confirmed after reading the notice. */
  confirming: boolean;
  /** What is typed in the key field; never shown again once saved. */
  keyDraft: string;
  onKeyDraft: (value: string) => void;
  onAskEnable: () => void;
  onConfirmEnable: () => void;
  onCancelEnable: () => void;
  onDisable: () => void;
  onSaveKey: () => void;
  onRemoveKey: () => void;
  onTestKey: () => void;
}

/** The opt-in OpenAI Decisions decider of Settings > AI (plan decision 30): notice, switch, key, spend. */
export function DecisionsDeciderView(props: DecisionsDeciderViewProps) {
  const { t, status, busy, confirming, keyDraft } = props;
  const keyId = useId();
  const keyHintId = useId();
  const headingId = useId();
  const canSave = !busy && keyDraft.trim().length >= 16;
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-3 rounded-lg border border-border bg-surface p-3"
    >
      <div className="grid gap-1">
        <h3 id={headingId} className="flex items-center gap-2 font-medium">
          <Cloud className="size-4 shrink-0" aria-hidden="true" />
          {t("settings.ai.decisions.title")}
        </h3>
        <p className="text-sm text-secondary-foreground">
          {t("settings.ai.decisions.description")}
        </p>
      </div>

      <div
        role="note"
        className="grid gap-1 rounded-lg border border-border-strong bg-soft p-3 text-sm"
      >
        <p className="flex items-center gap-2 font-medium">
          <ShieldAlert className="size-4 shrink-0" aria-hidden="true" />
          {t("settings.ai.decisions.privacy.title")}
        </p>
        <p className="text-secondary-foreground">{decisionsPrivacyBody(t, status)}</p>
        <p className="text-secondary-foreground">
          {t("settings.ai.decisions.privacy.cost")
            .replace("{price}", String(status.priceInputPerMillionUsd))
            .replace("{cap}", money(status.dailyCapUsd))}
        </p>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={
          status.state === "fallback"
            ? "flex items-start gap-1 text-sm text-danger"
            : "text-sm text-secondary-foreground"
        }
      >
        {status.state === "fallback" ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        ) : null}
        <span>{decisionsStatusLine(t, status)}</span>
      </p>

      {status.presetAllowed ? (
        <>
          {confirming ? (
            <div
              role="group"
              aria-label={t("settings.ai.decisions.toggle.confirmTitle")}
              className="grid gap-2 rounded-lg border border-border-strong bg-soft p-3 text-sm"
            >
              <p className="font-medium">{t("settings.ai.decisions.toggle.confirmTitle")}</p>
              <p className="text-secondary-foreground">
                {t("settings.ai.decisions.toggle.confirmBody")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="primary"
                  disabled={busy}
                  onClick={props.onConfirmEnable}
                >
                  {t("settings.ai.decisions.toggle.confirmApply")}
                </Button>
                <Button type="button" disabled={busy} onClick={props.onCancelEnable}>
                  {t("settings.ai.decisions.toggle.confirmCancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{t("settings.ai.decisions.toggle.label")}</span>
              {status.enabled ? (
                <Button type="button" disabled={busy} onClick={props.onDisable}>
                  {t("settings.ai.decisions.toggle.turnOff")}
                </Button>
              ) : (
                <Button type="button" variant="primary" disabled={busy} onClick={props.onAskEnable}>
                  {t("settings.ai.decisions.toggle.turnOn")}
                </Button>
              )}
            </div>
          )}

          <div className="grid gap-1 md:max-w-md">
            <Label htmlFor={keyId}>{t("settings.ai.decisions.key.label")}</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id={keyId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keyDraft}
                placeholder={t("settings.ai.decisions.key.placeholder")}
                aria-describedby={keyHintId}
                disabled={busy}
                className="min-w-48 flex-1"
                onChange={(event) => props.onKeyDraft(event.target.value)}
              />
              <Button type="button" variant="primary" disabled={!canSave} onClick={props.onSaveKey}>
                <KeyRound aria-hidden="true" />
                {t("settings.ai.decisions.key.save")}
              </Button>
            </div>
            <p id={keyHintId} className="text-xs text-muted-foreground">
              {t("settings.ai.decisions.key.hint")}
            </p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {busy ? (
                <span className="inline-flex items-center gap-1 text-secondary-foreground">
                  <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                  {t("settings.ai.decisions.key.working")}
                </span>
              ) : status.keyInvalid ? (
                <span
                  className="inline-flex items-center gap-1 font-medium text-danger"
                  role="alert"
                >
                  <TriangleAlert className="size-3.5" aria-hidden="true" />
                  {t("settings.ai.decisions.key.invalid")}
                </span>
              ) : status.keyStored ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <Check className="size-3.5" aria-hidden="true" />
                  {t("settings.ai.decisions.key.stored")}
                </span>
              ) : (
                <span className="text-muted-foreground">{t("settings.ai.decisions.key.none")}</span>
              )}
              {status.keyStored ? (
                <>
                  <Button type="button" disabled={busy} onClick={props.onTestKey}>
                    {t("settings.ai.decisions.key.test")}
                  </Button>
                  <Button type="button" variant="ghost" disabled={busy} onClick={props.onRemoveKey}>
                    {t("settings.ai.decisions.key.remove")}
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {t("settings.ai.decisions.spend.today")
              .replace("{spent}", money(status.spentTodayUsd))
              .replace("{cap}", money(status.dailyCapUsd))
              .replace("{requests}", String(status.requestsToday))}
          </p>
          <p className="text-xs text-muted-foreground">
            {status.calibrated
              ? t("settings.ai.decisions.calibration.calibrated")
              : t("settings.ai.decisions.calibration.uncalibrated")}
          </p>
        </>
      ) : null}
    </section>
  );
}

// --- the container --------------------------------------------------------------------------------

/** The subset of `window.app.ai` the card uses. */
export interface DecisionsApi {
  decisionsStatus: () => Promise<AiDecisionsStatus>;
  setDecisionsEnabled: (enabled: boolean) => Promise<AiDecisionsStatus>;
  saveDecisionsKey: (apiKey: string) => Promise<AiDecisionsStatus>;
  removeDecisionsKey: () => Promise<AiDecisionsStatus>;
  testDecisionsKey: () => Promise<AiDecisionsStatus>;
}

/** The localized key out of a wrapped IPC error, or the generic one. */
export function decisionsErrorKey(error: unknown): MessageKey {
  const key = error instanceof Error ? error.message.match(/errors\.[a-zA-Z0-9_.-]+/)?.[0] : null;
  return (key as MessageKey | undefined) ?? "errors.common.unknown";
}

/**
 * What each button does, apart from React: the key goes to the main process once, with the save
 * call; the field is cleared as soon as it is sent; the answer is only ever the status.
 */
export function createDecisionsActions(input: {
  api: DecisionsApi;
  onStatus: (status: AiDecisionsStatus) => void;
  onToast: (message: MessageKey, tone: ToastTone) => void;
  onBusy: (busy: boolean) => void;
  onKeyDraft: (value: string) => void;
  onConfirming: (confirming: boolean) => void;
}) {
  const run = async (action: () => Promise<AiDecisionsStatus>, success?: MessageKey) => {
    input.onBusy(true);
    try {
      input.onStatus(await action());
      if (success) input.onToast(success, "success");
      return true;
    } catch (error) {
      input.onToast(decisionsErrorKey(error), "error");
      // A failure still changes the status (a refused key is marked): read it again.
      await input.api.decisionsStatus().then(input.onStatus, () => undefined);
      return false;
    } finally {
      input.onBusy(false);
    }
  };
  return {
    enable: async () => {
      input.onConfirming(false);
      await run(() => input.api.setDecisionsEnabled(true), "settings.ai.decisions.toasts.turnedOn");
    },
    disable: () =>
      run(() => input.api.setDecisionsEnabled(false), "settings.ai.decisions.toasts.turnedOff"),
    saveKey: async (draft: string) => {
      const apiKey = draft.trim();
      // Cleared before the call returns: the key is never kept in the interface.
      input.onKeyDraft("");
      await run(() => input.api.saveDecisionsKey(apiKey), "settings.ai.decisions.toasts.keySaved");
    },
    removeKey: () =>
      run(() => input.api.removeDecisionsKey(), "settings.ai.decisions.toasts.keyRemoved"),
    testKey: () => run(() => input.api.testDecisionsKey(), "settings.ai.decisions.toasts.keyWorks")
  };
}

type LoadState =
  { phase: "loading" } | { phase: "error" } | { phase: "ready"; status: AiDecisionsStatus };

export interface DecisionsDeciderPanelProps {
  t: T;
  /** The setup in force; the status is read again when it changes. */
  preset: AiPresetMode | null;
  onToast?: (message: MessageKey, tone: ToastTone) => void;
}

/** Loads the status, and runs the switch and the key flow of the view above. */
export function DecisionsDeciderPanel({
  t,
  preset,
  onToast = () => undefined
}: DecisionsDeciderPanelProps) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let active = true;
    window.app.ai.decisionsStatus().then(
      (status) => {
        if (active) setState({ phase: "ready", status });
      },
      () => {
        if (active) setState({ phase: "error" });
      }
    );
    return () => {
      active = false;
    };
  }, [preset, reloads]);

  if (state.phase === "loading")
    return (
      <p role="status" className="text-sm text-secondary-foreground">
        {t("settings.ai.decisions.state.loading")}
      </p>
    );
  if (state.phase === "error")
    return (
      <div role="alert" className="grid gap-2 text-sm">
        <p className="text-danger">{t("settings.ai.decisions.state.error")}</p>
        <Button
          type="button"
          className="w-fit"
          onClick={() => {
            setState({ phase: "loading" });
            setReloads((count) => count + 1);
          }}
        >
          {t("settings.ai.decisions.state.retry")}
        </Button>
      </div>
    );

  const actions = createDecisionsActions({
    api: window.app.ai,
    onStatus: (status) => setState({ phase: "ready", status }),
    onToast,
    onBusy: setBusy,
    onKeyDraft: setKeyDraft,
    onConfirming: setConfirming
  });
  return (
    <DecisionsDeciderView
      t={t}
      status={state.status}
      busy={busy}
      confirming={confirming}
      keyDraft={keyDraft}
      onKeyDraft={setKeyDraft}
      onAskEnable={() => setConfirming(true)}
      onConfirmEnable={() => void actions.enable()}
      onCancelEnable={() => setConfirming(false)}
      onDisable={() => void actions.disable()}
      onSaveKey={() => void actions.saveKey(keyDraft)}
      onRemoveKey={() => void actions.removeKey()}
      onTestKey={() => void actions.testKey()}
    />
  );
}
