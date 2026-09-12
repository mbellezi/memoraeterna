import { posix } from 'node:path';
import type { ObsidianLayoutConfig } from '@app/integration-contracts';

const labels = {
  en: ['Atomic notes','Sources','Attachments','Index','Home','Themes','Entities','Syntheses','Investigations','Maps','Books','Chapters','Articles','Academic','Web','Standalone','Periodicals','Sections','Videos','Documents','Personal notes','Daily','Notes for this source'],
  'pt-BR': ['Notas atômicas','Fontes','Anexos','Índice','Início','Temas','Entidades','Sínteses','Investigações','Mapas','Livros','Capítulos','Artigos','Acadêmicos','Web','Avulsos','Periódicos','Seções','Vídeos','Documentos','Notas pessoais','Diário','Notas desta fonte'],
  it: ['Note atomiche','Fonti','Allegati','Indice','Inizio','Temi','Entità','Sintesi','Indagini','Mappe','Libri','Capitoli','Articoli','Accademici','Web','Autonomi','Periodici','Sezioni','Video','Documenti','Note personali','Diario','Note di questa fonte'],
  fr: ['Notes atomiques','Sources','Pièces jointes','Index','Accueil','Thèmes','Entités','Synthèses','Enquêtes','Cartes','Livres','Chapitres','Articles','Académiques','Web','Indépendants','Périodiques','Sections','Vidéos','Documents','Notes personnelles','Journal','Notes de cette source'],
  es: ['Notas atómicas','Fuentes','Adjuntos','Índice','Inicio','Temas','Entidades','Síntesis','Investigaciones','Mapas','Libros','Capítulos','Artículos','Académicos','Web','Independientes','Periódicos','Secciones','Vídeos','Documentos','Notas personales','Diario','Notas de esta fuente']
} as const;
export function layoutLabels(language: ObsidianLayoutConfig['language']) {
  const [notes,sources,assets,index,home,topics,entities,syntheses,investigations,maps,books,chapters,articles,academic,web,standalone,periodicals,sections,videos,documents,personal,daily,sourceNotes] = labels[language];
  return { notes,sources,assets,index,home,topics,entities,syntheses,investigations,maps,books,chapters,articles,academic,web,standalone,periodicals,sections,videos,documents,personal,daily,sourceNotes };
}
/** NFC display names; byte bounds leave room for a collision suffix on portable filesystems. */
export function portableName(value: string) {
  let name = value.normalize('NFC').replace(/[\x00-\x1f\x7f\\/:*?"<>|#\[\]]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '') || 'Untitled';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  while (Buffer.byteLength(name) > 150) name = [...name].slice(0, -1).join('');
  return name;
}
export const pathIdentity = (path: string) => path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
export interface LayoutSource { id: string; title: string; type: string; parentId?: string | null; position?: number | null; metadata?: Record<string, any>; bibliography?: Record<string, any>[] }
export function sourceLayoutPath(root: string, source: LayoutSource, sources: LayoutSource[], language: ObsidianLayoutConfig['language'], seen = new Set<string>()): string {
  if (seen.has(source.id)) throw new Error('wiki.errors.cycle');
  seen.add(source.id);
  const l = layoutLabels(language), title = portableName(source.title), parent = sources.find(p => p.id === source.parentId);
  let directory = posix.join(root, l.sources), file = title + '.md';
  if (parent) {
    const parentPath = sourceLayoutPath(root,parent,sources,language,seen);
    directory = posix.join(posix.dirname(parentPath), parent.type === 'Book' ? l.chapters : parent.type === 'PeriodicalIssue' ? l.articles : l.sections);
    if (typeof source.position === 'number') file = String(source.position + 1).padStart(2, '0') + ' — ' + file;
  } else {
    const creators = source.metadata?.creators ?? source.bibliography?.[0]?.creators ?? [];
    const author = creators.map((c: any) => typeof c === 'string' ? c : c.name ?? c.displayName ?? [c.givenName,c.familyName].filter(Boolean).join(' ')).filter(Boolean).join(', ');
    if (source.type === 'Book') directory = posix.join(directory,l.books,portableName([author,source.title].filter(Boolean).join(' — ')));
    else if (source.type === 'AcademicPaper') directory = posix.join(directory,l.articles,l.academic,title);
    else if (source.type === 'PeriodicalIssue') directory = posix.join(directory,l.periodicals,title);
    else if (source.type === 'WebArticle') directory = posix.join(directory,l.articles,l.web);
    else if (source.type === 'StandaloneArticle') directory = posix.join(directory,l.articles,l.standalone);
    else if (source.type === 'Video') directory = posix.join(directory,l.videos);
    else if (source.type === 'PersonalNote') directory = posix.join(directory,l.personal);
    else if (source.type === 'DailyNote') {
      directory = posix.join(directory,l.daily);
      const date = source.metadata?.date ?? source.metadata?.descriptor?.date;
      if (typeof date === 'string' && /^\d{4}-(0[1-9]|1[0-2])-[0-3]\d$/.test(date)) directory = posix.join(directory,date.slice(0,4),date.slice(5,7));
    } else directory = posix.join(directory,l.documents);
  }
  const path = posix.join(directory,file);
  if (Buffer.byteLength(path) > 900) throw new Error('obsidianWiki.errors.limit');
  return path;
}
