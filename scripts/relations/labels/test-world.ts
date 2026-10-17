/**
 * Synthetic libraries for the label-set tests: small, deterministic, with every stratum populated,
 * fixture held-out roots, shared topic leaves across roots and ring-shaped root neighbours.
 */
import {
  contextFormat,
  evidenceFormat,
  sha256Hex,
  sortedPair,
  type LibraryContext,
  type LibraryEvidence,
  type LabelSet
} from "./common.ts";
import type { NoteText, RenderSources } from "./render.ts";
import type { LibraryInput, PanelSizes, SampleInput } from "./sample.ts";

export const testSizes: PanelSizes = {
  poolA: 30,
  poolB: 20,
  poolC: 20,
  hardNegatives: 6,
  rv9Sample: 5,
  sourceBase: { fixture: 5, golden: 4, corpus: 5 },
  neighbourRoots: { golden: Number.POSITIVE_INFINITY, corpus: 4 },
  consistency: 3
};

/** A score in [-4, 10) that depends only on the pair. */
export const syntheticScore = (lo: string, hi: string): number =>
  (parseInt(sha256Hex(`${lo}|${hi}`).slice(0, 6), 16) % 1400) / 100 - 4;

export interface TestLibrary {
  input: LibraryInput;
  texts: Map<string, NoteText>;
}

export function testLibrary(
  library: "fixture" | "golden" | "corpus",
  roots: number,
  notesPerRoot: number,
  options: { holdoutEvery?: number; language?: string } = {}
): TestLibrary {
  const rootIds = Array.from(
    { length: roots },
    (_, index) => `${library}-root-${String(index).padStart(2, "0")}`
  );
  const notes = rootIds.flatMap((rootId, rootIndex) =>
    Array.from({ length: notesPerRoot }, (_, noteIndex) => ({
      id: `${library}-note-${String(rootIndex).padStart(2, "0")}-${noteIndex}`,
      sourceItemId: rootId,
      rootId,
      language: options.language ?? (rootIndex % 2 === 0 ? "pt-BR" : "en"),
      leafTopicId: `leaf-${(rootIndex + noteIndex) % 4}`
    }))
  );
  const context: LibraryContext = {
    format: contextFormat,
    version: 1,
    profile: `test-${library}`,
    libraryDigest: `digest-${library}`,
    rootVectorBasis: "test",
    sources: rootIds.map((id, index) => ({
      id,
      parentId: null,
      rootId: id,
      title: `Root ${index} of the test`,
      language: "pt-BR"
    })),
    notes,
    roots: rootIds.map((id, index) => ({
      id,
      title: `Root ${index} of the test`,
      language: "pt-BR",
      notes: notesPerRoot,
      overview: `Overview of root ${index}.`,
      overviewBasis: "summary" as const,
      neighbours: [1, -1, 2].map((step, rank) => ({
        id: rootIds[(index + step + roots) % roots]!,
        cosine: 0.9 - rank / 10
      }))
    }))
  };
  const pairs: Array<[string, string]> = [];
  for (let a = 0; a < notes.length; a += 1)
    for (let b = a + 1; b < notes.length; b += 1) pairs.push([notes[a]!.id, notes[b]!.id]);
  const scores = new Map(
    pairs.map(([a, b]) => {
      const [lo, hi] = sortedPair(a, b);
      return [`${lo}:${hi}`, syntheticScore(lo, hi)] as const;
    })
  );
  const holdoutEvery = options.holdoutEvery ?? 0;
  const partition = new Map(
    rootIds.map((id, index) => [
      id,
      holdoutEvery > 0 && index % holdoutEvery === 0 ? "holdout" : "tuning"
    ])
  );
  const texts = new Map(
    notes.map((note) => [
      note.id,
      {
        title: `Title of ${note.id.slice(-4)}`,
        idea: `Idea ${note.id.slice(-4)} about a mechanism.`,
        body: `Body of the note ${"with words ".repeat(80)}end.`
      }
    ])
  );
  return {
    input: {
      library,
      context,
      pairs,
      scores,
      texts: new Set(notes.map((note) => note.id)),
      partitionOfRoot: (rootId) => (library === "fixture" ? (partition.get(rootId) ?? null) : null)
    },
    texts
  };
}

