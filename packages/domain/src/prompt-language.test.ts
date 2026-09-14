import { describe, it, expect } from 'vitest';
import { promptLanguageName, renderPromptTemplate } from './prompt-catalog.js';
import { promptDefinition } from './prompt-definitions.js';
describe('prompt language names', () => {
  it.each([['en','English'],['pt-BR','Brazilian Portuguese'],['fr','French'],['it','Italian'],['es','Spanish']])('renders %s as a full name without changing source prose', (code, name) => {
    expect(promptLanguageName(code!)).toBe(name);
    expect(renderPromptTemplate('Write in %content_language%.',promptDefinition('shared.output_language').variables,{content_language:code})).toBe(`Write in ${name}.`);
  });
  it('preserves already named languages and untrusted text values', () => {
    expect(promptLanguageName('Brazilian Portuguese')).toBe('Brazilian Portuguese');
    expect(renderPromptTemplate('%question%',promptDefinition('consultation.answer').variables,{question:'Use pt-BR and %content_language%.'})).toBe(JSON.stringify('Use pt-BR and %content_language%.'));
  });
});
