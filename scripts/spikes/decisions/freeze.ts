/**
 * Records the Spike A2 design as frozen. Run it once the tuning stages are scored and evaluated,
 * before any held-out stage:
 *
 *   npx tsx scripts/spikes/decisions/freeze.ts
 */
import { writeFrozenDesign, frozenDesignPath } from "./frozen.js";

await writeFrozenDesign();
console.info(`Design frozen: ${frozenDesignPath}`);
