import { wikiNavigationOrder } from "./wiki-navigation";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createTranslator } from "@app/i18n";
import { WikiWorkspace } from "./WikiWorkspace";
import { createLibraryHistoryState, libraryHistoryEntryFromState } from "./LibraryView";

describe("manual wiki workspace",()=>{
  it("offers catalog and manual page creation with no model or generated content",()=>{
    const html=renderToString(<WikiWorkspace active={false} t={createTranslator("pt-BR")} onOpenSource={()=>undefined}/>);
    expect(html).toContain("Todas as fontes");
    expect(html).toContain("Nova página");
    expect(html).toContain("Sem necessidade de IA");
    expect(html).not.toContain("sourceRelations.approved");
  });
  it("renders parents before alphabetically earlier children and respects sibling order",()=>{
    const pages=[{id:"child",parentId:"parent",title:"A child",position:0,archived:false},{id:"parent",parentId:null,title:"Z parent",position:0,archived:false},{id:"later",parentId:"parent",title:"Before alphabetically",position:2,archived:false}];
    expect(wikiNavigationOrder(pages).map(({page,depth})=>[page.id,depth])).toEqual([["parent",0],["child",1],["later",1]]);
  });
  it("preserves the wiki origin in native source-history navigation",()=>{
    expect(libraryHistoryEntryFromState(createLibraryHistoryState({view:"wiki"}))).toEqual({view:"wiki"});
  });
});
