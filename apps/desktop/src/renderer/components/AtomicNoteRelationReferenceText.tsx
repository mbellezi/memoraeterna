import { SourceReferenceBadge } from "./SourceRelationReferenceText";

export function AtomicNoteRelationReferenceText({ text, sourceId, targetId, sourceTitle, targetTitle }: {
  text: string; sourceId: string; targetId: string; sourceTitle: string; targetTitle: string;
}) {
  return <>{text.split(/(<note-ref id="[^"]+" \/>)/g).map((part, index) => {
    const id = /^<note-ref id="([^"]+)" \/>$/.exec(part)?.[1];
    if (id === sourceId) return <SourceReferenceBadge key={index} number={1} title={sourceTitle} />;
    if (id === targetId) return <SourceReferenceBadge key={index} number={2} title={targetTitle} />;
    return part;
  })}</>;
}
