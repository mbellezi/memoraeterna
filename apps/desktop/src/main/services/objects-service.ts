import {
  createObjectLocateRepository,
  createObjectNeighborhoodRepository,
  type PgPool
} from "@app/db";
import {
  ObjectLocateInputSchema,
  ObjectLocateResultSchema,
  ObjectNeighborhoodInputSchema,
  ObjectNeighborhoodSchema,
  parseObjectAddress,
  type ObjectLocateResult,
  type ObjectNeighborhood
} from "@app/domain";

/**
 * Objects layer (docs/plan.md 4.5): read-only answers about objects addressed by
 * `memora://<kind>/<uuid>`. Nothing here calls AI or writes.
 */
export class ObjectsService {
  constructor(private readonly getPool: () => PgPool | null) {}

  /**
   * Where an object is, in one read (D24): its primary path (the topics from the root of the topic
   * tree down to the topic it is placed in, then its source chain), its other topics, the objects
   * that cite it and counts. Resolves to null when the object does not exist. Sources and notes are
   * the kinds that have a location today; the others fail until they have one (topics open by their
   * own address, questions and entities arrive with the unified workspace).
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

  /**
   * The local graph around a note (F3 D43, R30; the plan 4.5 name, restricted to notes until F5):
   * the note, its strongest related notes and, at depth 2, theirs, with every shown relation among
   * them. A suggestion is an edge in the `suggested` state; a withdrawn or removed relation is
   * never drawn. Resolves to null when the note does not exist. Read-only, without AI.
   */
  async neighborhood(input: unknown): Promise<ObjectNeighborhood | null> {
    const { objectId, depth, limit } = ObjectNeighborhoodInputSchema.parse(input);
    const pool = this.getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    return ObjectNeighborhoodSchema.nullable().parse(
      await createObjectNeighborhoodRepository(pool).read({ objectId, depth, limit })
    );
  }
}
