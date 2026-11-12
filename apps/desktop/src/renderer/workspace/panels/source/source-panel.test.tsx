import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, type Translator } from "@app/i18n";

import type { LibrarySourceProgress } from "../../../../shared/ipc-library";
import { matchPanel, panelRegistry } from "../../PanelStack";
import { kind, loadStateOf, match, title } from "../source.panel";
import { openInMapAddress } from "./open-in-map";
import type { NotePath, SourceSnapshot } from "./source-controller";
import {
  doneProgress,
  noteIds,
  runningProgress,
  sourceFixture,
  sourceFixtureAddress
} from "./source-panel-fixtures";
import { SourcePanelView } from "./SourcePanelView";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const now = new Date(2026, 10, 12, 9, 30).getTime();
const detail = sourceFixture(now);
const topicChip = (title: string): NotePath => ({
  status: "placed",
  crumbs: [{ id: "00000000-0000-4000-8000-000000000101", title }]
});

function snapshot(overrides: Partial<SourceSnapshot> = {}): SourceSnapshot {
  return {
    load: { status: "ready", detail },
    strip: { status: "ready", progress: runningProgress(now) },
    paths: new Map<string, NotePath>([
      [noteIds[0] as string, { status: "unplaced" }],
      [noteIds[1] as string, topicChip("Active mobility")]
    ]),
    cost: { status: "ready", estimate: { billing: "local" } },
    action: { status: "idle" },
    firstSource: false,
    readAt: now,
    ...overrides
  };
}

function page(
  state: SourceSnapshot,
  options: { t?: Translator; address?: string; mode?: "full" | "compact"; current?: string } = {}
) {
  return renderToString(
    <SourcePanelView
      t={options.t ?? en}
      address={options.address ?? sourceFixtureAddress}
      mode={options.mode ?? "full"}
      current={options.current}
      detail={detail}
      snapshot={state}
      handlers={{ onOpen: vi.fn(), onRetryStrip: vi.fn(), onRun: vi.fn(), want: vi.fn() }}
    />
  );
}

const stripOf = (progress: LibrarySourceProgress | null): Partial<SourceSnapshot> => ({
  strip: progress ? { status: "ready", progress } : { status: "loading" }
});

describe("the panel module", () => {
  it("is the one for a source address, with or without an anchor, and for nothing else", () => {
    expect(kind).toBe("source");
    expect(match(sourceFixtureAddress)).toBe(true);
    expect(match(`${sourceFixtureAddress}#passage=${noteIds[0]}`)).toBe(true);
    expect(match(`${sourceFixtureAddress}#relation=${noteIds[0]}`)).toBe(true);
    expect(match(`memora://note/${noteIds[0]}`)).toBe(false);
    expect(match("memora://library")).toBe(false);
    expect(matchPanel(panelRegistry, sourceFixtureAddress)?.kind).toBe("source");
  });

  it("titles the spine with the summary's title", () => {
    expect(title({ title: "Complete streets" } as never)).toBe("Complete streets");
    expect(title(null)).toBe("");
  });

  it("reports one of the four states for each read", () => {
    expect(loadStateOf(snapshot({ load: { status: "loading" } }))).toBe("loading");
    expect(loadStateOf(snapshot({ load: { status: "error" } }))).toBe("error");
    expect(loadStateOf(snapshot({ load: { status: "missing" } }))).toBe("empty");
    expect(loadStateOf(snapshot())).toBe("success");
  });

  it("opens the Map on the source's relations, scoped to it (the stub T152 completes)", () => {
    expect(openInMapAddress(detail.id)).toBe(
      `memora://map/relations?scope=${encodeURIComponent(`memora://source/${detail.id}`)}`
    );
  });
});

