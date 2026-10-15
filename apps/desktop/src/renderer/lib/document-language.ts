import { useEffect } from "react";

/** The part of the root element the language code writes, so tests need no DOM. */
export interface LanguageRoot {
  lang: string;
}

/**
 * Marks the document with the interface language (a BCP 47 tag: en, pt-BR, it, fr, es). Screen
 * readers pick their voice and pronunciation from it, and the browser its hyphenation and
 * spellcheck; `index.html` only holds the value used before the first render.
 */
export function applyDocumentLanguage(root: LanguageRoot, language: string): void {
  if (root.lang !== language) root.lang = language;
}

/** Keeps `<html lang>` on the interface language as it changes. */
export function useDocumentLanguage(language: string): void {
  useEffect(() => {
    applyDocumentLanguage(document.documentElement, language);
  }, [language]);
}
