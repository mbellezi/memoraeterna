// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../test-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import type { ChangeSetSummary } from "@app/domain";

import { HistoryTab, HistoryView } from "./history-tab";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noteId = uuid(22);
const address = `memora://note/${noteId}`;
const en = createTranslator("en");
const pt = createTranslator("pt-BR");
/** Server rendering separates adjacent text nodes with comments; the person sees none. */
const plain = (html: string) => html.replaceAll("<!-- -->", "");

const change = (n: number, fields: Partial<ChangeSetSummary> = {}): ChangeSetSummary => ({
  kind: "topic",
  id: uuid(n),
  titleKey: "topics.changeSets.place",
  titleParams: { items: 12 },
  risk: "low",
  status: "applied",
  origin: "place",
  subjectId: null,
  jobId: null,
  at: "2026-11-10T10:00:00.000Z",
  undoneAt: null,
  undo: "available",
  ...fields
});

const view = (
  t: typeof en,
  read: Parameters<typeof HistoryView>[0]["read"],
  kind: Parameters<typeof HistoryView>[0]["kind"] = "note",
  undo: Parameters<typeof HistoryView>[0]["undo"] = {}
) =>
  plain(
    renderToString(
      <HistoryView
        t={t}
        kind={kind}
        read={read}
        undo={undo}
        now={Date.parse("2026-11-11T12:00:00.000Z")}
        onUndo={() => undefined}
        onRetry={() => undefined}
      />
    )
  );

