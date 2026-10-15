import { createObjectLocateRepository, type PgPool } from "@app/db";
import {
  ObjectLocateInputSchema,
  ObjectLocateResultSchema,
  parseObjectAddress,
  type ObjectLocateResult
} from "@app/domain";

/**
 * Objects layer (docs/plan.md 4.5): read-only answers about objects addressed by
 * `memora://<kind>/<uuid>`. Nothing here calls AI or writes.
 */
export class ObjectsService {
  constructor(private readonly getPool: () => PgPool | null) {}

  /**
   * Where an object is: its primary path from the library root, the legacy wiki pages that include
   * it, the objects that cite it and counts, in one read. Resolves to null when the object does not
   * exist. Sources and notes are the kinds that have pages today; the others fail until their pages
   * exist (topics, questions and entities arrive with the Topic Tree Engine and the unified
   * workspace).
   */
  async locate(input: unknown): Promise<ObjectLocateResult | null> {
    const { address } = ObjectLocateInputSchema.parse(input);
    const target = parseObjectAddress(address);
    if (!target) throw new Error("errors.common.validationFailed");
    const pool = this.getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    const repository = createObjectLocateRepository(pool);
    if (target.kind === "source")
      return ObjectLocateResultSchema.nullable().parse(await repository.locateSource(target.id));
    if (target.kind === "note")
      return ObjectLocateResultSchema.nullable().parse(await repository.locateNote(target.id));
    throw new Error("objects.errors.unsupportedKind");
  }
}
