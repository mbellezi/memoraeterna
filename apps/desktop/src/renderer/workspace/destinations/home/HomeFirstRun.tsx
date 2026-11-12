import { FilePlus2, ShieldCheck } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { Kbd } from "../../../components/ui/kbd";
import { slotted, slotValues } from "./home-text";

const steps = [
  { title: "home.firstRun.stepRead", hint: "home.firstRun.stepReadHint" },
  { title: "home.firstRun.stepNotes", hint: null },
  { title: "home.firstRun.stepPlace", hint: null },
  { title: "home.firstRun.stepGardener", hint: "home.firstRun.stepGardenerHint" }
] as const satisfies readonly { title: MessageKey; hint: MessageKey | null }[];

const promises = [
  "home.firstRun.promiseLocal",
  "home.firstRun.promiseUndo",
  "home.firstRun.promiseSetup"
] as const satisfies readonly MessageKey[];

/**
 * Home on first run (design record §7.7 `#empty`): what this place is, the one thing to do (add the
 * first source), what happens after and what Memora promises. It teaches; it never looks like a
 * loading screen, and the only filled button on it is the action. The step line and the drop zone's
 * other ways in belong to the Add flow (T150).
 */
export function HomeFirstRun({ t, onAdd }: { t: Translator; onAdd?: (() => void) | undefined }) {
  return (
    <div className="grid min-w-0 gap-8">
      <EmptyState
        variant="page"
        className="max-w-3xl"
        icon={<FilePlus2 aria-hidden="true" />}
        headline={t("home.firstRun.headline")}
        action={
          <>
            <Button variant="primary" onClick={onAdd} disabled={!onAdd}>
              <FilePlus2 aria-hidden="true" />
              {t("home.firstRun.add")}
            </Button>
            <span className="text-sm text-muted-foreground">
              {slotted(t("home.firstRun.hint", { values: slotValues("key") }), {
                key: <Kbd>⌘N</Kbd>
              })}
            </span>
          </>
        }
      >
        <p className="m-0 font-reading text-lg text-foreground [text-wrap:pretty]">
          {t("home.firstRun.lead")}
        </p>
        <p className="mb-0 mt-3 [text-wrap:pretty]">{t("home.firstRun.next")}</p>
      </EmptyState>
      <div className="grid min-w-0 max-w-3xl gap-8 [grid-template-columns:repeat(auto-fit,minmax(18rem,1fr))]">
        <section aria-labelledby="home-steps" className="grid min-w-0 content-start gap-3">
          <h3 id="home-steps" className="m-0 text-base font-semibold text-foreground">
            {t("home.firstRun.stepsTitle")}
          </h3>
          <ol className="relative m-0 grid list-none gap-4 p-0 before:absolute before:bottom-2 before:left-[3.5px] before:top-2 before:w-px before:bg-[var(--thread)]">
            {steps.map((step) => (
              <li key={step.title} className="relative grid gap-0.5 pl-5">
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-[0.4rem] size-2 rounded-full border border-border-strong bg-background"
                />
                <span className="text-sm text-foreground [text-wrap:pretty]">{t(step.title)}</span>
                {step.hint ? (
                  <span className="text-xs text-muted-foreground [text-wrap:pretty]">
                    {t(step.hint)}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
        <section aria-labelledby="home-promises" className="grid min-w-0 content-start gap-3">
          <h3 id="home-promises" className="m-0 text-base font-semibold text-foreground">
            {t("home.firstRun.promisesTitle")}
          </h3>
          <ul className="m-0 grid list-none gap-3 p-0">
            {promises.map((promise) => (
              <li
                key={promise}
                className="flex items-start gap-2 text-sm text-secondary-foreground [text-wrap:pretty]"
              >
                <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                {t(promise)}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
