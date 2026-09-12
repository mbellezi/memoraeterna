import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronRight, Files, FolderOpen, FolderTree, Network } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { WikiPage } from "@app/domain";
import { visibleWikiNavigation } from "./wiki-navigation";

type Page = { id: string; parentId: string | null; title: string; position: number; archived: boolean; hasChildren?: boolean; kind?: WikiPage["kind"] };
const icons = { topic: BookOpen, entity: Network, collection: FolderTree, synthesis: Files };

export function WikiThemeTree({ pages, selected, disabled, onOpen, onExpand, more, onMore, t }: {
  pages: Page[];
  onExpand?:((id:string)=>void)|undefined; more?:Record<string,boolean>|undefined; onMore?:((id:string)=>void)|undefined;
  selected: string | null;
  disabled: boolean;
  onOpen: (id: string) => void;
  t: Translator;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => visibleWikiNavigation(pages, expanded), [pages, expanded]);
  useEffect(()=>{if(!selected)return;const path=new Set<string>();let id=pages.find(p=>p.id===selected)?.parentId;while(id&&!path.has(id)){path.add(id);id=pages.find(p=>p.id===id)?.parentId;}setExpanded(current=>new Set([...current,...path]));},[selected,pages]);
  const focusId = visible.some(row => row.page.id === focus) ? focus : visible[0]?.page.id;
  const move = (id: string | undefined) => {
    if (!id) return;
    setFocus(id);
    root.current?.querySelector<HTMLButtonElement>(`[data-page-id="${id}"]`)?.focus();
  };
  const toggle = (id: string, open: boolean) => {if(open)onExpand?.(id);setExpanded(current => {
    const next = new Set(current);
    if (open) next.add(id); else next.delete(id);
    return next;
  });};
  return <div ref={root} role="tree" aria-label={t("wiki.pages")} className="grid gap-0.5 pb-3">
    {visible.map(({ page, depth, parentId, hasChildren: loadedChildren }, index) => {
      const hasChildren=page.hasChildren??loadedChildren;
      const open = expanded.has(page.id);
      const kind = page.kind ?? "topic";
      const Icon = kind === "collection" && open ? FolderOpen : icons[kind];
      const isSelected = selected === page.id;
      return <button type="button" id={`wiki-leaf-${page.id}`} data-page-id={page.id}
        role="treeitem" aria-level={depth + 1} aria-expanded={hasChildren ? open : undefined} aria-selected={isSelected}
        tabIndex={focusId === page.id ? 0 : -1} key={page.id} disabled={disabled}
        title={`${t(`wiki.kinds.${kind}`)} · ${page.title}`}
        onFocus={() => setFocus(page.id)}
        onKeyDown={event => {
          if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          if (event.key === "ArrowDown") move(visible[index + 1]?.page.id);
          if (event.key === "ArrowUp") move(visible[index - 1]?.page.id);
          if (event.key === "Home") move(visible[0]?.page.id);
          if (event.key === "End") move(visible.at(-1)?.page.id);
          if (event.key === "ArrowRight") {
            if (hasChildren && !open) toggle(page.id, true);
            else if (hasChildren) move(visible[index + 1]?.page.id);
          }
          if (event.key === "ArrowLeft") {
            if (hasChildren && open) toggle(page.id, false);
            else move(parentId ?? undefined);
          }
        }}
        onClick={() => onOpen(page.id)}
        style={{ paddingLeft: 4 + Math.min(depth, 6) * 16 }}
        className={`relative flex min-h-10 w-full items-start gap-1.5 rounded-md py-2 pr-2 text-left text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent disabled:opacity-40 ${isSelected ? "bg-accent-soft font-medium text-accent" : "text-foreground hover:bg-soft"}`}>
        {depth > 0 && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 border-l border-border" style={{ left: 8 + (Math.min(depth, 6) - 1) * 16 }} />}
        <span aria-hidden="true" className={`-my-1 flex h-7 w-5 shrink-0 items-center justify-center rounded ${hasChildren ? "hover:bg-accent/15" : ""}`}
          onClick={event => { if (hasChildren) { event.stopPropagation(); toggle(page.id, !open); } }}>
          {hasChildren && <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />}
        </span>
        <Icon aria-hidden="true" size={16} className={`mt-0.5 shrink-0 ${isSelected ? "text-accent" : "text-muted-foreground"}`} />
        <span className="min-w-0 [overflow-wrap:anywhere]">{page.title}</span>
      </button>;
    })}
    {Object.entries(more??{}).filter(([id,hasMore])=>hasMore&&expanded.has(id)).map(([id])=><button key={id} disabled={disabled} className="p-2 text-left text-xs text-accent" onClick={()=>onMore?.(id)}>{pages.find(p=>p.id===id)?.title} · {t("wiki.loadMore")}</button>)}
  </div>;
}