export interface TestWorld {
  input: SampleInput;
  libraries: Record<"fixture" | "golden" | "corpus", TestLibrary>;
  spikeTexts: Map<string, NoteText>;
}

export function testWorld(seed = 20261018): TestWorld {
  const libraries = {
    fixture: testLibrary("fixture", 12, 4, { holdoutEvery: 3, language: "pt-BR" }),
    golden: testLibrary("golden", 6, 5),
    corpus: testLibrary("corpus", 10, 4)
  };
  const fixtureNotes = libraries.fixture.input.context.notes;
  // R_v9: some tuning pairs (which pool A may also draw) and some with a held-out root.
  const rv9 = fixtureNotes
    .slice(0, 16)
    .map(
      (note, index) => [note.id, fixtureNotes[(index * 5 + 7) % fixtureNotes.length]!.id] as const
    );
  const spikeTexts = new Map<string, NoteText>();
  const rv6 = Array.from({ length: 4 }, (_, index) => {
    const a = `spike-note-${index}a`;
    const b = `spike-note-${index}b`;
    spikeTexts.set(a, {
      title: `Earlier title ${index}a`,
      idea: `Idea ${index}a.`,
      body: `Body ${index}a.`
    });
    spikeTexts.set(b, {
      title: `Earlier title ${index}b`,
      idea: `Idea ${index}b.`,
      body: `Body ${index}b.`
    });
    return {
      a,
      b,
      aRoot: `S${index}`,
      bRoot: `S${index + 1}`,
      partitions: ["tuning", "tuning"] as [string, string]
    };
  });
  return {
    libraries,
    spikeTexts,
    input: {
      seed,
      fixture: libraries.fixture.input,
      golden: libraries.golden.input,
      corpus: libraries.corpus.input,
      rv6,
      rv9,
      inputs: { test: "inputs" },
      sizes: testSizes
    }
  };
}

/** Evidence and texts for rendering a label set drawn from a test world. */
export function testRenderSources(world: TestWorld, set: LabelSet): RenderSources {
  const evidence = (library: "fixture" | "golden" | "corpus"): LibraryEvidence => ({
    format: evidenceFormat,
    version: 1,
    profile: `test-${library}`,
    libraryDigest: `digest-${library}`,
    pairs: set.items
      .filter((item) => item.kind === "source" && item.library === library)
      .map((item) => ({
        lo: item.lo,
        hi: item.hi,
        loExcerpts: [
          {
            chunkId: `${item.lo}-c1`,
            text: `First excerpt of ${item.lo.slice(-2)}.`,
            focus: 0,
            noteId: "n",
            cosine: 0.8
          }
        ],
        hiExcerpts: [
          {
            chunkId: `${item.hi}-c1`,
            text: `First excerpt of ${item.hi.slice(-2)}.`,
            focus: null,
            noteId: "n",
            cosine: 0.8
          },
          {
            chunkId: `${item.hi}-c2`,
            text: `Second excerpt of ${item.hi.slice(-2)}.`,
            focus: null,
            noteId: "n",
            cosine: 0.7
          }
        ]
      }))
  });
  return {
    contexts: {
      fixture: world.libraries.fixture.input.context,
      golden: world.libraries.golden.input.context,
      corpus: world.libraries.corpus.input.context
    },
    evidence: {
      fixture: evidence("fixture"),
      golden: evidence("golden"),
      corpus: evidence("corpus")
    },
    texts: {
      fixture: world.libraries.fixture.texts,
      golden: world.libraries.golden.texts,
      corpus: world.libraries.corpus.texts,
      "spike-a": world.spikeTexts
    },
    spikeRoots: new Map(
      world.input.rv6.flatMap(
        (pair) =>
          [
            [pair.a, pair.aRoot],
            [pair.b, pair.bRoot]
          ] as const
      )
    ),
    spikeRootTitles: new Map(
      world.input.rv6.flatMap(
        (pair) =>
          [
            [pair.aRoot, `Earlier root ${pair.aRoot}`],
            [pair.bRoot, `Earlier root ${pair.bRoot}`]
          ] as const
      )
    )
  };
}
