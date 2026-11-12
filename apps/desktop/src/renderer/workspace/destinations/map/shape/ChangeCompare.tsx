import type { Translator } from "@app/i18n";

import { Button } from "../../../../components/ui/button";
import type { ChangeDetail } from "./shape-controller";
import { compareView } from "./shape-model";

export const compareRegionId = (changeSetId: string): string => `shape-compare-${changeSetId}`;

/** "See before and after" / "Hide before and after": a disclosure over the region below it. */
export function CompareToggle({
  t,
  changeSetId,
  open,
  onToggle
}: {
  t: Translator;
  changeSetId: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant="link"
      aria-expanded={open}
      aria-controls={compareRegionId(changeSetId)}
      onClick={onToggle}
    >
      {open ? t("topics.shape.compare.hide") : t("topics.shape.compare.show")}
    </Button>
  );
}

/** The textual before and after of one change-set; nothing while the disclosure is closed. */
export function CompareRegion({
  t,
  changeSetId,
  detail,
  onRetry
}: {
  t: Translator;
  changeSetId: string;
  detail: ChangeDetail | undefined;
  onRetry: () => void;
}) {
  if (detail === undefined) return null;
  const id = compareRegionId(changeSetId);
  if (detail.status === "loading")
    return (
      <p id={id} role="status" className="text-xs text-muted-foreground">
        {t("topics.shape.compare.loading")}
      </p>
    );
  if (detail.status === "missing")
    return (
      <p id={id} role="status" className="text-xs text-muted-foreground">
        {t("topics.shape.compare.missing")}
      </p>
    );
  if (detail.status === "error")
    return (
      <div id={id} role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
        <p>{t("topics.shape.compare.error")}</p>
        <Button type="button" onClick={onRetry}>
          {t("shell.actions.retry")}
        </Button>
      </div>
    );
  const view = compareView(t, detail.changeSet);
  const sides = [
    { id: "before", title: t("topics.shape.compare.before"), lines: view.before },
    { id: "after", title: t("topics.shape.compare.after"), lines: view.after }
  ] as const;
  return (
    <div id={id} className="flex flex-col gap-2 rounded-md bg-soft p-3 text-xs">
      <div className="grid gap-3 sm:grid-cols-2">
        {sides.map((side) => (
          <section key={side.id} className="flex min-w-0 flex-col gap-1">
            <h4 className="font-semibold text-secondary-foreground">{side.title}</h4>
            {side.lines.length === 0 ? (
              <p className="text-muted-foreground">{t("topics.shape.compare.none")}</p>
            ) : (
              <ul className="flex flex-col gap-1 text-foreground">
                {side.lines.map((line) => (
                  <li key={line.key} className="[overflow-wrap:anywhere]">
                    {line.text}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      {view.partial ? (
        <p className="text-muted-foreground">{t("topics.shape.compare.partial")}</p>
      ) : null}
    </div>
  );
}
