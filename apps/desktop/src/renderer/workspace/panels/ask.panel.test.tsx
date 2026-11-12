import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import type { PanelProps } from "../PanelStack";
import { AskLauncherView, launcherState } from "./ask/AskLauncherView";
import { askFixture, recentQuestions } from "./ask/ask-fixtures";
import type { LauncherSnapshot } from "./ask/ask-launcher";
import { scopeOfView } from "./ask/ask-scope";

// Server rendering does not run effects: the effects that report the panel's state and place run as
// the panel renders, and the bus hooks are not under test here.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => unknown) => {
    effect();
  }
}));
vi.mock("../../lib/app-events", () => ({ useAppEvent: () => undefined }));
vi.mock("../../lib/object-events", () => ({
  useObjectChanged: () => undefined,
  useObjectKindChanged: () => undefined
}));

const ask = await import("./ask.panel");
const question = await import("./question.panel");

const props = (address: string, onPlace = vi.fn(), onState = vi.fn()) =>
  ({
    t: createTranslator("pt-BR"),
    address,
    mode: "full",
    active: true,
    onState,
    onPlace,
    onOpen: vi.fn()
  }) as unknown as PanelProps;

describe("the Ask and Question panels register by file", () => {
  it("takes an ask view for the Ask panel and a question address for the Question panel", () => {
    expect(ask.kind).toBe("ask");
    expect(ask.match("memora://ask")).toBe(true);
    expect(ask.match("memora://ask?q=Why%3F")).toBe(true);
    expect(ask.match(askFixture.questionAddress)).toBe(false);
    expect(ask.match("memora://search?q=a")).toBe(false);
    expect(question.kind).toBe("question");
    expect(question.match(askFixture.questionAddress)).toBe(true);
    expect(question.match(askFixture.noteAddress)).toBe(false);
    expect(question.match("memora://ask")).toBe(false);
  });

  it("names the Ask panel by its kind word, and the Question by its words", () => {
    expect(ask.title(null, createTranslator("pt-BR"))).toBe("Perguntar");
    expect(question.title({ title: "Why?" } as never)).toBe("Why?");
    expect(question.title(null)).toBe("");
  });

  it("tells the frame a Question being read has no place yet, and reads nothing for a bad address", () => {
    const onPlace = vi.fn();
    const onState = vi.fn();
    renderToString(<question.Component {...props(askFixture.questionAddress, onPlace, onState)} />);
    expect(onPlace).toHaveBeenCalledWith({ place: "placed" });
    expect(onState).toHaveBeenCalledWith("loading");
  });

  it("asks at once for words in the address, and only fills the field for a draft (an entity's name)", () => {
    const askSpy = vi.fn(() => new Promise(() => undefined));
    vi.stubGlobal("window", {
      app: { questions: { ask: askSpy, list: () => new Promise(() => undefined) } }
    });
    try {
      const draft = renderToString(
        <ask.Component {...props("memora://ask?draft=Lactobacillus")} />
      );
      expect(askSpy).not.toHaveBeenCalled();
      expect(draft).toContain("Lactobacillus</textarea>");
      renderToString(<ask.Component {...props("memora://ask?q=Lactobacillus")} />);
      expect(askSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("starts the Ask panel in the state its recent list is in", () => {
    const onState = vi.fn();
    renderToString(<ask.Component {...props("memora://ask", vi.fn(), onState)} />);
    expect(onState).toHaveBeenCalledWith("loading");
  });
});

describe("the Ask panel's four states", () => {
  const library = scopeOfView(undefined);
  const snapshot = (
    send: LauncherSnapshot["send"]["status"],
    items: typeof recentQuestions | null
  ): LauncherSnapshot => ({
    send: { status: send },
    recents: items === null ? { status: "loading" } : { status: "ready", items }
  });
  const draw = (
    value: LauncherSnapshot,
    scope = library,
    locale = "en",
    mode: "full" | "compact" = "full"
  ) =>
    renderToString(
      <AskLauncherView
        t={createTranslator(locale)}
        mode={mode}
        snapshot={value}
        scope={scope}
        value="Why do fermented foods keep?"
        onChange={() => undefined}
        onSend={() => undefined}
        onOpen={() => undefined}
      />
    ).replaceAll("<!-- -->", "");

  it("reports loading, empty, error and success from what it holds", () => {
    expect(launcherState(snapshot("idle", null), library)).toBe("loading");
    expect(launcherState(snapshot("asking", recentQuestions), library)).toBe("loading");
    expect(launcherState(snapshot("idle", []), library)).toBe("empty");
    expect(launcherState(snapshot("idle", recentQuestions), library)).toBe("success");
    expect(launcherState(snapshot("error", recentQuestions), library)).toBe("error");
    expect(launcherState(snapshot("idle", recentQuestions), { status: "unsupported" })).toBe(
      "error"
    );
  });

  it("says what this is and what to do next when nothing was asked yet", () => {
    const html = draw(snapshot("idle", []));
    expect(html).toContain("Nothing asked yet.");
    expect(html).toContain("Library › Questions");
  });

  it("keeps the words and says one failure, with no teaching state beside it", () => {
    const html = draw(snapshot("error", []));
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain("The question could not be sent.");
    expect(html).toContain("Your words are still in the field.");
    expect(html).toContain("Why do fermented foods keep?");
    expect(html).not.toContain("Nothing asked yet.");
  });

  it("refuses a scope that is not the library, a topic or a source, before anything is sent", () => {
    const note = scopeOfView({ kind: "note", id: askFixture.questionId });
    const html = draw(snapshot("idle", []), note);
    expect(html).toContain("Only the whole library, a topic or a source can be asked about.");
    expect(html).not.toContain("<textarea");
  });

  it("lists the recent questions, each one to open", () => {
    const html = draw(snapshot("idle", recentQuestions));
    for (const item of recentQuestions) expect(html).toContain(item.text);
    expect(html).toContain("Scope");
    expect(html).toContain("whole library");
  });

  it("speaks every language with no missing message and no raw key", () => {
    for (const locale of supportedLanguageCodes)
      for (const value of [
        snapshot("idle", null),
        snapshot("asking", recentQuestions),
        snapshot("idle", []),
        snapshot("error", []),
        snapshot("idle", recentQuestions)
      ])
        for (const mode of ["full", "compact"] as const) {
          const html = draw(value, library, locale, mode);
          expect(html, locale).not.toContain("[[missing:");
          expect(html, locale).not.toContain("askPanel.");
        }
  });
});
