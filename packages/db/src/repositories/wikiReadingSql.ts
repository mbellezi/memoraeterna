/** Canonical reading context. UNION deduplicates IDs and terminates defensive cycles.
 * Only an explicitly selected TOC opens its owner; descent never follows related links.
 * The caller supplies a SQL parameter, never user text, and prefixes WITH RECURSIVE.
 */
export const wikiReadingPagesSql = (pageParameter: string) => `page_context(id) as (
  select id from wiki_pages where id=${pageParameter} and not archived and current_revision_id is not null
  union select owner.id from wiki_pages selected join wiki_pages owner on owner.id=selected.toc_owner_id
    where selected.id=${pageParameter} and selected.toc_owner_kind='page' and not selected.archived and not owner.archived and owner.current_revision_id is not null
  union select child.id from page_context parent join wiki_pages child on not child.archived and child.current_revision_id is not null and (
    child.parent_id=parent.id or child.toc_owner_kind='page' and child.toc_owner_id=parent.id
    or child.id in(select target_id from wiki_memberships where page_id=parent.id and target_kind='page' and snapshot->>'purpose'='subtopic'))
)`;
