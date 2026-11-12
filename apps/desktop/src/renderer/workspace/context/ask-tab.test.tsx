// The DOM globals must exist before Radix loads: keep this import first.
import { createTestDom, type TestDom } from "../test-dom";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import type { AskScope, ObjectKind } from "@app/domain";

import type { QuestionListItemView } from "../../../shared/ipc-questions";
import { AskTab, AskView, type AskViewProps } from "./ask-tab";
import type { AskTarget } from "./ask-tab-model";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const en = createTranslator("en");
const pt = createTranslator("pt-BR");
/** Server rendering separates adjacent text nodes with comments; the person sees none. */
const plain = (html: string) => html.replaceAll("<!-- -->", "");

const target = (variant: AskTarget["variant"], scope: AskScope, topicTitle = ""): AskTarget => ({
  variant,
  scope,
  topicTitle: topicTitle === "" ? null : topicTitle
});
const sourceTarget = target("source", { kind: "sources", sourceIds: [uuid(5)] });

const question = (n: number, scope: AskScope): QuestionListItemView => ({
  id: uuid(100 + n),
  text: `What does the passage ${n} say?`,
  language: "en",
  scope,
  status: "complete",
  createdAt: "2026-11-10T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
  answerCount: 1
});

const view = (t: typeof en, props: Partial<AskViewProps> = {}) =>
  plain(
    renderToString(
      <AskView
        t={t}
        kind="source"
        scope={{ status: "ready", target: sourceTarget }}
        value=""
        onChange={() => undefined}
        onSend={() => undefined}
        sending={false}
        sendFailed={false}
        indexed={null}
        now={Date.parse("2026-11-11T12:00:00.000Z")}
        earlier={{ status: "ready", value: [] }}
        onOpen={() => undefined}
        onRetryScope={() => undefined}
        onRetryEarlier={() => undefined}
        {...props}
      />
    )
  );

describe("the Ask tab's four states", () => {
  it("loading while the scope is read keeps the layout and writes no scope it does not know", () => {
    const html = view(pt, { kind: "note", scope: { status: "loading" } });
    expect(html).toContain('data-surface="context-ask"');
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<textarea");
  });

  it("loading the earlier questions keeps the field in reach", () => {
    const html = view(pt, { earlier: { status: "loading" } });
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("<textarea");
    expect(html).toContain("Perguntar a esta fonte");
  });

  it("loading a source's progress keeps the place of its line", () => {
    const html = view(pt, { indexedLoading: true });
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Já dá para perguntar");
  });

  it("empty teaches what is kept and where", () => {
    const html = view(pt);
    expect(html).toContain('data-state="empty"');
    expect(html).not.toContain("sobre isto");
    expect(html).toContain("Nenhuma pergunta sobre esta fonte ainda.");
    expect(html).toContain("Escreva acima; cada pergunta fica em Biblioteca › Perguntas");
    // Each scope names what it asks: a topic (a note asks the one it is in) and the library.
    const topic = view(pt, {
      kind: "topic",
      scope: { status: "ready", target: target("topic", { kind: "topic", topicId: uuid(4) }) }
    });
    expect(topic).toContain("Nenhuma pergunta sobre este tópico ainda.");
    const library = view(pt, {
      kind: "entity",
      scope: { status: "ready", target: target("entity", { kind: "library" }) }
    });
    expect(library).toContain("Nenhuma pergunta sobre a biblioteca ainda.");
  });

  it("success lists the earlier questions, dated, each opening its page", () => {
    const html = view(pt, {
      earlier: {
        status: "ready",
        value: [question(1, sourceTarget.scope), question(2, sourceTarget.scope)]
      }
    });
    expect(html).toContain('data-state="success"');
    expect(html).toContain("Perguntas anteriores");
    expect(html).toContain("What does the passage 1 say?");
    expect(html).toContain(`data-object="memora://question/${uuid(101)}"`);
  });

  it("a failed scope is one sentence in place, what stays open and one retry, and no field", () => {
    const html = view(pt, { kind: "note", scope: { status: "error" } });
    expect(html).toContain('data-state="error"');
    expect(html).toContain("Não foi possível ver onde esta nota está");
    expect(html).toContain("A nota continua aberta.");
    expect(html.match(/Tentar de novo/g)).toHaveLength(1);
    expect(html).not.toContain("<textarea");
  });

  it("a failed send keeps the words and offers one retry; the earlier list says nothing more", () => {
    const html = view(pt, {
      value: "Quanto sal vai no chucrute?",
      sendFailed: true,
      earlier: { status: "error" }
    });
    expect(html).toContain('data-state="error"');
    expect(html).toContain("Não foi possível enviar a pergunta.");
    expect(html).toContain("Quanto sal vai no chucrute?");
    expect(html.match(/Tentar de novo/g)).toHaveLength(1);
    expect(html).not.toContain("Não foi possível carregar as perguntas anteriores.");
  });

  it("a failed earlier list is one quiet sentence, and the field still works", () => {
    const html = view(pt, { earlier: { status: "error" } });
    expect(html).toContain('data-state="error"');
    expect(html).toContain("Não foi possível carregar as perguntas anteriores.");
    expect(html).toContain("Você ainda pode perguntar.");
    expect(html).toContain("<textarea");
  });
});

