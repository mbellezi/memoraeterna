// Three synthetic notes of the committed matching benchmark (`scripts/fixtures/matching-benchmark.json`),
// the scenario of the Decisions API's replayed cassette: a source note about retrieval practice with
// correction (P02), a note that says the same thing in other words (P01a, an expected relation of the
// benchmark) and a decoy that shares its vocabulary and not its subject (P04, a forbidden one). All
// fictional text, safe to send. With these notes the source's two candidate orders differ, so the
// scenario's plan has the four requests of the design (two orders of the source's list, one list per
// candidate).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ScenarioNote {
  id: string;
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
  status: string;
  supersessionStatus: string;
  createdFromSourceItemId: string;
  metadata: Record<string, unknown>;
}

interface BenchmarkSource {
  key: string;
  title: string;
  content?: string;
  ideas?: string[];
  chapters?: Array<{ key: string; title: string; content: string; ideas: string[] }>;
}

export function decisionsScenarioNotes(root = process.cwd()): {
  source: ScenarioNote;
  related: ScenarioNote;
  decoy: ScenarioNote;
} {
  const benchmark = JSON.parse(
    readFileSync(join(root, "scripts/fixtures/matching-benchmark.json"), "utf8")
  ) as { sources: BenchmarkSource[] };
  const find = (key: string) => benchmark.sources.find((entry) => entry.key === key)!;
  const note = (
    id: string,
    title: string,
    ideas: string[] | undefined,
    content: string | undefined
  ): ScenarioNote => ({
    id,
    title,
    ideaStatement: ideas![0]!,
    bodyMarkdown: content!,
    status: "active",
    supersessionStatus: "current",
    createdFromSourceItemId: `source-${id}`,
    metadata: {}
  });
  const source = find("P02");
  const related = find("P01").chapters!.find((entry) => entry.key === "P01a")!;
  const decoy = find("P04");
  return {
    source: note("n-source", source.title, source.ideas, source.content),
    related: note("n-related", related.title, related.ideas, related.content),
    decoy: note("n-decoy", decoy.title, decoy.ideas, decoy.content)
  };
}