describe("the live generation strip", () => {
  it("shows the header, six steps with their values, and the section ruler while it runs", () => {
    const html = page(snapshot());
    expect(html).toContain('data-strip="running"');
    expect(html).toContain("Generating knowledge from this source");
    for (const word of ["Read", "Passages", "Notes", "In the tree", "Summary", "Connections"])
      expect(html).toContain(`>${word}</b>`);
    expect(html).toContain("24 pages");
    expect(html).toContain("142 searchable");
    expect(html).toContain("7 of ~18");
    expect(html).toContain("6 placed");
    expect(html).toContain("after the notes");
    expect(html).toContain("Notes by section of the text");
    expect(html).toContain("Medellín");
    expect(html).toContain("local model, no cost");
    expect(html).toMatch(/about 8\u00a0min left/u);
    expect(html).toContain("ask this source");
  });

  it("lays the six steps out 3 by 2 in a compact strip and 6 across in a roomy one", () => {
    const html = page(snapshot());
    expect(html).toContain("grid-cols-3");
    expect(html).toContain("@md:grid-cols-6");
    expect(html).toContain("@max-md:nth-3:before:hidden");
  });

  it("says no time left, no money, when it knows neither", () => {
    const noEstimate = runningProgress(now);
    noEstimate.steps.notes = { state: "running", soFar: 0, estimate: null };
    const html = page(snapshot({ ...stripOf(noEstimate), cost: { status: "idle" } }));
    expect(html).not.toContain("min left");
    expect(html).not.toContain("no cost");
    expect(html).toContain("since ");
  });

  it("collapses to one line when the run is done", () => {
    const html = page(snapshot(stripOf(doneProgress(now))));
    expect(html).toContain('data-strip="done"');
    expect(html).toMatch(/Ready in 4\u00a0min/u);
    expect(html).toContain("18 notes");
    expect(html).toContain("12 connections");
    expect(html).not.toContain("Generating knowledge");
  });

  it("names the failed stage in words, keeps what is saved, and offers one retry", () => {
    const failed = runningProgress(now);
    failed.run = {
      ...(failed.run as NonNullable<typeof failed.run>),
      status: "failed",
      failedStage: "atomicNotes"
    };
    const html = page(snapshot(stripOf(failed)));
    expect(html).toContain('data-strip="error"');
    expect(html).toContain("Could not finish the notes.");
    expect(html).toContain("What is already done stays saved.");
    expect(html.match(/Retry|Try again/gu)?.length).toBe(1);
    expect(html).not.toContain("atomicNotes");
  });

  it("says a model is needed, with one way to choose it", () => {
    const html = page(
      snapshot(stripOf({ ...runningProgress(now), needsYou: "no_model.no_route" }))
    );
    expect(html).toContain('data-strip="needsYou"');
    expect(html).toContain("A model is needed to write the notes.");
    expect(html).toContain("Choose the model");
  });

  it("says paused, with no control that does nothing", () => {
    const html = page(snapshot(stripOf({ ...runningProgress(now), paused: true })));
    expect(html).toContain('data-strip="paused"');
    expect(html).toContain("Paused by you.");
    const strip = html.slice(html.indexOf('data-strip="paused"'));
    expect(strip.slice(0, strip.indexOf("</section>"))).not.toContain("<button");
  });

  it("offers 'Generate notes' for a source stored on purpose", () => {
    const searchOnly = doneProgress(now);
    searchOnly.steps.notes = { state: "notApplicable", soFar: 0, estimate: null };
    searchOnly.steps.summary = { state: "notApplicable" };
    searchOnly.steps.relations = { state: "notApplicable", count: 0 };
    const html = page(snapshot(stripOf(searchOnly)));
    expect(html).toContain('data-strip="searchable"');
    expect(html).toContain("Stored and searchable, without notes.");
    expect(html).toContain("Generate notes");
  });

  it("draws the strip's own loading and failure in place, without taking the panel down", () => {
    const loading = page(snapshot({ strip: { status: "loading" } }));
    expect(loading).toContain('aria-hidden="true"');
    expect(loading).not.toContain("data-strip");
    const failed = page(snapshot({ strip: { status: "error" } }));
    expect(failed).toContain("The progress could not be read just now.");
    expect(failed.match(/Retry|Try again/gu)?.length).toBe(1);
    expect(failed).toContain("<h1");
  });
});

describe("the notes", () => {
  it("list newest first with the path chip, the section and the new-dot, and no fill on the newest", () => {
    const html = page(snapshot());
    expect(html).toContain("data-path-chip");
    expect(html).toContain('data-path="Active mobility"');
    expect(html).toContain("just now");
    expect(html).toContain("Looking for a place in the tree…");
    expect(html.indexOf("Protected bike lanes")).toBeLessThan(html.indexOf("A bus-only lane"));
    expect(html).toContain("7 so far · newest first");
    expect(html).toContain(`data-address="memora://note/${noteIds[1]}"`);
    expect(html).toContain("p. 9");
    expect(html).toContain("passage 1");
  });

  it("shows only the first six in the Overview, with a way to see all of them", () => {
    const html = page(snapshot());
    expect(html).toContain("See all 7 notes");
    expect(html).not.toContain("Short blocks lengthen the routes people walk");
  });

  it("holds one skeleton row for the next note while the notes are being written", () => {
    expect(page(snapshot())).toContain('<li aria-hidden="true"');
    expect(page(snapshot(stripOf(doneProgress(now))))).not.toContain('<li aria-hidden="true"');
  });

  it("introduces the Gardener on the first source, and teaches the row gestures otherwise", () => {
    expect(page(snapshot())).toContain("peeks without opening");
    const first = page(snapshot({ firstSource: true }));
    expect(first).toContain("the Gardener tidies the tree");
    expect(first).not.toContain("peeks without opening");
    expect(page(snapshot(stripOf(doneProgress(now))))).not.toContain("peeks without opening");
  });

  it("says what an empty source is and what to do, never a blank", () => {
    const bare = { ...detail, atomicNotes: [] };
    const html = renderToString(
      <SourcePanelView
        t={en}
        address={sourceFixtureAddress}
        mode="full"
        detail={bare}
        snapshot={snapshot({ ...stripOf({ ...doneProgress(now), run: null }) })}
        handlers={{ onOpen: vi.fn(), onRetryStrip: vi.fn(), onRun: vi.fn(), want: vi.fn() }}
      />
    );
    expect(html).toContain("No notes from this source yet");
    expect(html).toContain("Generate notes");
  });
});

