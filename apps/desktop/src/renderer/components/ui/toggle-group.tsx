import type { ComponentPropsWithoutRef } from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";

type ToggleGroupProps<T extends string> = Omit<
  ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>,
  "type" | "value" | "defaultValue" | "onValueChange" | "aria-label"
> & {
  /** The group's accessible name ("Densidade"). */
  label: string;
  /** The pressed segment. A segmented control always has exactly one. */
  value: T;
  onValueChange: (value: T) => void;
};

/**
 * The segmented control (design record 5.11): a soft track whose pressed chip is raised, semibold
 * and ringed with `--border-strong`. The design binds `aria-pressed` on the segments, so the group
 * is Radix's multiple-selection form held to one value: pressing the pressed segment changes
 * nothing, pressing another moves the press. One roving tab stop; arrows move focus, Space and
 * Enter press. Serves the view switchers and the Library density toggle.
 */
export function ToggleGroup<T extends string>({
  label,
  value,
  onValueChange,
  className,
  ...props
}: ToggleGroupProps<T>) {
  return (
    <ToggleGroupPrimitive.Root
      type="multiple"
      role="group"
      aria-label={label}
      value={[value]}
      onValueChange={(next) => {
        const picked = next.find((entry) => entry !== value);
        if (picked !== undefined) onValueChange(picked as T);
      }}
      className={cn(
        "inline-flex w-fit items-center gap-0.5 rounded-lg border border-border bg-soft p-0.5",
        className
      )}
      {...props}
    />
  );
}

export function ToggleGroupItem({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        "inline-flex h-7 items-center gap-2 whitespace-nowrap rounded-md border-0 bg-transparent px-3 text-sm",
        "text-secondary-foreground outline-none transition-colors hover:text-foreground",
        // `outline-none` sets the outline style to none for good (Tailwind 4 reads it back in `outline-2`), so the ring names its own style.
        "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:text-muted-foreground [&>svg]:size-3.5 [&>svg]:shrink-0",
        "data-[state=on]:bg-surface data-[state=on]:font-semibold data-[state=on]:text-foreground",
        "data-[state=on]:shadow-[0_0_0_1px_var(--border-strong)]",
        className
      )}
      {...props}
    />
  );
}