describe("the History tab's four states", () => {
  it("loading keeps the layout: the heading stays and a busy region says it is loading", () => {
    const html = view(pt, { status: "loading" });
    expect(html).toContain('data-surface="context-history"');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("Histórico");
    expect(html).toContain("Tudo o que mudou neste objeto, com Desfazer.");
    expect(html).toContain('role="status"');
  });

  it("empty says what this is and what to do next, per kind", () => {
    const empty = { status: "ready" as const, value: { items: [] } };
    expect(view(pt, empty)).toContain('data-state="empty"');
    expect(view(pt, empty, "note")).toContain("Nada mudou nesta nota ainda.");
    expect(view(pt, empty, "topic")).toContain("Nada mudou neste tópico ainda.");
    expect(view(pt, empty, "source")).toContain("Nada mudou por causa desta fonte ainda.");
    expect(view(pt, empty, "entity")).toContain("Uma entidade não tem histórico próprio.");
    expect(view(pt, empty, "question")).toContain("Uma pergunta não tem histórico próprio.");
  });

  it("error is one plain sentence in place, what is kept and one retry", () => {
    const html = view(pt, { status: "error" });
    expect(html).toContain('data-state="error"');
    expect(html).toContain("Não foi possível carregar o histórico.");
    expect(html).toContain("A nota continua aberta.");
    expect(html.match(/Tentar de novo/g)).toHaveLength(1);
  });

  it("success lists the rows as a thread: sentence, who and when, and Desfazer", () => {
    const html = view(pt, {
      status: "ready",
      value: {
        items: [
          change(1),
          change(2, { status: "pending_review", origin: "rebalance", undo: "unavailable" }),
          change(3, { origin: "human", undo: "blocked" }),
          change(4, { status: "undone", undo: "unavailable" })
        ]
      }
    });
    expect(html).toContain('data-state="success"');
    expect(html).toContain("4 mudanças.");
    expect(html).toContain("12 itens organizados em tópicos");
    expect(html).toContain("Jardineiro");
    expect(html).toContain("Você");
    expect(html).toContain("Espera sua decisão na Caixa de entrada");
    expect(html).toContain("Não dá para desfazer agora: uma mudança posterior depende dela.");
    expect(html).toContain("Desfeita");
    // Only the applied change the store can undo offers Desfazer.
    expect(html.match(/aria-label="Desfazer: /g)).toHaveLength(1);
  });

  it("says it lists the most recent when it is full, and a change once reads singular", () => {
    const twenty = Array.from({ length: 20 }, (_, n) => change(n + 1));
    expect(view(en, { status: "ready", value: { items: twenty } })).toContain(
      "The 20 most recent."
    );
    expect(view(en, { status: "ready", value: { items: [change(1)] } })).toContain("1 change.");
  });

  it("shows the refusal of a Desfazer in place, with Desfazer kept", () => {
    const html = view(pt, { status: "ready", value: { items: [change(1)] } }, "note", {
      [`topic:${uuid(1)}`]: { status: "blocked", messageKey: "changes.blockers.later_change" }
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Uma mudança posterior alterou os mesmos itens. Desfaça aquela primeiro."
    );
    expect(html).toContain('aria-label="Desfazer: ');
  });

  it("reads in every locale without a missing key", () => {
    for (const code of supportedLanguageCodes) {
      const html = view(createTranslator(code), {
        status: "ready",
        value: { items: [change(1), change(2, { status: "pending_review", undo: "unavailable" })] }
      });
      expect(html).not.toMatch(/contextPanel\.|activity\.done\./);
    }
  });
});

// ---------------------------------------------------------------------------
// The tab with its reads and its Desfazer

let dom: TestDom;
let app: {
  changes: { forObject: ReturnType<typeof vi.fn>; undo: ReturnType<typeof vi.fn> };
  onAppEvent: ReturnType<typeof vi.fn>;
};
let emit: Record<string, () => void>;

beforeEach(() => {
  dom = createTestDom();
  emit = {};
  app = {
    changes: {
      forObject: vi.fn(async () => ({ items: [change(1), change(2, { undo: "blocked" })] })),
      undo: vi.fn(async () => ({ status: "undone", kind: "topic", id: uuid(1) }))
    },
    onAppEvent: vi.fn((type: string, handler: () => void) => {
      emit[type] = handler;
      return () => undefined;
    })
  };
  (dom.window as unknown as { app: unknown }).app = app;
});

afterEach(async () => {
  await dom.dispose();
});

const mount = (active = true) =>
  dom.render(
    <HistoryTab
      t={en}
      address={address}
      kind="note"
      id={noteId}
      active={active}
      onOpen={() => undefined}
    />
  );

describe("the History tab's reads", () => {
  it("reads the object's change-sets once, only while it is on screen", async () => {
    await mount(false);
    expect(app.changes.forObject).not.toHaveBeenCalled();
    await mount(true);
    expect(app.changes.forObject).toHaveBeenCalledTimes(1);
    expect(app.changes.forObject).toHaveBeenCalledWith({ kind: "note", id: noteId });
    expect(dom.host.textContent).toContain("Placed 12 items in topics");
  });

  it("reads again when a change-set changed status, and never on a timer", async () => {
    await mount();
    expect(app.changes.forObject).toHaveBeenCalledTimes(1);
    await dom.act(async () => emit["changes.changed"]!());
    expect(app.changes.forObject).toHaveBeenCalledTimes(2);
  });

  it("undoes a change through changes.undo and reads again", async () => {
    await mount();
    const button = dom.host.querySelector<HTMLButtonElement>('button[aria-label^="Undo: "]')!;
    await dom.act(async () => button.click());
    expect(app.changes.undo).toHaveBeenCalledWith({ kind: "topic", id: uuid(1) });
    expect(app.changes.forObject).toHaveBeenCalledTimes(2);
  });

  it("names what stands in the way when the store refuses, and keeps the list", async () => {
    app.changes.undo.mockResolvedValue({
      status: "blocked",
      blockers: [{ code: "later_change", changeSet: null }],
      more: 0
    });
    await mount();
    const button = dom.host.querySelector<HTMLButtonElement>('button[aria-label^="Undo: "]')!;
    await dom.act(async () => button.click());
    expect(dom.host.textContent).toContain("A later change touched the same items.");
    expect(app.changes.forObject).toHaveBeenCalledTimes(1);
  });

  it("says a failed Desfazer failed, once, in place", async () => {
    app.changes.undo.mockRejectedValue(new Error("boom"));
    await mount();
    const button = dom.host.querySelector<HTMLButtonElement>('button[aria-label^="Undo: "]')!;
    await dom.act(async () => button.click());
    expect(dom.host.textContent).toContain("The change could not be undone. Try again.");
  });

  it("reports its count to the strip and its state to the panel", async () => {
    const onCount = vi.fn();
    const onState = vi.fn();
    await dom.render(
      <HistoryTab
        t={en}
        address={address}
        kind="note"
        id={noteId}
        active
        onOpen={() => undefined}
        onCount={onCount}
        onState={onState}
      />
    );
    expect(onCount).toHaveBeenLastCalledWith(2);
    expect(onState).toHaveBeenLastCalledWith("success");
  });

  it("fails in place, once, and can try again", async () => {
    app.changes.forObject.mockRejectedValueOnce(new Error("boom"));
    await mount();
    expect(dom.host.textContent).toContain("Could not load the history.");
    const retry = [...dom.host.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Retry")
    )!;
    await dom.act(async () => retry.click());
    expect(dom.host.textContent).toContain("Placed 12 items in topics");
  });
});
