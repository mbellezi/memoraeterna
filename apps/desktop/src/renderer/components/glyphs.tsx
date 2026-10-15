import type { ReactNode } from "react";
import type { ObjectKind } from "@app/domain";

import { cn } from "../lib/cn";
import type { Stance } from "../lib/relation-stance";

/**
 * First-party glyphs for object kinds and relation stances (16 px grid, drawn for these meanings;
 * Lucide has no equivalent). They are decorative: the word beside them carries the meaning, and the
 * colour comes from the caller (`text-object-<kind>`, `stanceTextClass`). Interface icons stay Lucide.
 */
function Glyph({
  size,
  className,
  children
}: {
  size: number;
  className: string | undefined;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn("block flex-none", className)}
    >
      {children}
    </svg>
  );
}

const kindPaths: Record<ObjectKind, ReactNode> = {
  source: (
    <>
      <path d="M8 4.5C6.5 3.5 4.5 3 2.5 3v9.5c2 0 4 .5 5.5 1.5 1.5-1 3.5-1.5 5.5-1.5V3c-2 0-4 .5-5.5 1.5z" />
      <path d="M8 4.5V14" />
    </>
  ),
  note: (
    <>
      <rect x="3" y="2.5" width="10" height="11" rx="1.5" />
      <path d="M5.5 6h5M5.5 8.5h5M5.5 11h3" />
    </>
  ),
  topic: (
    <>
      <rect x="5.75" y="2" width="4.5" height="3.25" rx=".75" />
      <rect x="1.75" y="10.75" width="4.5" height="3.25" rx=".75" />
      <rect x="9.75" y="10.75" width="4.5" height="3.25" rx=".75" />
      <path d="M8 5.25V8M4 10.75V8h8v2.75" />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.3 6.3a1.8 1.8 0 1 1 2.5 1.65c-.5.22-.8.66-.8 1.2v.35" />
      <path d="M8 11.4v.1" />
    </>
  ),
  entity: (
    <>
      <path d="M8 1.75 14.25 8 8 14.25 1.75 8z" />
      <circle cx="8" cy="8" r="1.25" />
    </>
  )
};

const stancePaths: Record<Stance, ReactNode> = {
  supports: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v6M5 8h6" />
    </>
  ),
  contradicts: <path d="M1.5 8H6M4 5.5 6.5 8 4 10.5M14.5 8H10M12 5.5 9.5 8 12 10.5" />,
  extends: <path d="M2.5 4v8M2.5 8h10M10 5.5l2.5 2.5-2.5 2.5" />,
  depends_on: (
    <>
      <rect x="1.5" y="5.25" width="7.5" height="5.5" rx="2.75" />
      <rect x="7" y="5.25" width="7.5" height="5.5" rx="2.75" />
    </>
  ),
  example_of: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  related: (
    <>
      <circle cx="4" cy="12" r="1.75" />
      <circle cx="12" cy="4" r="1.75" />
      <path d="M5.25 10.75l5.5-5.5" />
    </>
  )
};

/** Literal classes, so the styles are generated: `text-object-<kind>` from tokens.css. */
export const objectKindTextClass: Record<ObjectKind, string> = {
  source: "text-object-source",
  note: "text-object-note",
  topic: "text-object-topic",
  question: "text-object-question",
  entity: "text-object-entity"
};

export function ObjectKindGlyph({
  kind,
  size = 14,
  className
}: {
  kind: ObjectKind;
  size?: number;
  className?: string;
}) {
  return (
    <Glyph size={size} className={className}>
      {kindPaths[kind]}
    </Glyph>
  );
}

export function StanceGlyph({
  stance,
  size = 14,
  className
}: {
  stance: Stance;
  size?: number;
  className?: string;
}) {
  return (
    <Glyph size={size} className={className}>
      {stancePaths[stance]}
    </Glyph>
  );
}
