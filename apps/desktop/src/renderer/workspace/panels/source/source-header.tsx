import type { RefObject } from "react";
import { ArrowLeft, ChevronRight, ExternalLink, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { SourceDetail } from "../../../../shared/ipc";
import { Button } from "../../../components/ui/button";
import { CoverImage } from "../../../components/ui/cover-image";
import { childSourceType } from "../../../components/ImportView";
import { coverAssetIdFromMetadata } from "../../../lib/cover-cache";
import { SourceTypeBadge, typeIcons } from "./source-parts";

/** The path from the Library to this source, as the breadcrumb of the Source page. */
export function SourceBreadcrumb({
  chain,
  t,
  onGoToLibrary,
  onOpenPath
}: {
  chain: Array<{ id: string; title: string }>;
  t: Translator;
  onGoToLibrary: () => void;
  onOpenPath: (ids: string[]) => void;
}) {
  return (
    <nav
      className="flex flex-wrap items-center gap-1 text-sm text-slate-500"
      aria-label={t("shell.navigation.library")}
    >
      <button
        type="button"
        className="rounded-md px-1.5 py-0.5 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-900 dark:hover:text-slate-100"
        onClick={onGoToLibrary}
      >
        {t("shell.navigation.library")}
      </button>
      {chain.map((ancestor, index) => (
        <span key={ancestor.id} className="inline-flex items-center gap-1">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          {index === chain.length - 1 ? (
            <span className="max-w-64 truncate font-medium text-slate-900 dark:text-slate-100">
              {ancestor.title}
            </span>
          ) : (
            <button
              type="button"
              className="max-w-56 truncate rounded-md px-1.5 py-0.5 transition hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-900 dark:hover:text-slate-100"
              onClick={() => onOpenPath(chain.slice(0, index + 1).map((item) => item.id))}
            >
              {ancestor.title}
            </button>
          )}
        </span>
      ))}
    </nav>
  );
}

/** The title card of a source: cover, type, language, original link and the page's actions. */
export function SourceHeader({
  detail,
  headingRef,
  deleting,
  deleteFailed,
  backLabel,
  t,
  onEdit,
  onAddChild,
  onProcess,
  onDelete,
  onBack
}: {
  detail: SourceDetail;
  headingRef: RefObject<HTMLHeadingElement | null>;
  deleting: boolean;
  deleteFailed: boolean;
  backLabel: string;
  t: Translator;
  onEdit: () => void;
  onAddChild: () => void;
  onProcess: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const coverAssetId =
    coverAssetIdFromMetadata(detail.metadata) ??
    detail.assets.find((asset) => asset.role === "cover")?.id ??
    null;
  const Icon = typeIcons[detail.type];
  return (
    <>
      <header className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex min-w-0 flex-1 items-start gap-4">
          <div className="grid h-36 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-950">
            <CoverImage
              assetId={coverAssetId}
              alt={detail.title}
              fallback={<Icon className="h-10 w-10 text-slate-400" aria-hidden="true" />}
            />
          </div>
          <div className="min-w-0">
            <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold leading-tight">
              {detail.title}
            </h2>
            {detail.subtitle ? (
              <p className="mt-1 text-sm text-slate-500">{detail.subtitle}</p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <SourceTypeBadge type={detail.type} t={t} />
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide dark:bg-slate-800">
                {detail.language}
              </span>
              {detail.sourceUri ? (
                <a
                  href={detail.sourceUri}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-cyan-700 hover:underline dark:text-cyan-300"
                >
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("library.openOriginal")}
                </a>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          <Button type="button" disabled={deleting} onClick={onEdit}>
            <Pencil className="h-4 w-4" />
            {t("sourcePage.edit")}
          </Button>
          {childSourceType(detail.type) ? (
            <Button type="button" onClick={onAddChild}>
              <Plus className="h-4 w-4" />
              {t("sourceWorkspace.addChild")}
            </Button>
          ) : null}
          <Button type="button" disabled={deleting} onClick={onProcess}>
            <Play className="h-4 w-4" aria-hidden="true" />
            {t("library.actions.process")}
          </Button>
          <Button type="button" disabled={deleting} variant="danger" onClick={onDelete}>
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            {deleting ? t("library.delete.deleting") : t("library.delete.action")}
          </Button>
          <Button type="button" disabled={deleting} onClick={onBack}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {backLabel}
          </Button>
        </div>
      </header>

      {deleteFailed ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
        >
          {t("library.delete.failed")}
        </p>
      ) : null}
    </>
  );
}
