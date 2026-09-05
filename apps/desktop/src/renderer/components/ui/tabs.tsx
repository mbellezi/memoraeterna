import { useId, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export function Tabs<T extends string>({ label, value, onChange, items, children, actions }: {
  label: string; value: T; onChange: (value: T) => void;
  items: Array<{ id: T; label: string; count?: number }>; children: ReactNode; actions?: ReactNode;
}) {
  const id = useId();
  return <div className="grid min-w-0 gap-4">
    <div className="flex min-w-0 items-center gap-2 border-b border-slate-200 dark:border-slate-800">
    <div role="tablist" aria-label={label} className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
      {items.map((item, index) => <button key={item.id} type="button" role="tab"
        id={`${id}-${item.id}`} aria-controls={`${id}-panel`} aria-selected={value === item.id}
        tabIndex={value === item.id ? 0 : -1} onClick={() => onChange(item.id)}
        onKeyDown={(event) => {
          const next = event.key === "ArrowRight" ? (index + 1) % items.length
            : event.key === "ArrowLeft" ? (index + items.length - 1) % items.length
              : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
          if (next === null) return;
          event.preventDefault(); onChange(items[next]!.id);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
        className={cn("flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium", value === item.id
          ? "border-cyan-600 text-cyan-700 dark:text-cyan-300" : "border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-white")}>
        {item.label}{item.count !== undefined ? <span className="rounded-full bg-slate-100 px-2 text-xs tabular-nums dark:bg-slate-800">{item.count}</span> : null}
      </button>)}
    </div>
    {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${value}`} tabIndex={0} className="grid min-w-0 gap-4">{children}</div>
  </div>;
}
