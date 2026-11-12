import { useEffect } from "react";
import { Upload } from "lucide-react";
import type { Translator } from "@app/i18n";

import { Skeleton } from "../../components/ui/skeleton";
import { SolidTriangle } from "../../components/ui/solid-glyphs";
import { cn } from "../../lib/cn";
import { modeCopy, modeHintKey, type ImportMode, type Readiness } from "./add-model";
import type { AddFlow } from "./add-flow";
import { useAddFlowSnapshot } from "./use-add-flow";
import { useWindowDrop } from "./use-window-drop";

/** The state this surface reports: the mode it will import with is being read, unreadable, or known. */
export function dropOverlayState(readiness: Readiness): "loading" | "empty" | "error" | "success" {
  if (readiness.status === "loading") return "loading";
  if (readiness.status === "error") return "error";
  return readiness.writer ? "success" : "empty";
}

/**
 * Files over the window (design record 7.7, `#drop`): a dashed accent frame around the window and a
 * card in the middle that says how many files, the mode they will be imported with and where the
 * person lands. The browser hides the names until the drop, so the card counts. It is not
 * interactive and never takes the drop itself: the window does (`useWindowDrop`).
 */
export function DropOverlay({
  t,
  count,
  mode,
  readiness
}: {
  t: Translator;
  /** The files in the drag; 0 when the browser does not say. */
  count: number;
  mode: ImportMode;
  readiness: Readiness;
}) {
  const copy = modeCopy(mode, { status: "loading" });
  const title =
    count === 0
      ? t("addFlow.drop.noFiles")
      : count === 1
        ? t("addFlow.drop.titleOne")
        : t("addFlow.drop.titleMany", { values: { count } });
  return (
    <div
      data-surface="drop-overlay"
      data-state={dropOverlayState(readiness)}
      role="presentation"
      aria-label={t("addFlow.drop.label")}
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center",
        "bg-background/70 p-4"
      )}
    >
      <div
        aria-hidden="true"
        className="absolute inset-3 rounded-2xl border-2 border-dashed border-accent"
      />
      <div
        role="status"
        className={cn(
          "relative grid w-[min(28rem,100%)] justify-items-center gap-3 rounded-2xl bg-surface",
          "px-6 py-7 text-center text-foreground shadow-[var(--shadow-pop)]"
        )}
      >
        <span
          aria-hidden="true"
          className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent"
        >
          <Upload className="size-5" />
        </span>
        <p className="m-0 font-reading text-lg font-semibold [text-wrap:balance]">{title}</p>
        {readiness.status === "loading" ? (
          <div className="grid w-full justify-items-center gap-2" aria-hidden="true">
            <Skeleton className="w-2/5" />
            <Skeleton className="w-4/5" />
          </div>
        ) : readiness.status === "error" ? (
          <p className="m-0 inline-flex max-w-prose items-start gap-2 text-left text-sm text-secondary-foreground [text-wrap:pretty]">
            <SolidTriangle className="mt-0.5 text-danger" />
            {t("addFlow.drop.modeError")}
          </p>
        ) : (
          <div className="grid gap-1 text-sm text-secondary-foreground [text-wrap:pretty]">
            <p className="m-0">
              {t("addFlow.drop.modeLabel")}{" "}
              <strong className="font-semibold text-foreground">{t(copy.name)}</strong>
            </p>
            <p className="m-0 first-letter:uppercase">
              {t("addFlow.drop.modeNote", { values: { hint: t(modeHintKey(mode)) } })}
            </p>
          </div>
        )}
        <p className="m-0 max-w-prose text-xs text-muted-foreground [text-wrap:pretty]">
          {t("addFlow.drop.after")}
        </p>
      </div>
    </div>
  );
}

/**
 * The window's drop (D32): while files are over the window the overlay shows; on the drop they are
 * imported at once with the current mode. Mounted once, by the shell.
 */
export function DropHost({ t, flow }: { t: Translator; flow: AddFlow }) {
  const drag = useWindowDrop((files) => void flow.importDropped(files));
  const snapshot = useAddFlowSnapshot(flow);
  useEffect(() => {
    if (drag.active) void flow.ensureReadiness();
  }, [drag.active, flow]);
  if (!drag.active) return null;
  return (
    <DropOverlay t={t} count={drag.count} mode={snapshot.mode} readiness={snapshot.readiness} />
  );
}
