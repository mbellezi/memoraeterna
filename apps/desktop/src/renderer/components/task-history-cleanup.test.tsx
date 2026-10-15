import { it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createTranslator } from "@app/i18n";
import { JobsView } from "./JobsView";
import { TaskHistoryCleanup } from "./TaskHistoryCleanup";

it.each(["en", "pt-BR", "es", "fr", "it"] as const)(
  "offers to clear the finished job history with its hint in %s",
  (locale) => {
    const t = createTranslator(locale);
    const html = renderToString(<TaskHistoryCleanup t={t} onCleared={async () => {}} />);
    expect(html).toContain(t("automation.clearHistory"));
    expect(html).toContain(t("automation.clearHistoryHint"));
    expect(html).not.toContain("[[missing:");
  }
);

it("is part of the Jobs view, now that no Automation panel shows it", () => {
  const t = createTranslator("en");
  expect(renderToString(<JobsView t={t} />)).toContain(t("automation.clearHistory"));
});
