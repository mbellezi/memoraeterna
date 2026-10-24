import { createSettingsRepository, type PgPool } from "@app/db";
import {
  onboardingSettingKey,
  onboardingStateOf,
  readOnboardingRecord,
  type OnboardingOutcome,
  type OnboardingRecord,
  type OnboardingState
} from "@app/domain";

/** Where the first run is kept (the `settings` row `onboarding.v1`) and what the library holds. */
export interface OnboardingStore {
  read(): Promise<unknown>;
  write(record: OnboardingRecord): Promise<void>;
  /** Whether the library has no source at all (a first run is for an empty library only). */
  libraryEmpty(): Promise<boolean>;
}

export function pgOnboardingStore(getPool: () => PgPool | null): OnboardingStore {
  const pool = (): PgPool => {
    const current = getPool();
    if (!current) throw new Error("errors.database.notReady");
    return current;
  };
  return {
    read: async () => createSettingsRepository(pool()).get(onboardingSettingKey),
    write: async (record) => {
      await createSettingsRepository(pool()).set(onboardingSettingKey, record);
    },
    libraryEmpty: async () => {
      const result = await pool().query<{ present: boolean }>(
        "select exists (select 1 from source_items) as present"
      );
      return result.rows[0]?.present !== true;
    }
  };
}

export interface OnboardingServiceOptions {
  store: OnboardingStore;
  now?: () => Date;
}

/**
 * The first run's stored state (F4 D31): the full-window view is due while the library is empty and
 * `onboarding.v1` is unset. Finishing the three steps or skipping them sets the row; the first
 * record stays, so a second window or a repeated click never rewrites how the first run ended.
 */
export class OnboardingService {
  public constructor(private readonly options: OnboardingServiceOptions) {}

  public async state(): Promise<OnboardingState> {
    const [stored, libraryEmpty] = await Promise.all([
      this.options.store.read(),
      this.options.store.libraryEmpty()
    ]);
    return onboardingStateOf(readOnboardingRecord(stored), libraryEmpty);
  }

  public async finish(outcome: OnboardingOutcome): Promise<OnboardingState> {
    if (readOnboardingRecord(await this.options.store.read()) === null)
      await this.options.store.write({
        version: 1,
        outcome,
        at: (this.options.now?.() ?? new Date()).toISOString()
      });
    return this.state();
  }
}
