import { graphDashPattern } from "./view-model";

/**
 * A short sample of how a graph draws a line, for legends: solid for a relation somebody kept or an
 * apply band wrote, dashed for a suggestion nobody kept yet (decision 29), with an arrow head when
 * the relation reads from one note to the other. The pattern is the one the canvas draws, so the
 * legend cannot drift from it. The sample takes the text colour of its place (`currentColor`).
 */
export function LineSample({
  suggested,
  arrow = false,
  className
}: {
  suggested: boolean;
  arrow?: boolean;
  className?: string;
}) {
  return (
    <svg
      width="32"
      height="10"
      viewBox="0 0 32 10"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <line
        x1="1"
        y1="5"
        x2={arrow ? "24" : "31"}
        y2="5"
        stroke="currentColor"
        strokeWidth={suggested ? 1.8 : 2.2}
        {...(suggested
          ? { strokeDasharray: `${graphDashPattern.dash} ${graphDashPattern.gap}` }
          : {})}
      />
      {arrow ? <path d="M23 1.5 L31 5 L23 8.5 Z" fill="currentColor" /> : null}
    </svg>
  );
}
