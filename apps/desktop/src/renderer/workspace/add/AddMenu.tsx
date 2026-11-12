import { useState } from "react";
import { ChevronDown, FileText, Link2, PenLine, Plus, SlidersHorizontal } from "lucide-react";
import type { Translator } from "@app/i18n";

import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../../components/ui/dropdown-menu";
import { RunningRing, SolidTriangle } from "../../components/ui/solid-glyphs";
import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/cn";
import type { AddFlow, AddFlowSnapshot } from "./add-flow";
import {
  addEntryKeys,
  addMenuEntries,
  importModes,
  isImportMode,
  modeCopy,
  type AddMenuEntryId
} from "./add-model";
import { useAddFlowSnapshot } from "./use-add-flow";

/**
 * The state this surface reports on its frame (`data-state`): something is being read, an add or the
 * mode failed, no model is ready to write (the default mode steps down), or all is well.
 */
export function addMenuState(
  snapshot: Pick<AddFlowSnapshot, "busy" | "failure" | "readiness">
): "loading" | "empty" | "error" | "success" {
  if (snapshot.failure || snapshot.readiness.status === "error") return "error";
  if (snapshot.busy || snapshot.readiness.status === "loading") return "loading";
  return snapshot.readiness.status === "ready" && !snapshot.readiness.writer ? "empty" : "success";
}

const entryIcons: Record<AddMenuEntryId, typeof FileText> = {
  file: FileText,
  link: Link2,
  note: PenLine
};

/**
 * Adicionar, the split button of the title bar (design record 5.2). The main part opens the file
 * picker (so does Cmd-N); the chevron opens the menu of the other ways: a link, a note, the import
 * mode and the advanced import panel. While a file is being read the main part says so; a file that
 * could not be added is told by `AddFailureNotice` in the status slot beside it. There is no modal
 * and no toast.
 */
export function AddMenu({
  t,
  flow,
  portal = true,
  openMenu = false
}: {
  t: Translator;
  flow: AddFlow;
  /** Screens render the menu in place (`portal={false}`) and may hold it open. */
  portal?: boolean;
  openMenu?: boolean;
}) {
  const snapshot = useAddFlowSnapshot(flow);
  const [open, setOpen] = useState(openMenu);
  const { busy, readiness, mode } = snapshot;
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void flow.refreshReadiness();
  };
  const addLabel = t("workspace.titleBar.addSource");

  return (
    <div
      data-surface="add-menu"
      data-state={addMenuState(snapshot)}
      className="relative inline-flex shrink-0"
    >
      <div
        className={cn(
          "inline-flex h-8 shrink-0 items-stretch rounded-lg border border-border-strong bg-surface",
          "text-sm font-medium text-foreground"
        )}
      >
        <Tooltip label={addLabel} shortcut="⌘N">
          <button
            type="button"
            aria-label={busy ? t("addFlow.busy.readingFile") : addLabel}
            aria-keyshortcuts="Meta+N"
            aria-busy={busy ? true : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-l-lg px-3 transition-colors hover:bg-surface-hover",
              // Each part keeps its own ring inside its own half, so the divider is never covered.
              "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
              busy && "cursor-progress"
            )}
            onClick={() => void flow.pickFile()}
          >
            {busy ? (
              <RunningRing className="size-4" />
            ) : (
              <Plus aria-hidden="true" className="size-4" />
            )}
            {busy ? t("addFlow.busy.button") : t("workspace.titleBar.add")}
          </button>
        </Tooltip>
        <DropdownMenu open={open} onOpenChange={onOpenChange} modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t("workspace.titleBar.addMore")}
              className={cn(
                "inline-flex w-6 items-center justify-center rounded-r-lg border-l border-border",
                "text-secondary-foreground transition-colors hover:bg-surface-hover",
                "data-[state=open]:bg-accent-soft data-[state=open]:text-accent",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              )}
            >
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            portal={portal}
            aria-label={t("addFlow.menu.label")}
            className="w-90 max-w-[calc(100vw-1rem)]"
          >
            {addMenuEntries.map((entry) => {
              const Icon = entryIcons[entry.id];
              const keys = addEntryKeys[entry.id];
              return (
                <DropdownMenuItem
                  key={entry.id}
                  icon={<Icon />}
                  description={t(keys.hint)}
                  {...("shortcut" in entry ? { shortcut: entry.shortcut } : {})}
                  onSelect={() =>
                    entry.action === "pickFile" ? void flow.pickFile() : flow.openImportPanel()
                  }
                >
                  {t(keys.label)}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("addFlow.menu.modeHeading")}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              // While the first read is out and nothing was chosen, no mode is marked: the default
              // would flip under the cursor when the answer comes.
              value={readiness.status === "loading" && snapshot.chosen === null ? "" : mode}
              onValueChange={(value) => {
                if (isImportMode(value)) flow.chooseMode(value);
              }}
            >
              {importModes.map((candidate) => {
                const copy = modeCopy(candidate, readiness);
                return (
                  <DropdownMenuRadioItem
                    key={candidate}
                    value={candidate}
                    // A mode is a setting: choosing one keeps the menu open so the choice is seen.
                    onSelect={(event) => event.preventDefault()}
                    description={
                      candidate === "secondBrain" && readiness.status === "loading" ? (
                        <>
                          {t(copy.hint)}
                          <Skeleton className="mt-1.5 w-3/5" />
                        </>
                      ) : (
                        t(copy.hint)
                      )
                    }
                  >
                    {t(copy.name)}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
            {readiness.status === "error" ? (
              <ModesNotice t={t} onRetry={() => void flow.retryReadiness()} />
            ) : null}
            <p className="m-0 px-2 pb-1 pt-2 text-xs text-muted-foreground [text-wrap:pretty]">
              {t("addFlow.menu.foot")}
            </p>
            <DropdownMenuSeparator />
            <DropdownMenuItem icon={<SlidersHorizontal />} onSelect={() => flow.openImportPanel()}>
              {t("addFlow.menu.more")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {busy
          ? [
              busy.name
                ? t("addFlow.busy.reading", { values: { name: busy.name } })
                : t("addFlow.busy.readingFile"),
              busy.waiting > 0 ? t("addFlow.busy.waiting", { values: { count: busy.waiting } }) : ""
            ]
              .filter(Boolean)
              .join(" ")
          : ""}
      </span>
      {busy && busy.waiting > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-0 top-full mt-1 whitespace-nowrap text-xs text-muted-foreground"
        >
          {t("addFlow.busy.waiting", { values: { count: busy.waiting } })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The mode group could not read whether a model can write: one sentence at the size of the rows'
 * descriptions, what still works, and a link to read again. The menu keeps working, so this is the
 * quietest thing in it.
 */
function ModesNotice({ t, onRetry }: { t: Translator; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="mx-2 mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs"
    >
      <SolidTriangle className="mt-px size-3.5 text-danger" />
      <p className="m-0 min-w-0 text-secondary-foreground [text-wrap:pretty]">
        {t("addFlow.modes.error")}{" "}
        <span className="text-muted-foreground">{t("addFlow.modes.errorKept")}</span>
      </p>
      <Button variant="link" className="col-start-2 -ml-3 w-fit" onClick={onRetry}>
        {t("shell.actions.retry")}
      </Button>
    </div>
  );
}
