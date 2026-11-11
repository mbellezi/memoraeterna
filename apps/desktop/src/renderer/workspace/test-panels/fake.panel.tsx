import type { PanelProps } from "../PanelStack";

/**
 * A panel module for the host's registration test: a file in the shape every `panels/*.panel.tsx`
 * has, found by `import.meta.glob` like the real ones. It is not a surface of the app.
 */
export const kind = "fake";

export function match(address: string): boolean {
  return address.startsWith("memora://note/");
}

export function title(summary: { title: string } | null): string {
  return summary?.title ?? "";
}

export function Component({ address, mode }: PanelProps) {
  return <p data-fake-panel={mode}>{address}</p>;
}