describe("what the heading says of the scope (always written)", () => {
  const cases: Array<[AskTarget, string, string]> = [
    [
      sourceTarget,
      "Perguntar a esta fonte",
      "A resposta usa só os trechos desta fonte e cita cada um."
    ],
    [
      target("topic", { kind: "topic", topicId: uuid(4) }),
      "Perguntar a este tópico",
      "A resposta usa só o que há neste tópico e cita cada trecho."
    ],
    [
      target("note", { kind: "topic", topicId: uuid(3) }, "Fermentação lática"),
      "Perguntar sobre Fermentação lática",
      "É o tópico em que esta nota está."
    ],
    [
      target("noteUnplaced", { kind: "library" }),
      "Perguntar à biblioteca",
      "Esta nota ainda não está num tópico, então a pergunta vale para a biblioteca toda."
    ],
    [
      target("entity", { kind: "library" }),
      "Perguntar sobre esta entidade",
      "O nome já está no campo."
    ],
    [
      target("library", { kind: "library" }),
      "Perguntar à biblioteca",
      "A resposta usa a biblioteca toda e cita cada trecho."
    ]
  ];
  for (const [aim, title, description] of cases)
    it(`${aim.variant}: ${title}`, () => {
      const html = view(pt, { scope: { status: "ready", target: aim } });
      expect(html).toContain(title);
      expect(html).toContain(description);
    });

  it("names an untitled topic in the placeholder's words, never an empty heading", () => {
    const html = view(pt, {
      scope: {
        status: "ready",
        target: { ...target("note", { kind: "topic", topicId: uuid(3) }), topicTitle: "" }
      }
    });
    expect(html).toContain("Perguntar sobre ");
    expect(html).not.toContain("Perguntar sobre </h2>");
  });

  it("says a source's passages are indexed and its notes still arriving", () => {
    const html = view(pt, { indexed: { kind: "indexed", count: 142, arriving: true } });
    expect(html).toContain("Já dá para perguntar: os 142 trechos estão indexados.");
    expect(html).toContain("As notas ainda estão chegando.");
    expect(view(pt, { indexed: { kind: "indexing" } })).toContain(
      "Os trechos ainda estão sendo indexados."
    );
  });

  it("reads in every locale without a missing key", () => {
    for (const code of supportedLanguageCodes)
      for (const [aim] of cases) {
        const html = view(createTranslator(code), {
          scope: { status: "ready", target: aim },
          indexed: { kind: "indexed", count: 3, arriving: true }
        });
        expect(html).not.toMatch(/contextPanel\.|askPanel\./);
      }
  });
});

// ---------------------------------------------------------------------------
// The tab with its reads and its Ask

let dom: TestDom;
let app: Record<string, unknown> & {
  questions: { ask: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> };
  objects: { locate: ReturnType<typeof vi.fn>; resolveMany: ReturnType<typeof vi.fn> };
  library: { sourceProgress: ReturnType<typeof vi.fn> };
};

const located = (path: Array<[number, string]>) => ({
  object: { kind: "note", id: uuid(22), title: "A note" },
  primaryPath: [
    ...path.map(([n, title]) => ({ kind: "topic", id: uuid(n), title })),
    { kind: "note", id: uuid(22), title: "A note" }
  ],
  alsoIn: [],
  citedBy: [],
  counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
});

beforeEach(() => {
  dom = createTestDom();
  app = {
    questions: {
      ask: vi.fn(async () => ({ questionId: uuid(300), requestId: uuid(301) })),
      list: vi.fn(async () => ({ items: [] }))
    },
    objects: {
      locate: vi.fn(async () =>
        located([
          [1, ""],
          [2, "Science"],
          [3, "Biology"]
        ])
      ),
      resolveMany: vi.fn(async (input: { addresses: string[] }) => ({
        items: Object.fromEntries(
          input.addresses.map((address) => [
            address,
            {
              address,
              kind: "entity",
              title: "Lactobacillus",
              status: "current",
              preview: "",
              updatedAt: "2026-11-03T10:00:00.000Z",
              path: []
            }
          ])
        ),
        missing: []
      }))
    },
    library: { sourceProgress: vi.fn(async () => null) },
    onAppEvent: () => () => undefined
  };
  (dom.window as unknown as { app: unknown }).app = app;
});

