import type { WikiPageContent } from "@app/domain";
import type { PgPool } from "../client.js";
type Db = Pick<PgPool, "query">;

/** IDs only. A duplicate historical binding is a conflict, never a merge/reuse guess. */
export async function canonicalEntityPage(db: Db, entityId: string): Promise<string | null> {
  const rows = (
    await db.query(
      `select p.id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id
    where r.content->>'entityId'=$1 or r.content->'automatic'->'role'->>'entityId'=$1 order by p.id`,
      [entityId]
    )
  ).rows;
  if (rows.length > 1) throw new Error("organization.errors.conflict");
  return rows[0]?.id ?? null;
}

/** Every save calls this under wiki-placement, including native/editorial saves. */
export async function validateCanonicalWikiBindings(
  db: Db,
  pageId: string,
  content: Pick<WikiPageContent, "kind" | "entityId" | "automatic">
) {
  const role = content.automatic?.role;
  if (role && role.kind !== content.kind) throw new Error("wiki.errors.invalid");
  if (role?.kind === "entity" && role.entityId !== content.entityId)
    throw new Error("wiki.errors.invalid");
  if (content.entityId) {
    if (content.kind !== "entity") throw new Error("wiki.errors.invalid");
    const existing = await canonicalEntityPage(db, content.entityId);
    if (existing && existing !== pageId) throw new Error("organization.errors.conflict");
  }
  if (role?.kind === "collection" && role.owner) {
    const owner = role.owner;
    if (
      role.role === "topic_toc" &&
      (owner.kind !== "page" ||
        !(
          await db.query("select 1 from wiki_pages where id=$1 and kind='topic' and not archived", [
            owner.id
          ])
        ).rows.length)
    )
      throw new Error("wiki.errors.invalid");
    if (
      role.role === "source_toc" &&
      (owner.kind !== "source" ||
        !(await db.query("select 1 from source_items where id=$1", [owner.id])).rows.length)
    )
      throw new Error("wiki.errors.invalid");
    const duplicate = (
      await db.query(
        `select p.id from wiki_pages p left join wiki_page_revisions r on r.id=p.current_revision_id
      where p.id<>$1 and ((p.role=$2 and p.toc_owner_kind=$3 and p.toc_owner_id=$4)
        or (r.content->'automatic'->'role'->>'role'=$2 and r.content->'automatic'->'role'->'owner'->>'kind'=$3 and r.content->'automatic'->'role'->'owner'->>'id'=$4::text))`,
        [pageId, role.role, owner.kind, owner.id]
      )
    ).rows;
    if (duplicate.length) throw new Error("organization.errors.conflict");
  }
  const automatic = content.automatic;
  if (!automatic) return;
  const groups = automatic.groups.map((g) => g.id),
    members = automatic.memberships.map((m) => m.id);
  if (
    (
      await db.query(
        "select 1 from wiki_toc_groups where id=any($1::uuid[]) and page_id<>$2 union all select 1 from wiki_memberships where id=any($3::uuid[]) and page_id<>$2",
        [groups, pageId, members]
      )
    ).rows.length
  )
    throw new Error("wiki.errors.conflict");
  const children = automatic.memberships.filter((m) => m.purpose === "subtopic");
  if (children.some((m) => m.target.kind !== "page")) throw new Error("wiki.errors.invalid");
  const ids = [...new Set(children.map((m) => m.target.id))];
  if (!ids.length) return;
  if (
    (
      await db.query(
        "select id from wiki_pages where id=any($1::uuid[]) and kind='collection' and not archived",
        [ids]
      )
    ).rows.length !== ids.length
  )
    throw new Error("wiki.errors.invalid");
  // UNION makes malformed retained cycles terminate. Only hierarchical reading edges count.
  const cycle = (
    await db.query(
      `with recursive reachable(id) as (
    select unnest($1::uuid[]) union select m.target_id from wiki_memberships m join reachable r on r.id=m.page_id
      where m.target_kind='page' and m.snapshot->>'purpose'='subtopic' and m.page_id<>$2
    ) select 1 from reachable where id=$2`,
      [ids, pageId]
    )
  ).rows;
  if (cycle.length) throw new Error("wiki.errors.cycle");
}
