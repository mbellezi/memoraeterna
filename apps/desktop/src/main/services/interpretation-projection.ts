import type {InterpretationRecord} from '@app/domain';
import type {MessageKey} from '@app/i18n';
import {safeWikiLabel} from '@app/integration-contracts';
/** Generated history stays outside editable source/wiki regions. */
export function renderInterpretationHistory(records:InterpretationRecord[]|undefined,t:(key:MessageKey)=>string){
 const label=(key:string)=>t(('knowledgeEvolution.'+key)as MessageKey),quote=(value:string)=>value.split('\n').map(line=>'> '+line.replaceAll('<!--','&lt;!--')).join('\n');
 return (records??[]).map(r=>{
  const historical=records!.some(next=>next.relationships.some(link=>link.kind==='supersedes'&&link.revisionId===r.revisionId));
  return [`### ${label('title')} · ${label(historical?'historical':r.context)} · ${label(r.perspective)}`,r.revisionId,quote(r.statement),...(['eventTime','validFrom','validUntil','publicationTime']as const).map(key=>`${label(key)}: ${r[key]?.value??label('unknown')}`),...r.recordedAt.map(time=>`${label('recordedAt')}: ${time.at} · ${time.documentId}`),...(r.sourceDates??[]).filter(d=>d.noteDate).map(d=>`${label('noteDate')}: ${d.noteDate} · ${d.sourceItemId}`),`${label('revisedAt')}: ${r.revisedAt}`,...(r.procedure?(['steps','workedWhen','assumptions','limits','corrections']as const).filter(key=>!Array.isArray(r.procedure![key])||(r.procedure![key]as string[]).length>0).map(key=>`#### ${label(key)}\n\n${quote(Array.isArray(r.procedure![key])?(r.procedure![key]as string[]).join('\n'):r.procedure![key]as string)}`):[]),...r.relationships.map(link=>`${label(link.kind)} · ${link.revisionId}\n\n${quote(link.reason)}`),...r.evidence.map(e=>`${label('evidence')} · ${safeWikiLabel(e.sourceTitle)} · ${e.documentId} · ${e.chunkId}\n\n${quote(e.excerpt)}`)].join('\n\n');
 }).join('\n\n');
}