afterEach(async () => {
  await dom.dispose();
});

const mount = (
  kind: ObjectKind,
  id: string,
  onOpen: (address: string) => void = () => undefined,
  active = true
) =>
  dom.render(
    <AskTab
      t={en}
      address={`memora://${kind}/${id}`}
      kind={kind}
      id={id}
      active={active}
      onOpen={onOpen}
    />
  );

const field = () => dom.host.querySelector<HTMLTextAreaElement>("textarea")!;
/** Presses Enter in the field through its own `onKeyDown` prop (see `type`). */
const enter = async () => {
  await dom.act(async () => {
    const box = field();
    const key = Object.keys(box).find((name) => name.startsWith("__reactProps"))!;
    (box as unknown as Record<string, { onKeyDown: (event: unknown) => void }>)[key]!.onKeyDown({
      key: "Enter",
      shiftKey: false,
      preventDefault: () => undefined,
      nativeEvent: { isComposing: false }
    });
  });
};

/**
 * Types into the field the way React hears it. The DOM here (`linkedom`) has no input events that
 * React's change plugin accepts, so the text goes through the field's own `onChange` prop.
 */
const type = async (text: string) => {
  await dom.act(async () => {
    const box = field();
    const key = Object.keys(box).find((name) => name.startsWith("__reactProps"))!;
    (box as unknown as Record<string, { onChange: (event: unknown) => void }>)[key]!.onChange({
      target: { value: text }
    });
  });
};

