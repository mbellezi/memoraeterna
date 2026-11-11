import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createTranslator, type LanguageCode, type MessageKey } from "@app/i18n";

import type { AppSettings, DesktopApi } from "../../../shared/ipc";
import { onboardingHardwareOf } from "../../../shared/onboarding";
import { ImportView } from "../ImportView";
import { OnboardingController, type OnboardingApi } from "./onboarding-controller";
import { OnboardingView } from "./OnboardingView";

export interface FirstRunOptions {
  /** False while the app is still starting, or in a test of the shell: nothing is asked then. */
  enabled: boolean;
  language: LanguageCode;
  contentLanguage: LanguageCode;
  dark: boolean;
  metadataEnrichmentEnabled: boolean;
  /** The settings the first step stored: the app shows the chosen interface language from then on. */
  onSettings: (saved: AppSettings) => void;
  /**
   * The first source was chosen (D9, A6): the app goes to Explore with that Source pushed, so the
   * navigator shows the tree being born, and tells how the import went.
   */
  onFirstSource: (sourceItemId: string, status?: MessageKey) => void;
}

/**
 * What the first run calls of the preload: the app's API, with T97's `hardware.profile` answer read
 * as the tier card's facts (the one place the two shapes meet).
 */
export function onboardingApiOf(app: DesktopApi): OnboardingApi {
  return {
    onAppEvent: (type, handler) => app.onAppEvent(type, handler),
    onboarding: app.onboarding,
    settings: app.settings,
    hardware: { profile: async () => onboardingHardwareOf(await app.hardware.profile()) },
    localModels: app.localModels,
    ai: app.ai
  };
}

/**
 * The first-run branch of the app (F4 D31): the screen to show instead of the shell while the
 * first run is being checked or is due, and `null` when the shell shows (it is not due, it was
 * finished or skipped, or the question failed, which never hides the app).
 */
export function useFirstRun(options: FirstRunOptions): ReactNode {
  const { enabled, language, contentLanguage, onSettings, onFirstSource } = options;
  const [controller] = useState(
    () =>
      new OnboardingController({
        api: () => onboardingApiOf(window.app),
        initial: () => ({ language: "en", contentLanguage: "en" }),
        names: () => ({ profile: "", codexProvider: "" })
      })
  );
  // What the first run reads from the app is bound before it starts (effects run in order) and
  // again whenever the app changes it, so the controller never holds an older language or callback.
  useEffect(() => {
    controller.bind({
      initial: () => ({ language, contentLanguage }),
      names: () => {
        const t = createTranslator(language);
        return {
          profile: t("onboarding.setup.steps.writer"),
          codexProvider: t("settings.ai.openAiCodex")
        };
      },
      onSettings
    });
  }, [controller, language, contentLanguage, onSettings]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  useEffect(() => {
    if (!enabled) return;
    void controller.start();
    return () => controller.dispose();
  }, [controller, enabled]);

  const t = useMemo(
    () => createTranslator(snapshot.languages.language),
    [snapshot.languages.language]
  );
  const openedSourceId = snapshot.phase === "done" ? snapshot.openedSourceId : null;
  const openedStatus = snapshot.openedStatus;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (openedSourceId && opened.current !== openedSourceId) {
      opened.current = openedSourceId;
      onFirstSource(openedSourceId, openedStatus ?? undefined);
    }
  }, [openedSourceId, openedStatus, onFirstSource]);

  if (!enabled || snapshot.phase === "off" || snapshot.phase === "done") return null;
  return (
    <OnboardingView
      t={t}
      snapshot={snapshot}
      actions={controller}
      dark={options.dark}
      source={
        <ImportView
          t={t}
          metadataEnrichmentEnabled={options.metadataEnrichmentEnabled}
          onSaved={(sourceItemId, status) => void controller.sourceSaved(sourceItemId, status)}
        />
      }
    />
  );
}
