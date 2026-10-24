import { useEffect, useRef, type ReactNode } from "react";
import { CircleCheck, Database, LoaderCircle } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { LanguagesStep } from "./LanguagesStep";
import { ModeStep } from "./ModeStep";
import { SetupStep } from "./SetupStep";
import {
  canStartSetup,
  type OnboardingController,
  type OnboardingPhase,
  type OnboardingSnapshot
} from "./onboarding-controller";

export type OnboardingActions = Pick<
  OnboardingController,
  | "setLanguage"
  | "setContentLanguage"
  | "submitLanguages"
  | "back"
  | "retryCard"
  | "selectPreset"
  | "setWriterMethod"
  | "signInCodex"
  | "setCodexModel"
  | "setKeyProvider"
  | "setKeyField"
  | "setApiKey"
  | "startSetup"
  | "retrySetup"
  | "continueToSource"
  | "skip"
>;

const stepLabels: ReadonlyArray<{ step: 1 | 2 | 3; label: MessageKey }> = [
  { step: 1, label: "onboarding.steps.languages" },
  { step: 2, label: "onboarding.steps.mode" },
  { step: 3, label: "onboarding.steps.source" }
];

const titles: Partial<Record<OnboardingPhase, MessageKey>> = {
  languages: "onboarding.languages.title",
  mode: "onboarding.mode.title",
  testing: "onboarding.setup.title",
  source: "onboarding.source.title"
};

export interface OnboardingViewProps {
  t: Translator;
  snapshot: OnboardingSnapshot;
  actions: OnboardingActions;
  /** The dark theme class, as the app shell sets it. */
  dark: boolean;
  /** Step 3: the import form, which owns its own loading, empty, error and success states. */
  source: ReactNode;
}

/**
 * The first-run view (F4 D31): a full window with three steps, a way out at every one of them and
 * nothing behind it. Props in, callbacks out; the steps are in their own files.
 */
export function OnboardingView({ t, snapshot, actions, dark, source }: OnboardingViewProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const { phase } = snapshot;
  // Each step starts at its title, so a keyboard or screen reader user lands where the step begins.
  useEffect(() => {
    headingRef.current?.focus();
  }, [phase]);
  const titleKey = titles[phase];

  return (
    <div
      // The page may follow another language until the first step is saved: this one marks its own.
      lang={t.locale}
      className={cn(
        "flex h-screen flex-col overflow-hidden bg-background text-foreground",
        dark && "dark"
      )}
    >
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-border bg-surface px-5 py-2">
        <div className="flex items-center gap-2.5">
          <Database className="h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
          <span className="text-sm font-medium">{t("app.title")}</span>
        </div>
        <nav aria-label={t("onboarding.steps.label")} className="min-w-0 flex-1">
          <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {stepLabels.map(({ step, label }) => {
              const current = step === snapshot.step;
              const done = step < snapshot.step;
              return (
                <li
                  key={step}
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5",
                    current ? "font-semibold text-foreground" : "text-muted-foreground"
                  )}
                >
                  {done ? (
                    <CircleCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  ) : (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "grid h-4 w-4 place-items-center rounded-full border text-xs leading-none",
                        current
                          ? "border-accent bg-accent text-accent-foreground"
                          : "border-border-strong"
                      )}
                    >
                      {step}
                    </span>
                  )}
                  {t(label)}
                </li>
              );
            })}
          </ol>
        </nav>
        {phase !== "checking" ? (
          <Button
            type="button"
            variant="ghost"
            disabled={snapshot.skipping}
            onClick={() => void actions.skip()}
          >
            {t(snapshot.skipping ? "onboarding.skipping" : "onboarding.skip")}
          </Button>
        ) : null}
      </header>
      <main className="min-h-0 flex-1 overflow-auto px-5 py-8">
        {phase === "checking" ? (
          <p
            role="status"
            className="mx-auto flex w-full max-w-2xl items-center justify-center gap-2 text-sm text-secondary-foreground"
          >
            <LoaderCircle
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
            {t("onboarding.checking")}
          </p>
        ) : (
          <div className="mx-auto grid w-full max-w-2xl gap-5">
            {titleKey ? (
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-xl font-semibold text-foreground focus:outline-none"
              >
                {t(titleKey)}
              </h1>
            ) : null}
            {phase === "languages" ? (
              <LanguagesStep
                t={t}
                languages={snapshot.languages}
                onLanguage={(language) => actions.setLanguage(language)}
                onContentLanguage={(language) => actions.setContentLanguage(language)}
                onSubmit={() => void actions.submitLanguages()}
              />
            ) : phase === "mode" ? (
              <ModeStep
                t={t}
                mode={snapshot.mode}
                canStart={canStartSetup(snapshot)}
                actions={actions}
              />
            ) : phase === "testing" ? (
              <SetupStep t={t} setup={snapshot.setup} actions={actions} />
            ) : phase === "source" ? (
              <div className="grid gap-4">
                <p className="text-sm text-secondary-foreground">
                  {t("onboarding.source.description")}
                </p>
                {source}
              </div>
            ) : null}
          </div>
        )}
      </main>
      <p role="status" aria-live="polite" className="sr-only">
        {snapshot.announcement
          ? t(snapshot.announcement.message.key, {
              ...(snapshot.announcement.message.values
                ? { values: snapshot.announcement.message.values }
                : {})
            })
          : ""}
      </p>
    </div>
  );
}
