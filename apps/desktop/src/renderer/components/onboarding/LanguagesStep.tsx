import { useId } from "react";
import {
  getLanguageDisplayName,
  supportedLanguageCodes,
  type LanguageCode,
  type Translator
} from "@app/i18n";

import { Button } from "../ui/button";
import { Label } from "../ui/label";
import type { OnboardingSnapshot } from "./onboarding-controller";

const selectClass =
  "h-9 min-w-0 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** A language named in itself, so a person who cannot read the current one still finds theirs. */
export function languageName(code: LanguageCode): string {
  const name = getLanguageDisplayName(code, code);
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}

export interface LanguagesStepProps {
  t: Translator;
  languages: OnboardingSnapshot["languages"];
  onLanguage: (language: LanguageCode) => void;
  onContentLanguage: (language: LanguageCode) => void;
  onSubmit: () => void;
}

/** Step 1: the interface language, which the screen follows at once, and the content language. */
export function LanguagesStep({
  t,
  languages,
  onLanguage,
  onContentLanguage,
  onSubmit
}: LanguagesStepProps) {
  const interfaceId = useId();
  const contentId = useId();
  const hintId = useId();
  const saving = languages.save === "saving";
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-sm text-secondary-foreground">{t("onboarding.languages.description")}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={interfaceId}>{t("onboarding.languages.interface")}</Label>
          <select
            id={interfaceId}
            className={selectClass}
            value={languages.language}
            disabled={saving}
            onChange={(event) => onLanguage(event.target.value as LanguageCode)}
          >
            {supportedLanguageCodes.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={contentId}>{t("onboarding.languages.content")}</Label>
          <select
            id={contentId}
            className={selectClass}
            aria-describedby={hintId}
            value={languages.contentLanguage}
            disabled={saving}
            onChange={(event) => onContentLanguage(event.target.value as LanguageCode)}
          >
            {supportedLanguageCodes.map((code) => (
              <option key={code} value={code}>
                {languageName(code)}
              </option>
            ))}
          </select>
          <p id={hintId} className="text-xs text-muted-foreground">
            {t("onboarding.languages.contentHint")}
          </p>
        </div>
      </div>
      {languages.save === "failed" ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {t("onboarding.languages.saveFailed")}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t("onboarding.languages.saving") : t("onboarding.continue")}
        </Button>
      </div>
    </form>
  );
}
