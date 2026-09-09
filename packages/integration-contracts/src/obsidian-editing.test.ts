import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mergeWikiEditorial, obsidianEditOperationSchema, atomicEditorial } from './obsidian-editing.js';
import { sectionStart, sectionEnd, wikiGeneratedStart, wikiGeneratedEnd } from './obsidian-format.js';
const first = randomUUID(), second = randomUUID();
function page(a: string, b: string) { return `# Page\n\n${sectionStart(first)}\n## Same\n\n${a}\n${sectionEnd(first)}\n\n^memora-section-${first}\n\n${sectionStart(second)}\n## Same\n\n${b}\n${sectionEnd(second)}\n\n^memora-section-${second}\n\n${wikiGeneratedStart}\nEvidence.\n${wikiGeneratedEnd}\n`; }
describe('editorial merge boundary', () => {
    it('merges distinct anchored sections even with identical text', () => { expect(mergeWikiEditorial(page('same', 'same'), page('local', 'same'), page('same', 'app'))).toBe(page('local', 'app')); });
    it('uses anchors when one section contains the other text', () => { expect(mergeWikiEditorial(page('same', 'prefix same suffix'), page('local', 'prefix same suffix'), page('same', 'app'))).toBe(page('local', 'app')); });
    it('rejects overlapping changes and changed generated evidence', () => { expect(mergeWikiEditorial(page('a', 'b'), page('local', 'b'), page('app', 'b'))).toBeNull(); expect(mergeWikiEditorial(page('a', 'b'), page('a', 'b').replace('Evidence.', 'Injected'), page('a', 'b'))).toBeNull(); });
    it('preserves hard breaks, code indentation, Unicode and fenced control examples', () => { const value = '日本語  \n    code\n```md\n<!-- memora:generated:start -->\n```'; expect(mergeWikiEditorial(page('a', 'b'), page(value, 'b'), page('a', 'app'))).toBe(page(value, 'app')); });
    it('rejects missing, duplicated and reordered section anchors', () => { const base = page('a', 'b'); expect(mergeWikiEditorial(base, base.replace(sectionStart(first), ''), base)).toBeNull(); expect(mergeWikiEditorial(base, base.replaceAll(second, first), base)).toBeNull(); });
    it('keeps note relation fences read only while fenced examples stay prose', () => { expect(atomicEditorial('```md\n<!-- memora:relations:start -->\n```\n')).toEqual({ editorial: '```md\n<!-- memora:relations:start -->\n```\n', generated: '' }); expect(atomicEditorial('text\n<!-- memora:relations:start -->\nno end')).toBeNull(); });
    it('rejects unbounded protocol content and traversal', () => { expect(obsidianEditOperationSchema.safeParse({ version: 1, operationId: randomUUID(), vaultId: randomUUID(), binding: 'a'.repeat(64), targetId: randomUUID(), targetType: 'wiki_page', kind: 'edit', relativePath: '../evil', baseRevision: 'r', baseVersion: 1, baseHash: 'a'.repeat(64), content: '', occurredAt: new Date().toISOString() }).success).toBe(false); });
});
