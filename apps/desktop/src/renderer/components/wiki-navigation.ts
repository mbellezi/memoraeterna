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
