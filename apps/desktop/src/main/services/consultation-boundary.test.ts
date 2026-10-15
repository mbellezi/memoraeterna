import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Ask answers from sources, chunks, notes, summary concepts, entity mentions and source relations.
 * It must keep working when the legacy wiki, organization and curator code and tables are deleted,
 * so none of its modules may reach for them.
 */
const root = resolve(import.meta.dirname, "../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const main = ["apps/desktop/src/main/services/consultation-service.ts"];
const data = [
  "packages/db/src/repositories/consultationRepository.ts",
  "packages/db/src/repositories/knowledgeConsultationRepository.ts",
  "packages/domain/src/consultation.ts"
];
const renderer = [
  "apps/desktop/src/renderer/components/ConsultationDialog.tsx",
  "apps/desktop/src/renderer/components/ask/EvidenceScopePicker.tsx",
  "apps/desktop/src/renderer/components/ask/ProfilePicker.tsx"
];
const files = [...main, ...data, ...renderer];
const legacy = /organization|wiki|curator|maintenance|investigation|automatic/i;

/** Every module an import or re-export names, with the bindings it takes from it. */
function imports(source: string) {
  const found: Array<{ from: string; names: string[] }> = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const names = [...match[1]!.matchAll(/(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([\w$]+))?/g)]
      .flatMap((m) => [m[1]!, m[2] ?? ""])
      .filter((name) => name && name !== "type");
    found.push({ from: match[2]!, names });
  }
  for (const match of source.matchAll(/(?:^|\s)import\s*["']([^"']+)["']/gm))
    found.push({ from: match[1]!, names: [] });
  return found;
}

describe("Ask is decoupled from the legacy wiki and the organization domain", () => {
  it.each(files)("%s imports no wiki, organization, curator or maintenance module", (file) => {
    for (const { from, names } of imports(read(file))) {
      expect(from, `${file} imports ${from}`).not.toMatch(legacy);
      for (const name of names) expect(name, `${file} imports ${name}`).not.toMatch(legacy);
    }
  });

  it.each([...main, ...data])(
    "%s reads no legacy table and has no page or domain scope",
    (file) => {
      const source = read(file);
      expect(source).not.toMatch(
        /\b(wiki|organization|maintenance|automatic_routine|knowledge_impact)_[a-z_]+/
      );
      expect(source).not.toMatch(/\bpageId\b|\bdomainId\b/);
    }
  );

  it.each(files)("%s throws and shows only consultation error keys", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/\b(organization|wiki|maintenance)\.errors\./);
  });

  it("maps the one key the AI service owns before it reaches the person", () => {
    const source = read(main[0]!);
    expect(source.match(/organization\\\.errors\\\.[A-Za-z]+/g)).toEqual([
      "organization\\.errors\\.model"
    ]);
  });

  it("reaches the main process only through the consultation and AI channels", () => {
    const calls = renderer.flatMap((file) =>
      [...read(file).matchAll(/window\.app\.([a-zA-Z]+)\s*\.\s*([a-zA-Z]+)/g)].map(
        (m) => `${m[1]}.${m[2]}`
      )
    );
    // The source picker still lists sources through the wiki search channel.
    expect([...new Set(calls)].toSorted()).toEqual([
      "ai.listProfiles",
      "consultation.ask",
      "consultation.cancel",
      "wiki.search"
    ]);
  });

  it("is hosted without a page", () => {
    const dialog = read(renderer[0]!);
    expect(dialog).not.toMatch(/WikiPage|\bpage\b\s*[:=?]/);
    expect(dialog).not.toContain("FollowedQuestions");
    expect(dialog).not.toContain("OrganizationRuns");
  });
});
