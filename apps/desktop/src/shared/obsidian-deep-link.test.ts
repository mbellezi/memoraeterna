import { it, expect } from 'vitest';
import { parseObsidianDeepLink } from './obsidian-deep-link.js';
const id = 'b14cde4a-ce8d-41b8-804f-6412779354f2';
it('accepts only typed read-only routes and exact historical evidence identifiers', () => { expect(parseObsidianDeepLink(`memora://open/wiki/${id}?revision=${id}&evidence=${id}`)).toEqual({ kind: 'wiki', id, revision: id, evidence: id }); for (const raw of [`https://open/wiki/${id}`, `memora://open/settings/${id}`, `memora://open/wiki/${id}?delete=true`, `memora://open/wiki/${id}?revision=${id}&revision=${id}`, `memora://user@open/wiki/${id}`, `memora://open/wiki/${id}/extra`])
    expect(parseObsidianDeepLink(raw)).toBeNull(); });
