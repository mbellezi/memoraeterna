import { sourceOriginal, replaceSourceOriginal } from "@app/integration-contracts";
import {
  normalizeProjectionText,
  parseObsidianMarkdown,
  parseWikiRegions,
  atomicEditorial
} from "@app/integration-contracts";
export function wikiTitle(text: string): string {
  const match = /^# ([^\n]+)\n/.exec(text);
  if (!match) throw new Error("obsidianWiki.errors.format");
  return match[1]!.replace(/\\([\\[\]#<>*_])/g, "$1");
}
export function validateEditorialChange(
  base: string,
  local: string,
  current: string,
  type: string,
  force = false
): string | null {
  const b = parseObsidianMarkdown(base),
    l = parseObsidianMarkdown(local),
    c = parseObsidianMarkdown(current);
  if (!b || !l || !c || JSON.stringify(b.frontmatter) !== JSON.stringify(l.frontmatter))
    return null;
  if (b.frontmatter.memoraLayout === 2 && ["source_item", "source_reference"].includes(type)) {
    const bs = sourceOriginal(b.bodyMarkdown),
      ls = sourceOriginal(l.bodyMarkdown),
      cs = sourceOriginal(c.bodyMarkdown);
    if (
      !bs ||
      !ls ||
      !cs ||
      bs.before !== ls.before ||
      bs.after !== ls.after ||
      (type === "source_item" && bs.original === "" && ls.original !== "")
    )
      return null;
    if (!force && bs.original !== cs.original && ls.original !== cs.original) return null;
    return replaceSourceOriginal(c.bodyMarkdown, ls.original);
  }
  if (b.frontmatter.memoraLayout === 2 && type === "atomic_note") {
    const bs = parseWikiRegions(b.bodyMarkdown),
      ls = parseWikiRegions(l.bodyMarkdown),
      cs = parseWikiRegions(c.bodyMarkdown);
    if (!bs || !ls || !cs || bs.generated !== ls.generated) return null;
    if (!force && bs.editorial !== cs.editorial && ls.editorial !== cs.editorial) return null;
    return ls.editorial + cs.generated;
  }
  if (type === "source_reference") {
    const bs = parseWikiRegions(b.bodyMarkdown),
      ls = parseWikiRegions(l.bodyMarkdown),
      cs = parseWikiRegions(c.bodyMarkdown);
    if (!bs || !ls || !cs || bs.generated !== ls.generated) return null;
    if (!force && bs.editorial !== cs.editorial && ls.editorial !== cs.editorial) return null;
    return ls.editorial;
  }
  if (type === "atomic_note") {
    const bs = atomicEditorial(b.bodyMarkdown),
      ls = atomicEditorial(l.bodyMarkdown);
    if (!bs || !ls || bs.generated !== ls.generated) return null;
  }
  if (
    !force &&
    normalizeProjectionText(b.bodyMarkdown) !== normalizeProjectionText(c.bodyMarkdown) &&
    l.bodyMarkdown !== c.bodyMarkdown
  )
    return null;
  return l.bodyMarkdown;
}
