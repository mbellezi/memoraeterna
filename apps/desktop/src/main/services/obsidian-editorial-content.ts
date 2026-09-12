import { sourceOriginal, replaceSourceOriginal } from '@app/integration-contracts';
import { markdownHeading, normalizeProjectionText, parseObsidianMarkdown, parseWikiRegions, sectionEnd, sectionStart, atomicEditorial, mergeWikiEditorial } from '@app/integration-contracts';
export function wikiTitle(text: string): string {
    const match = /^# ([^\n]+)\n/.exec(text);
    if (!match)
        throw new Error('obsidianWiki.errors.format');
    return match[1]!.replace(/\\([\\[\]#<>*_])/g, '$1');
}
export function wikiSections(body: string) {
    const regions = parseWikiRegions(body);
    if (!regions)
        throw new Error('obsidianWiki.errors.format');
    let remainder = regions.editorial;
    for (const s of [...regions.sections].reverse())
        remainder = remainder.slice(0, s.start) + remainder.slice(s.end);
    remainder = remainder.replace(/^# [^\n]+\n/, '');
    const sections = regions.sections.map(s => {
        const heading = /^## ([^\n]+)\n\n([\s\S]*)$/.exec(s.markdown);
        if (!heading)
            throw new Error('obsidianWiki.errors.format');
        remainder = remainder.replace('^memora-section-' + s.id, '');
        return { id: s.id, title: heading[1]!.replace(/\\([\\[\]#<>*_])/g, '$1'), markdown: heading[2]! };
    });
    if (remainder.trim())
        throw new Error('obsidianWiki.errors.format');
    return { title: wikiTitle(regions.editorial), sections, generated: regions.generated };
}
export function renderWikiCurrent(baseBody: string, content: {
    title: string;
    sections: Array<{
        id: string;
        title: string;
        markdown: string;
    }>;
}) {
    const regions = parseWikiRegions(baseBody);
    if (!regions)
        throw new Error('obsidianWiki.errors.format');
    return '# ' + markdownHeading(content.title) + '\n\n' + content.sections.map(s => `${sectionStart(s.id)}\n## ${markdownHeading(s.title)}\n\n${s.markdown}\n${sectionEnd(s.id)}\n\n^memora-section-${s.id}\n`).join('\n') + '\n' + regions.generated;
}
export function validateEditorialChange(base: string, local: string, current: string, type: string, force = false): string | null {
    const b = parseObsidianMarkdown(base), l = parseObsidianMarkdown(local), c = parseObsidianMarkdown(current);
    if (!b || !l || !c || JSON.stringify(b.frontmatter) !== JSON.stringify(l.frontmatter))
        return null;
    if (b.frontmatter.memoraLayout === 2 && ['source_item','source_reference'].includes(type)) {
        const bs=sourceOriginal(b.bodyMarkdown),ls=sourceOriginal(l.bodyMarkdown),cs=sourceOriginal(c.bodyMarkdown);
        if(!bs||!ls||!cs||bs.before!==ls.before||bs.after!==ls.after||type==='source_item'&&bs.original===''&&ls.original!=='')return null;
        if(!force&&bs.original!==cs.original&&ls.original!==cs.original)return null;
        return replaceSourceOriginal(c.bodyMarkdown,ls.original);
    }
    if (b.frontmatter.memoraLayout === 2 && type==='atomic_note') {const bs=parseWikiRegions(b.bodyMarkdown),ls=parseWikiRegions(l.bodyMarkdown),cs=parseWikiRegions(c.bodyMarkdown);if(!bs||!ls||!cs||bs.generated!==ls.generated)return null;if(!force&&bs.editorial!==cs.editorial&&ls.editorial!==cs.editorial)return null;return ls.editorial+cs.generated;}
    if (type === 'wiki_page') {
        try {
            const bs = wikiSections(b.bodyMarkdown), ls = wikiSections(l.bodyMarkdown);
            if (bs.generated !== ls.generated || bs.sections.map(s => s.id).join() !== ls.sections.filter(s => bs.sections.some(b => b.id === s.id)).map(s => s.id).join())
                return null;
            if (bs.sections.length !== ls.sections.length)
                return force || b.bodyMarkdown === c.bodyMarkdown ? l.bodyMarkdown : null;
            return force ? l.bodyMarkdown : mergeWikiEditorial(b.bodyMarkdown, l.bodyMarkdown, c.bodyMarkdown);
        }
        catch {
            return null;
        }
    }
    if (type === 'source_reference') {
        const bs = parseWikiRegions(b.bodyMarkdown), ls = parseWikiRegions(l.bodyMarkdown), cs = parseWikiRegions(c.bodyMarkdown);
        if (!bs || !ls || !cs || bs.generated !== ls.generated)
            return null;
        if (!force && bs.editorial !== cs.editorial && ls.editorial !== cs.editorial)
            return null;
        return ls.editorial;
    }
    if (type === 'atomic_note') {
        const bs = atomicEditorial(b.bodyMarkdown), ls = atomicEditorial(l.bodyMarkdown);
        if (!bs || !ls || bs.generated !== ls.generated)
            return null;
    }
    if (!force && normalizeProjectionText(b.bodyMarkdown) !== normalizeProjectionText(c.bodyMarkdown) && l.bodyMarkdown !== c.bodyMarkdown)
        return null;
    return l.bodyMarkdown;
}
