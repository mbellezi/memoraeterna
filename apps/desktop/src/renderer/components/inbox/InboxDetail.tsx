import type { Ref } from "react";
import { Undo2, X } from "lucide-react";
import type { InboxItem, InboxObject, InboxVerb } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { InboxDiff } from "./InboxDiff";
import { kindIcon, RiskMark } from "./inbox-marks";
import {
  ageText,
  itemBody,
  itemHint,
  itemTitle,
  kindLabels,
  objectName,
  verbLabel
} from "./inbox-model";
import { keyHint } from "./inbox-keys";
import { type InboxDiffLoad, type InboxItemAction, type InboxUndo } from "./inbox-state";
import { relationTypeView } from "../../lib/relation-stance";

export interface InboxDetailProps {
  t: Translator;
  item: InboxItem | null;
  action: InboxItemAction | undefined;
  diff: InboxDiffLoad | undefined;
  now: number;
  /** The region itself takes the focus on Enter from the list. */
  regionRef: Ref<HTMLElement>;
  onVerb: (verb: InboxVerb) => void;
  onOpenObject: (object: InboxObject) => void;
  onOpenSettings: () => void;
  onRetryDiff: () => void;
}

/**
 * The selected item: what it is, which objects it names (each a button that opens it), the verbs it
 * offers with the key that carries each one, and, for a change that waits for review, what it
 * would change. A refusal stays beside the verbs, as text.
 */
export function InboxDetail({
  t,
  item,
  action,
  diff,
  now,
  regionRef,
  onVerb,
  onOpenObject,
  onOpenSettings,
  onRetryDiff
}: InboxDetailProps) {
  if (!item)
    return (
      <section
        ref={regionRef}
        tabIndex={-1}
        aria-label={t("inbox.detail.empty")}
        className="flex min-h-0 flex-col justify-center rounded-lg border border-border bg-surface p-5 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <p className="text-sm text-muted-foreground">{t("inbox.detail.empty")}</p>
      </section>
    );
  const Icon = kindIcon[item.kind];
  const hint = itemHint(t, item);
  const pending = action?.status === "pending";
  const relationType =
    typeof item.params.relationType === "string" ? item.params.relationType : null;
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label={itemTitle(t, item)}
      className="flex min-h-0 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <RiskMark t={t} risk={item.risk} />
          <span className="inline-flex items-center gap-1 text-xs text-secondary-foreground">
            <Icon className="size-3.5" aria-hidden="true" />
            {t(kindLabels[item.kind])}
          </span>
          <span className="text-xs text-muted-foreground">{ageText(t, item.at, now)}</span>
        </div>
        <h2 className="text-lg font-semibold text-foreground [overflow-wrap:anywhere]">
          {itemTitle(t, item)}
        </h2>
        <p className="text-sm text-secondary-foreground [overflow-wrap:anywhere]">
          {itemBody(t, item)}
        </p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {relationType ? (
          <p className="text-xs text-muted-foreground">
            {t("inbox.detail.connection", {
              values: { type: t(relationTypeView(relationType).wordKey) }
            })}
          </p>
        ) : null}
      </header>

      {item.objects.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-secondary-foreground">
            {t("inbox.detail.involves")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {item.objects.map((object) => {
              const name = objectName(t, object);
              return (
                <li key={`${object.kind}:${object.id}`}>
                  <Button
                    type="button"
                    variant="link"
                    aria-label={t("inbox.detail.open", { values: { name } })}
                    onClick={() => onOpenObject(object)}
                  >
                    {name}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {item.actions.map((verb) => {
          const hint = keyHint(item, verb);
          return (
            <Button
              key={verb}
              type="button"
              variant={verb === "apply" || verb === "retry" ? "primary" : "secondary"}
              disabled={pending}
              aria-keyshortcuts={hint?.shortcut}
              onClick={() => onVerb(verb)}
            >
              {pending && action.verb === verb
                ? t("inbox.detail.working")
                : verbLabel(t, item.kind, verb, item.variant)}
              {hint ? (
                <kbd
                  aria-hidden="true"
                  className="ml-1 rounded-sm border border-border-strong px-1 font-sans text-xs font-medium"
                >
                  {hint.label}
                </kbd>
              ) : null}
            </Button>
          );
        })}
        {item.kind === "obsidian_conflict" ? (
          <Button type="button" variant="primary" onClick={onOpenSettings}>
            {t("inbox.detail.openSettings")}
          </Button>
        ) : null}
      </div>
      {action?.status === "refused" ? (
        <p role="alert" className="text-xs text-danger">
          {t(action.message, action.params ? { values: action.params } : undefined)}
        </p>
      ) : null}

      {item.changeSet ? (
        <InboxDiff
          t={t}
          load={diff}
          onRetry={onRetryDiff}
          onOpenTopic={(id) => onOpenObject({ kind: "topic", id, title: null })}
        />
      ) : null}
    </section>
  );
}

/** The last verb that can be taken back: always reachable, until the next verb replaces it. */
export function UndoBanner({
  t,
  undo,
  onUndo,
  onHide
}: {
  t: Translator;
  undo: InboxUndo;
  onUndo: () => void;
  onHide: () => void;
}) {
  const pending = undo.status === "pending";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-soft px-3 py-2 text-sm text-foreground"
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {t(undo.message, { values: undo.params })}
      </span>
      <Button type="button" disabled={pending} aria-keyshortcuts="U" onClick={onUndo}>
        <Undo2 aria-hidden="true" />
        {pending ? t("inbox.detail.working") : t("inbox.undo.action")}
        <span className="text-muted-foreground">{t("inbox.undo.hint")}</span>
      </Button>
      <Button type="button" variant="ghost" aria-label={t("inbox.undo.hide")} onClick={onHide}>
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}