describe("the Ask tab asks the scope of the object in focus", () => {
  it("a topic asks that topic and opens the new Question beside the focused panel", async () => {
    const opened: string[] = [];
    await mount("topic", uuid(4), (address) => opened.push(address));
    expect(dom.host.textContent).toContain("Ask this topic");
    await type("What is in this topic?");
    await enter();
    expect(app.questions.ask).toHaveBeenCalledWith({
      text: "What is in this topic?",
      scope: { kind: "topic", topicId: uuid(4) }
    });
    expect(opened).toEqual([`memora://question/${uuid(300)}`]);
    // The field is free again, and the list is read again for the new Question.
    expect(field().value).toBe("");
    expect(app.questions.list).toHaveBeenCalledTimes(2);
  });

  it("a source asks that source, and reads its milestone while the page is open", async () => {
    await mount("source", uuid(5));
    expect(app.library.sourceProgress).toHaveBeenCalledWith({ sourceId: uuid(5) });
    await type("How much salt?");
    await enter();
    expect(app.questions.ask).toHaveBeenCalledWith({
      text: "How much salt?",
      scope: { kind: "sources", sourceIds: [uuid(5)] }
    });
  });

  it("a note asks the topic it is in, read through objects.locate, and says which", async () => {
    await mount("note", uuid(22));
    expect(app.objects.locate).toHaveBeenCalledWith({ address: `memora://note/${uuid(22)}` });
    expect(dom.host.textContent).toContain("Ask about Biology");
    await type("What links these ideas?");
    await enter();
    expect(app.questions.ask).toHaveBeenCalledWith({
      text: "What links these ideas?",
      scope: { kind: "topic", topicId: uuid(3) }
    });
  });

  it("a note with no place asks the library and says so, never silently", async () => {
    app.objects.locate.mockResolvedValue(located([[1, ""]]));
    await mount("note", uuid(22));
    expect(dom.host.textContent).toContain("Ask your library");
    expect(dom.host.textContent).toContain("not in a topic yet");
    await type("Anything about this?");
    await enter();
    expect(app.questions.ask).toHaveBeenCalledWith({
      text: "Anything about this?",
      scope: { kind: "library" }
    });
  });

  it("a note whose place cannot be read writes no scope and asks nothing", async () => {
    app.objects.locate.mockRejectedValue(new Error("boom"));
    await mount("note", uuid(22));
    expect(dom.host.textContent).toContain("Could not find where this note is");
    expect(dom.host.querySelector("textarea")).toBeNull();
    expect(app.questions.ask).not.toHaveBeenCalled();
  });

  it("an entity asks the library with its name already in the field", async () => {
    await mount("entity", uuid(7));
    expect(field().value).toBe("Lactobacillus");
    await enter();
    expect(app.questions.ask).toHaveBeenCalledWith({
      text: "Lactobacillus",
      scope: { kind: "library" }
    });
  });

  it("does not overwrite words the person already wrote with the entity's name", async () => {
    app.objects.resolveMany.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ items: {}, missing: [] }), 0))
    );
    await mount("entity", uuid(7));
    await type("Where does it grow?");
    expect(field().value).toBe("Where does it grow?");
  });

  it("a question asks the library", async () => {
    await mount("question", uuid(31));
    expect(dom.host.textContent).toContain("Ask your library");
    expect(app.objects.locate).not.toHaveBeenCalled();
    expect(app.library.sourceProgress).not.toHaveBeenCalled();
  });

  it("lists only the questions already asked of this scope", async () => {
    app.questions.list.mockResolvedValue({
      items: [
        question(1, { kind: "topic", topicId: uuid(4) }),
        question(2, { kind: "library" }),
        question(3, { kind: "topic", topicId: uuid(99) })
      ]
    });
    await mount("topic", uuid(4));
    expect(dom.host.textContent).toContain("What does the passage 1 say?");
    expect(dom.host.textContent).not.toContain("What does the passage 2 say?");
    expect(dom.host.textContent).not.toContain("What does the passage 3 say?");
  });

  it("finds the scope's questions further back than the library's first page", async () => {
    const page = (from: number) =>
      Array.from({ length: 50 }, (_, index) => question(from + index, { kind: "library" }));
    app.questions.list
      .mockResolvedValueOnce({ items: page(100), next: "c1" })
      .mockResolvedValueOnce({
        items: [...page(200).slice(0, 4), question(7, { kind: "topic", topicId: uuid(4) })],
        next: undefined
      });
    await mount("topic", uuid(4));
    expect(app.questions.list).toHaveBeenNthCalledWith(1, { limit: 50 });
    expect(app.questions.list).toHaveBeenNthCalledWith(2, { limit: 50, cursor: "c1" });
    expect(dom.host.textContent).toContain("What does the passage 7 say?");
    expect(dom.host.textContent).not.toContain("No question about this topic yet");
  });

  it("reads the list again when a Question is asked elsewhere", async () => {
    const handlers: Record<string, (event: unknown) => void> = {};
    app.onAppEvent = vi.fn((type: string, handler: (event: unknown) => void) => {
      handlers[type] = handler;
      return () => undefined;
    });
    await mount("topic", uuid(4));
    expect(app.questions.list).toHaveBeenCalledTimes(1);
    await dom.act(async () =>
      handlers["object.changed"]!({
        type: "object.changed",
        refs: [{ kind: "question", id: uuid(8), change: "created" }]
      })
    );
    expect(app.questions.list).toHaveBeenCalledTimes(2);
  });

  it("follows the jobs only while a run of the source is live", async () => {
    const types: string[] = [];
    app.onAppEvent = (type: string) => {
      types.push(type);
      return () => undefined;
    };
    const subscribed = () => types.filter((type) => type === "job.progress").length;
    const progress = (status: string | null) => ({
      sourceId: uuid(5),
      run: status ? { status } : null,
      needsYou: null,
      paused: false,
      steps: {
        read: { state: "done", pages: 3 },
        chunks: { state: "done", indexed: 10 },
        notes: { state: "done", soFar: 4, estimate: 4 },
        placed: { state: "done", count: 4 },
        summary: { state: "done" },
        relations: { state: "done", count: 0 }
      },
      sections: []
    });
    app.library.sourceProgress.mockResolvedValue(progress(null));
    await mount("source", uuid(5));
    expect(subscribed()).toBe(0);
    await dom.dispose();
    dom = createTestDom();
    (dom.window as unknown as { app: unknown }).app = app;
    app.library.sourceProgress.mockResolvedValue(progress("running"));
    await mount("source", uuid(5));
    expect(subscribed()).toBe(1);
  });

  it("keeps the words and says the send failed once, with a retry", async () => {
    app.questions.ask.mockRejectedValueOnce(new Error("boom"));
    await mount("topic", uuid(4));
    await type("What is in this topic?");
    await enter();
    expect(dom.host.textContent).toContain("The question could not be sent.");
    expect(field().value).toBe("What is in this topic?");
    const retry = [...dom.host.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Retry")
    )!;
    await dom.act(async () => retry.click());
    expect(app.questions.ask).toHaveBeenCalledTimes(2);
  });

  it("reads nothing while it is not on screen", async () => {
    await mount("note", uuid(22), undefined, false);
    expect(app.objects.locate).not.toHaveBeenCalled();
    expect(app.questions.list).not.toHaveBeenCalled();
  });
});
