import { useCallback, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "../../lib/cn";

export type ToastTone = "success" | "error" | "info";

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

export const maxVisibleToasts = 4;
export const toastAutoDismissMs = 4_000;

export function addToast(toasts: ToastItem[], toast: ToastItem): ToastItem[] {
  return [...toasts, toast].slice(-maxVisibleToasts);
}

export function removeToast(toasts: ToastItem[], id: number): ToastItem[] {
  return toasts.filter((toast) => toast.id !== id);
}

export interface ToastController {
  toasts: ToastItem[];
  push: (text: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

export function useToasts(): ToastController {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => removeToast(current, id));
  }, []);

  const push = useCallback((text: string, tone: ToastTone = "info") => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setToasts((current) => addToast(current, { id, text, tone }));
    setTimeout(() => dismiss(id), toastAutoDismissMs);
  }, [dismiss]);

  return { toasts, push, dismiss };
}

const toneStyles: Record<ToastTone, { container: string; icon: typeof Info }> = {
  success: {
    container: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
    icon: CheckCircle2
  },
  error: {
    container: "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100",
    icon: AlertTriangle
  },
  info: {
    container: "border-slate-300 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
    icon: Info
  }
};

export function ToastViewport({ toasts, dismissLabel, onDismiss }: {
  toasts: ToastItem[];
  dismissLabel: string;
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] grid w-80 gap-2">
      {toasts.map((toast) => {
        const tone = toneStyles[toast.tone];
        const Icon = tone.icon;
        return (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            className={cn(
              "motion-toast-in pointer-events-auto flex items-start gap-3 rounded-xl border p-3 shadow-lg shadow-slate-950/10 backdrop-blur",
              tone.container
            )}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-sm leading-5">{toast.text}</p>
            <button
              type="button"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-md opacity-70 transition hover:opacity-100"
              aria-label={dismissLabel}
              title={dismissLabel}
              onClick={() => onDismiss(toast.id)}
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
