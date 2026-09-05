import { Cpu, LoaderCircle } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { LocalEmbeddingLoadStatus } from "../../shared/ipc";

export function LocalEmbeddingLoadDialog({
  status,
  t
}: {
  status: LocalEmbeddingLoadStatus | null;
  t: (key: MessageKey) => string;
}) {
  if (status?.state !== "loading") return null;

  return <div
    role="dialog"
    aria-modal="true"
    aria-live="assertive"
    aria-busy="true"
    aria-labelledby="local-embedding-load-title"
    aria-describedby="local-embedding-load-description"
    className="fixed inset-0 z-[70] grid place-items-center bg-slate-950/65 p-5 backdrop-blur-sm"
  >
    <section className="relative w-full max-w-md overflow-hidden rounded-3xl border border-cyan-300/60 bg-white p-7 text-center shadow-2xl dark:border-cyan-800 dark:bg-slate-950">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-1 animate-pulse bg-gradient-to-r from-cyan-500 via-violet-500 to-cyan-500" />
      <div className="relative mx-auto grid h-20 w-20 place-items-center">
        <span className="absolute inset-1 animate-ping rounded-full bg-cyan-400/20" />
        <span className="grid h-16 w-16 place-items-center rounded-2xl bg-cyan-100 text-cyan-800 shadow-inner dark:bg-cyan-950 dark:text-cyan-200">
          <Cpu className="h-7 w-7" aria-hidden="true" />
        </span>
        <LoaderCircle className="absolute h-20 w-20 animate-spin text-violet-500" aria-hidden="true" />
      </div>
      <h2 id="local-embedding-load-title" className="mt-5 text-lg font-semibold text-slate-950 dark:text-white">
        {t("search.localEmbeddingLoading.title")}
      </h2>
      <p id="local-embedding-load-description" className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
        {t("search.localEmbeddingLoading.description")}
      </p>
      <p className="mx-auto mt-4 max-w-full truncate rounded-full bg-slate-100 px-3 py-1.5 font-mono text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">
        {status.modelId}
      </p>
      <div className="mt-5 h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className="h-full w-2/3 animate-pulse rounded-full bg-gradient-to-r from-cyan-600 to-violet-500" />
      </div>
    </section>
  </div>;
}
