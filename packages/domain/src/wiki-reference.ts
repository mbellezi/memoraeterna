/** Canonical IDs and per-section citation positions are the only native reference syntax. */
export function resolveWikiReference(token:string,evidenceIds:readonly string[],targets:readonly {kind:string;id:string}[]){
 const citation=/^\[(?:e)?([1-9][0-9]{0,3})\]$/.exec(token);
 if(citation){const id=evidenceIds[Number(citation[1])-1];return id?{kind:'evidence' as const,id,label:token}:null;}
 const link=/^\[([^\]\n]{1,300})\]\(memora:(page|source|atomic_note|entity)\/([0-9a-f-]{36})\)$/.exec(token);
 if(link&&targets.some(t=>t.kind===link[2]&&t.id===link[3]))return{kind:'target' as const,target:{kind:link[2] as 'page'|'source'|'atomic_note'|'entity',id:link[3]!},label:link[1]!};
 return null;
}
