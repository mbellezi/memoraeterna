/**
 * The online makeup of a Decisions request (F3 plan decision 30). The frozen bake-off sent each
 * note's whole batch neighbourhood. The product asks while a library grows, so a request carries
 * what it asks about (its targets) and, as far as `maxNeighbourhood` leaves room, the notes the
 * queried note was decided against before (its partners), in content order. Only the targets'
 * directions are read from the answers; the partners are context. A forward request queries the
 * note against its retrieval targets; each reverse direction is a request of its own, the candidate
 * as the query and the note as its one target.
 *
 * The rule is part of the request design: {@link decisionsNeighbourhoodRule} is named in
 * `decisionsRequestDesign`, so a change of the rule changes the calibration identity, and the
 * frozen calibration then no longer applies. Bump the name with any change to the function below.
 */
export const decisionsNeighbourhoodRule = "online-targets-then-decided-partners-v1";

/**
 * The notes one request carries: the targets (never trimmed), then the partners that are not
 * targets, in `compare` order, up to `maxNeighbourhood` notes in all; the whole list in `compare`
 * order. `compare` is the content order, never an ID order (`rules/ai.md`): the request is a
 * function of the notes' content.
 */
export function decisionsNeighbourhood<T extends { id: string }>(input: {
  targets: readonly T[];
  partners: readonly T[];
  maxNeighbourhood: number;
  compare: (left: T, right: T) => number;
}): T[] {
  const taken = new Set(input.targets.map((target) => target.id));
  const makeup: T[] = [];
  for (const partner of input.partners)
    if (!taken.has(partner.id)) {
      taken.add(partner.id);
      makeup.push(partner);
    }
  const room = Math.max(0, input.maxNeighbourhood - input.targets.length);
  return [...input.targets, ...makeup.sort(input.compare).slice(0, room)].sort(input.compare);
}
