interface PlacedPage {
  id: string;
  parentId: string | null;
  title: string;
  position: number;
  archived: boolean;
}

/** Editorial siblings keep their explicit order; every parent precedes its children. */
export function wikiNavigationOrder<T extends PlacedPage>(pages: readonly T[]): Array<{ page: T; depth: number }> {
  const visible = pages.filter((page) => !page.archived);
  const ids = new Set(visible.map((page) => page.id));
  const ordered = [...visible].sort((a, b) => a.position - b.position || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const children = new Map<string | null, T[]>();
  for (const page of ordered) {
    const parent = page.parentId && ids.has(page.parentId) ? page.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(page);
    children.set(parent, siblings);
  }
  const result: Array<{ page: T; depth: number }> = [];
  const visited = new Set<string>();
  function visit(page: T, depth: number) {
    const pending = [{ page, depth }];
    while (pending.length) {
      const row = pending.pop()!;
      if (visited.has(row.page.id)) continue;
      visited.add(row.page.id);
      result.push(row);
      const descendants = children.get(row.page.id) ?? [];
      for (let index = descendants.length - 1; index >= 0; index--)
        pending.push({ page: descendants[index]!, depth: row.depth + 1 });
    }
  }
  for (const page of children.get(null) ?? []) visit(page, 0);
  // Defensive visibility for corrupt data; rendering cannot create a loop.
  for (const page of ordered) if (!visited.has(page.id)) visit(page, 0);
  return result;
}

/** Visibility follows the normalized forest, including defensive orphan/cyclic roots. */
export function visibleWikiNavigation<T extends PlacedPage>(pages:readonly T[],expanded:ReadonlySet<string>){
 const stack:string[]=[],ordered=wikiNavigationOrder(pages).map(row=>{stack.length=row.depth;const parentId=stack.at(-1)??null;stack.push(row.page.id);return{...row,parentId};});
 const parentsWithChildren=new Set(ordered.map(row=>row.parentId));
 const visible=new Set<string>();
 return ordered.filter(row=>{const shown=row.parentId===null||visible.has(row.parentId)&&expanded.has(row.parentId);if(shown)visible.add(row.page.id);return shown;}).map(row=>({...row,hasChildren:parentsWithChildren.has(row.page.id)}));
}
