import { Info } from "lucide-react";

/**
 * The calibrated value beside a control whose value differs from it (F4 Q4): an icon and text,
 * never colour alone. `text` is the whole localized phrase, such as "Calibrated: 0.92".
 */
export function CalibratedValue({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs leading-5 text-secondary-foreground">
      <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
}
