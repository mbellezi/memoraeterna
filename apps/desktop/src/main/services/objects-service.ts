import {
  createObjectLocateRepository,
  createObjectNeighborhoodRepository,
  createObjectReadRepository,
  type PgPool
} from "@app/db";
import {
  decodeBacklinkCursor,
  encodeBacklinkCursor,
  formatObjectAddress,
  ObjectBacklinksInputSchema,
  ObjectBacklinksResultSchema,
  ObjectGetInputSchema,
  ObjectGetResultSchema,
  ObjectLocateInputSchema,
  ObjectLocateResultSchema,
  ObjectNeighborhoodInputSchema,
  ObjectNeighborhoodSchema,
  ObjectResolveManyInputSchema,
  ObjectResolveManyResultSchema,
  parseObjectAddress,
  type ObjectAddress,
  type ObjectBacklinksResult,
  type ObjectGetResult,
  type ObjectLocateResult,
  type ObjectNeighborhood,
  type ObjectResolveManyResult
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
   * that cite it and counts. Resolves to null when the object does not exist. A topic is located by
   * its ancestors (a retired one through its redirect to the live topic), an entity by the topics
   * its notes are placed in. Questions fail until they have a location (F5 T129).
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
    if (target.kind === "topic")
      return ObjectLocateResultSchema.nullable().parse(await repository.locateTopic(target.id));
    if (target.kind === "entity")
      return ObjectLocateResultSchema.nullable().parse(await repository.locateEntity(target.id));
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

  /**
   * One object by address (F5 D11): its kind, title, status, preview and counts. A retired topic
   * answers with the live topic that replaced it in `redirectTo`; an address with a `passage` or
   * `span` previews that passage. `{ status: "missing" }` when the object does not exist.
   */
  async get(input: unknown): Promise<ObjectGetResult> {
    const { address } = ObjectGetInputSchema.parse(input);
    const target = this.parse(address);
    const found = (await createObjectReadRepository(this.pool()).resolve([target])).values().next();
    return ObjectGetResultSchema.parse(found.done ? { status: "missing" } : found.value);
  }

  /**
   * Many addresses in one read, for lists, hovers and citations (at most 200, unique). `items` is
   * keyed by the address as requested; an address with no object is listed in `missing`.
   * `include.path` adds the topics above each object.
   */
  async resolveMany(input: unknown): Promise<ObjectResolveManyResult> {
    const { addresses, include } = ObjectResolveManyInputSchema.parse(input);
    const targets = addresses.map((address) => ({ address, target: this.parse(address) }));
    const resolved = await createObjectReadRepository(this.pool()).resolve(
      targets.map((entry) => entry.target),
      { path: include?.path === true }
    );
    const items: ObjectResolveManyResult["items"] = {};
    const missing: string[] = [];
    for (const { address, target } of targets) {
      const summary = resolved.get(canonical(target));
      if (summary) items[address] = summary;
      else missing.push(address);
    }
    return ObjectResolveManyResultSchema.parse({ items, missing });
  }

  /**
   * The links into an object, one keyset-paged list across the kinds of link (evidence, relation,
   * source relation, overview citation, question citation, mention). Anchors on the address are
   * ignored: the target is the object. A malformed cursor is refused.
   */
  async backlinks(input: unknown): Promise<ObjectBacklinksResult> {
    const { address, limit, cursor } = ObjectBacklinksInputSchema.parse(input);
    const target = this.parse(address);
    const position = cursor === undefined ? undefined : decodeBacklinkCursor(cursor);
    if (position === null) throw new Error("errors.common.validationFailed");
    const page = await createObjectReadRepository(this.pool()).backlinks({
      target,
      limit,
      cursor: position
    });
    return ObjectBacklinksResultSchema.parse({
      items: page.items,
      ...(page.next ? { next: encodeBacklinkCursor(page.next) } : {})
    });
  }

  private parse(address: string): ObjectAddress {
    const target = parseObjectAddress(address);
    if (!target) throw new Error("errors.common.validationFailed");
    return target;
  }

  private pool(): PgPool {
    const pool = this.getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    return pool;
  }
}

const canonical = (target: ObjectAddress): string => formatObjectAddress(target);
