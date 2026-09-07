import type { SourceRelationView } from "@app/domain";

type Endpoints = Pick<SourceRelationView,"sourceItemId" | "targetSourceItemId" | "sourceTitle" | "targetTitle">;

export function SourceReferenceBadge({number,title}:{number:1|2;title:string}) {
  const color = number === 1
    ? "border-cyan-600 bg-cyan-100 text-cyan-800 dark:border-cyan-400 dark:bg-cyan-950 dark:text-cyan-200"
    : "border-violet-600 bg-violet-100 text-violet-800 dark:border-violet-400 dark:bg-violet-950 dark:text-violet-200";
  return <span className={`mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border px-0.5 align-baseline text-[10px] font-semibold leading-none ${color}`}
    title={title} aria-label={`${number}: ${title}`}>{number}</span>;
}

export function SourceRelationReferenceText({text,relation}:{text:string;relation:Endpoints}) {
  return <>{text.split(/(<source-ref id="[^"]+" \/>)/g).map((part,index) => {
    const id=/^<source-ref id="([^"]+)" \/>$/.exec(part)?.[1];
    if (id === relation.sourceItemId) return <SourceReferenceBadge key={index} number={1} title={relation.sourceTitle} />;
    if (id === relation.targetSourceItemId) return <SourceReferenceBadge key={index} number={2} title={relation.targetTitle} />;
    return part;
  })}</>;
}
