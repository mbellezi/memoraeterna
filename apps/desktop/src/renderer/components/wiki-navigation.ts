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
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const result: Array<{ page: T; depth: number }> = [];
  const visited = new Set<string>();
  function visit(page: T, depth: number) {
    if (visited.has(page.id)) return;
    visited.add(page.id);
    result.push({ page, depth });
    for (const child of children.get(page.id) ?? []) visit(child, depth + 1);
  }
  for (const page of children.get(null) ?? []) visit(page, 0);
  // Defensive visibility for corrupt legacy data; rendering cannot create a loop.
  for (const page of ordered) if (!visited.has(page.id)) visit(page, 0);
  return result;
}

/** Visibility follows the normalized forest, including promoted orphan/cyclic legacy roots. */
export function visibleWikiNavigation<T extends PlacedPage>(pages:readonly T[],expanded:ReadonlySet<string>){
 const stack:string[]=[],ordered=wikiNavigationOrder(pages).map(row=>{stack.length=row.depth;const parentId=stack.at(-1)??null;stack.push(row.page.id);return{...row,parentId};});
 const parents=new Map(ordered.map(r=>[r.page.id,r.parentId]));
 return ordered.filter(row=>{let parent=row.parentId;while(parent){if(!expanded.has(parent))return false;parent=parents.get(parent)??null;}return true;}).map(row=>({...row,hasChildren:ordered.some(child=>child.parentId===row.page.id)}));
}
