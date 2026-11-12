import type { ReactNode } from "react";

import { cn } from "../../../lib/cn";

/**
 * A line of clauses told apart by "·" (design record §13): each clause is one unit that never breaks
 * inside, and its separator belongs to the clause that follows it, so a line never ends on "·". The
 * line clips the separator of the clause that starts a line: the group is shifted left by the
 * separator's width and clipped, and every clause but the first carries its own separator in the
 * room that shift made, so a clause that wraps to a new line starts flush left with its separator
 * out of sight.
 */

const separatorRoom = "1.1em";

export function MetaClauses({
  clauses,
  className
}: {
  clauses: readonly ReactNode[];
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 overflow-hidden [text-wrap:pretty]", className)}>
      <p
        className="m-0 flex flex-wrap gap-y-0.5"
        style={{ marginInlineStart: `-${separatorRoom}` }}
      >
        {clauses.map((clause, index) => (
          <span
            key={index}
            className="relative inline-block whitespace-normal"
            style={{ paddingInlineStart: separatorRoom }}
          >
            {index > 0 ? (
              <span
                aria-hidden="true"
                className="absolute top-0 text-muted-foreground"
                style={{ insetInlineStart: "0.35em" }}
              >
                ·
              </span>
            ) : null}
            {clause}
          </span>
        ))}
      </p>
    </div>
  );
}
