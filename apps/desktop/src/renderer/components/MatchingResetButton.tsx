import { RotateCcw } from "lucide-react";

export function MatchingResetButton({ label, onReset }: { label: string; onReset: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onReset}
      className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-soft focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"
    >
      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