describe("the tabs", () => {
  const tabs = (html: string) =>
    [...html.matchAll(/data-tab="([a-z]+)"/gu)].map((match) => match[1]);

  it("are Overview, Notes, Connections, Content and Details, with counts on the lists", () => {
    const html = page(snapshot());
    expect(tabs(html)).toEqual(["overview", "notes", "connections", "content", "details"]);
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(
      /aria-selected="true"[^>]*data-tab="overview"|data-tab="overview"[^>]*aria-selected="true"/u
    );
  });

  it("opens Connections for a relation anchor and Content for a passage anchor", () => {
    const relation = page(snapshot(), {
      address: `${sourceFixtureAddress}#relation=${noteIds[0]}`
    });
    expect(relation).toMatch(
      /aria-selected="true"[^>]*data-tab="connections"|data-tab="connections"[^>]*aria-selected="true"/u
    );
    expect(relation).toContain("Connections between this source");
    const chunk = detail.documents[0]?.chunks[2]?.id as string;
    const passage = page(snapshot(), { address: `${sourceFixtureAddress}#passage=${chunk}` });
    expect(passage).toMatch(
      /aria-selected="true"[^>]*data-tab="content"|data-tab="content"[^>]*aria-selected="true"/u
    );
    expect(passage).toContain("Showing the cited passage");
    expect(passage).toContain('id="cited-passage"');
    expect(passage).toContain("Traffic did not worsen");
  });

  it("opens Content on a span too, and says so when the passage is no longer there", () => {
    const span = detail.documents[0]?.chunks[1]?.sourceSpanId as string;
    expect(page(snapshot(), { address: `${sourceFixtureAddress}#span=${span}` })).toContain(
      'id="cited-passage"'
    );
    const gone = page(snapshot(), {
      address: `${sourceFixtureAddress}#passage=00000000-0000-4000-8000-0000000000ff`
    });
    expect(gone).toContain("not in the current version of the source");
    expect(gone).not.toContain('id="cited-passage"');
  });

  it("show no graph in Connections (the Map owns it, D19)", () => {
    const html = page(snapshot(), { address: `${sourceFixtureAddress}#relation=${noteIds[0]}` });
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("SourceConnectionGraph");
  });
});

describe("the compact form (the previous panel)", () => {
  it("lists the notes with the one that is open marked", () => {
    const html = page(snapshot(), { mode: "compact", current: `memora://note/${noteIds[1]}` });
    expect(html).toContain("data-compact");
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain("data-strip");
    expect(html.match(/aria-current="true"/gu)?.length).toBe(1);
  });
});

describe("pt-BR", () => {
  const english = [
    "Generating",
    "Notes by section",
    "Read<",
    "In the tree",
    "so far",
    "Open in Map",
    "Overview",
    "Details",
    "Connections",
    "Summary",
    "Looking for",
    "just now",
    "peeks"
  ];

  it("has no English chrome and no missing key on the page in any strip form", () => {
    const failed = runningProgress(now);
    failed.run = {
      ...(failed.run as NonNullable<typeof failed.run>),
      status: "failed",
      failedStage: "embedding"
    };
    const forms = [
      runningProgress(now),
      doneProgress(now),
      failed,
      { ...runningProgress(now), needsYou: "no_model.no_route" },
      { ...runningProgress(now), paused: true }
    ];
    for (const progress of forms) {
      const html = page(snapshot(stripOf(progress)), { t: pt });
      expect(html).not.toContain("[[missing");
      for (const word of english) expect(html, word).not.toContain(word);
    }
    const running = page(snapshot(), { t: pt });
    expect(running).toContain("Gerando conhecimento desta fonte");
    expect(running).toContain("Procurando lugar na árvore…");
    expect(running).toContain("agora mesmo");
    expect(running).toContain("Abrir no Mapa");
    expect(running).toContain("modelo local, sem custo");
    expect(running).toMatch(/faltam cerca de 8\u00a0min/u);
    expect(running).toContain("7 de ~18");
    expect(running).toContain("Visão geral");
  });

  it("keeps every tab in the one row in pt-BR: the labels are whole words", () => {
    const html = page(snapshot(), { t: pt });
    for (const label of ["Visão geral", "Notas", "Conexões", "Conteúdo", "Detalhes"])
      expect(html).toContain(label);
  });
});
