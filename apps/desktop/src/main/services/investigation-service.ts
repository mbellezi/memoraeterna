import { createInvestigationRepository, type PgPool } from "@app/db";

/**
 * Followed questions, read-only. Following, pausing and the automatic refresh were retired with
 * Ask's page scope (F2 T10): `follow` and `state` answer `consultation.errors.retired` at the IPC
 * boundary and `tick` has nothing to refresh. Stored rows stay readable until the legacy wipe.
 */
export class InvestigationService {
  private recovered = false;
  constructor(
    private options: {
      getPool: () => PgPool | null;
      /** Unused: kept so the main wiring compiles until the legacy removal deletes this service. */
      consultation?: unknown;
      wake?: () => void;
      notify?: (item: { id: string; question: string }) => void;
    }
  ) {}
  private repo() {
    const pool = this.options.getPool();
    if (!pool) throw new Error("consultation.errors.unavailable");
    return createInvestigationRepository(pool);
  }
  async initialize() {
    if (!this.recovered) {
      await this.repo().recover();
      this.recovered = true;
    }
  }
  async list() {
    return (await this.repo().list()).filter((x) => x !== null);
  }
  async get(id: string) {
    return this.repo().get(id);
  }
  /** Called by the maintenance owner; a followed question is no longer refreshed. */
  readonly tick = async (): Promise<void> => {};
  shutdown() {}
}
