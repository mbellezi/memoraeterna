// What bar X2 asks of a panel's path ribbon (F5 T154, spec 5.3): the segments it shows with no gesture
// are the topics of `objects.locate(primary)`, and an object that has a place shows it. Equal lists are
// not enough on their own: a locate that regressed to no topic and a ribbon that says "unsorted" are
// two empty lists that agree.

export type PathKind = "source" | "note" | "topic" | "entity" | "question";

/** The ribbon states that show a path (`PathRibbon`'s `data-ribbon-state`). */
const showsPath = /^(placed|tentative)$/u;

/**
 * Whether the object must show a path on BASE-J. A source, a note and an entity sit under the topics
 * of their notes, and a Question under those its answer cites; a topic's own path holds only its
 * ancestors, so it must show one only when it is below level 1 of the tree.
 */
export function pathMustShow(kind: PathKind, topicBelowLevelOne: boolean): boolean {
  return kind !== "topic" || topicBelowLevelOne;
}

export interface RibbonReading {
  kind: PathKind;
  route: string;
  /** The ribbon's `data-ribbon-state` once it left loading. */
  state: string;
  /** The ribbon's `[data-segment]` addresses, left to right. */
  segments: readonly string[];
  /** The topic addresses of `objects.locate`'s primary path that the ribbon must show. */
  expected: readonly string[];
  mustShow: boolean;
}

/** Each way the ribbon falls short of X2, named with the kind and the route; empty when it holds. */
export function ribbonFailures(reading: RibbonReading): string[] {
  const label = `${reading.kind} by ${reading.route}`;
  const failures: string[] = [];
  if (reading.mustShow) {
    if (reading.expected.length === 0)
      failures.push(`${label}: objects.locate gives no topic on the primary path`);
    if (!showsPath.test(reading.state))
      failures.push(`${label}: the ribbon is "${reading.state}", not placed or tentative`);
    if (reading.segments.length === 0) failures.push(`${label}: the ribbon shows no segment`);
  }
  if (JSON.stringify(reading.segments) !== JSON.stringify(reading.expected))
    failures.push(
      `${label}: the ribbon shows [${reading.segments.join(", ")}], objects.locate gives [${reading.expected.join(", ")}]`
    );
  return failures;
}
