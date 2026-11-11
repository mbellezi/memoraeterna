import type { DevPowerOverride } from "../gardener/power-signals.js";
import { parseDevPowerBlocks } from "../gardener/power-signals.js";
import type { SoakE1Plan } from "./soak-plan-f4.js";

/**
 * The dedicated E1 contention run (F4 D38b, owner 2026-11-11): the revision marker an edit wave
 * puts at the head of each note's body, and the driver's start under the run's conditions.
 *
 * The run holds autonomy Off for its whole length: the launcher writes it into the clone's stored
 * Knowledge controls before the app first opens the clone, so no claim ever happens under Auto.
 * The driver never sets or lifts it: it reads it at its start and refuses the run otherwise. It
 * pins the power reading idle through the soak's own override (the windows' port), so the pilot's
 * calibration transfers to the run.
 */

/** A wave's marker line: `[e1 r<wave>]`, then a blank line, at the head of the body. */
const markerPattern = /^\[e1 r\d+\]\n\n/u;

/**
 * The body with the wave's marker at its head, replacing an earlier wave's marker (never stacked),
 * so MATCH's rendered input (title, idea, the first characters of the body) is new at every wave.
 */
export function withWaveMarker(bodyMarkdown: string, wave: number): string {
  return `[e1 r${wave}]\n\n${bodyMarkdown.replace(markerPattern, "")}`;
}

/** What the E1 start reads and sets: the controls (read only), the power override, the D26 counter. */
export interface E1StartDeps {
  controls: { current(): { autonomy: string } };
  power: { setDevOverride(override: DevPowerOverride | null): void };
  relationCalls(): Promise<{ day: string; calls: number } | null>;
  now?: () => number;
}

/** What the run's meta records of the E1 start. */
export interface E1StartRecord {
  autonomyAtStart: string;
  powerPinnedAt: string;
  relationCallsAtStart: { day: string; calls: number } | null;
}

/**
 * The E1 run's start, before the driver's first action: refuses the run unless the stored controls
 * read Off (the launcher wrote them before the first start), then pins the power reading idle.
 * Never writes the controls.
 */
export async function startE1(plan: SoakE1Plan, deps: E1StartDeps): Promise<E1StartRecord> {
  const autonomy = deps.controls.current().autonomy;
  if (autonomy !== plan.autonomy)
    throw new Error(
      `The dedicated E1 run needs autonomy ${plan.autonomy} in the stored controls before the first start (the launcher writes it); they read ${autonomy}: refused before any action (D38b)`
    );
  const now = (deps.now ?? Date.now)();
  // One idle block, repeated for the whole run (the override cycles its blocks).
  deps.power.setDevOverride({ startedAt: now, blocks: parseDevPowerBlocks(plan.power) ?? [] });
  const relationCallsAtStart = await deps.relationCalls().catch(() => null);
  return {
    autonomyAtStart: autonomy,
    powerPinnedAt: new Date(now).toISOString(),
    relationCallsAtStart
  };
}
