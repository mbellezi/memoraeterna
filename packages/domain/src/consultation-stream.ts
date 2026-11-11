/**
 * The incremental reader of an Ask answer (F5 D14). A model writes the structured answer
 * (`ConsultationAnswerSchema`: `{ change?, paragraphs: [{ markdown, citations, contextIds }], gaps }`)
 * as JSON, piece by piece. The reader takes those pieces as they come, at any split, and reports
 * the paragraphs that are complete so far plus the one being written (its markdown only).
 *
 * A paragraph is complete when its object closes, so a half-written citation never shows: only the
 * citation handles of a finished paragraph are returned, and a string that has not closed yet is
 * not one. The reader is a preview: the stored answer is the one the full output parses to, and the
 * final delta is built from it. A provider retry starts a new answer, so the caller resets the
 * reader and marks its next delta `restart`.
 *
 * The reader is lenient on purpose: text before the first `{` (a code fence, a preface) and after
 * the closing brace is ignored, unknown members are skipped at any depth, and invalid JSON ends
 * the extraction without throwing. It holds no I/O and no clock.
 */

/** One paragraph as the model wrote it: trimmed Markdown and its citation handles (`e1`, `e2`...). */
export interface StreamedAnswerParagraph {
  markdown: string;
  /** Distinct handles, in the order written. */
  citations: string[];
}

export interface AnswerStreamState {
  /** The paragraphs whose object has closed; the same array until another one completes. */
  paragraphs: readonly StreamedAnswerParagraph[];
  /** The paragraph being written: its markdown so far, never its citations. Null between them. */
  partial: { markdown: string } | null;
  /** The answer's closing brace was read: nothing more is taken. */
  finished: boolean;
}

export interface AnswerStreamReader {
  /** Reads the next piece (any split of the text, even inside an escape) and returns the state. */
  push(chunk: string): AnswerStreamState;
  state(): AnswerStreamState;
  /** Forgets everything read: the provider started the answer again. */
  reset(): void;
}

/** The number an evidence handle carries (`e3` is 3): the ordinal of the citation in an answer. */
export function evidenceHandleOrdinal(handle: string): number | null {
  const match = /^e(\d{1,3})$/.exec(handle);
  const ordinal = match ? Number(match[1]) : 0;
  return ordinal > 0 ? ordinal : null;
}

type Container =
  | { kind: "array"; role: "paragraphs" | "citations" | "skip" }
  | {
      kind: "object";
      role: "root" | "paragraph" | "skip";
      /** The member name whose value is next or being read (root and paragraph objects only). */
      key: string | null;
      expectKey: boolean;
    };

type Text = { role: "key" | "markdown" | "citation" | "skip"; value: string } | null;

const simpleEscapes: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t"
};

/** Creates a reader with nothing read. */
export function createAnswerStreamReader(): AnswerStreamReader {
  let stack: Container[] = [];
  let text: Text = null;
  /** 0: no escape; 1: after a backslash; 2: collecting the hex digits of `\uXXXX`. */
  let escape: 0 | 1 | 2 = 0;
  let hex = "";
  let started = false;
  let finished = false;
  let paragraphs: StreamedAnswerParagraph[] = [];
  let draft: { markdown: string; citations: string[] } | null = null;

  const top = () => stack[stack.length - 1];

  function snapshot(): AnswerStreamState {
    return {
      paragraphs,
      partial: draft ? { markdown: draft.markdown } : null,
      finished
    };
  }

  /** What the value that starts here is, from the container it sits in. */
  function roleOfValue(
    parent: Container | undefined
  ): "paragraphs" | "paragraph" | "markdown" | "citations" | "citation" | "skip" {
    if (!parent) return "skip";
    if (parent.kind === "array") {
      if (parent.role === "paragraphs") return "paragraph";
      return parent.role === "citations" ? "citation" : "skip";
    }
    if (parent.role === "root") return parent.key === "paragraphs" ? "paragraphs" : "skip";
    if (parent.role === "paragraph") {
      if (parent.key === "markdown") return "markdown";
      return parent.key === "citations" ? "citations" : "skip";
    }
    return "skip";
  }

  function openObject() {
    if (!started) {
      started = true;
      stack.push({ kind: "object", role: "root", key: null, expectKey: true });
      return;
    }
    const role = roleOfValue(top());
    if (role === "paragraph") {
      draft = { markdown: "", citations: [] };
      stack.push({ kind: "object", role: "paragraph", key: null, expectKey: true });
    } else {
      stack.push({ kind: "object", role: "skip", key: null, expectKey: false });
    }
  }

  function openArray() {
    const role = roleOfValue(top());
    stack.push({
      kind: "array",
      role: role === "paragraphs" ? "paragraphs" : role === "citations" ? "citations" : "skip"
    });
  }

  function closeContainer() {
    const closed = stack.pop();
    if (!closed) return;
    if (closed.kind === "object" && closed.role === "paragraph" && draft) {
      const markdown = draft.markdown.trim();
      if (markdown.length > 0)
        paragraphs = [...paragraphs, { markdown, citations: draft.citations }];
      draft = null;
    }
    if (closed.kind === "object" && closed.role === "root") finished = true;
  }

  function openString() {
    const parent = top();
    if (parent?.kind === "object" && parent.expectKey && parent.role !== "skip") {
      text = { role: "key", value: "" };
      return;
    }
    const role = roleOfValue(parent);
    text = { role: role === "markdown" || role === "citation" ? role : "skip", value: "" };
  }

  function closeString() {
    const closed = text;
    text = null;
    const parent = top();
    if (!closed || !parent) return;
    if (closed.role === "key" && parent.kind === "object") {
      parent.key = closed.value;
      parent.expectKey = false;
    } else if (closed.role === "citation" && draft) {
      if (!draft.citations.includes(closed.value))
        draft.citations = [...draft.citations, closed.value];
    }
  }

  function append(value: string) {
    if (!text) return;
    if (text.role === "markdown" && draft) draft.markdown += value;
    else if (text.role === "key" || text.role === "citation") text.value += value;
  }

  function readTextCharacter(character: string) {
    if (escape === 1) {
      escape = 0;
      if (character === "u") {
        escape = 2;
        hex = "";
      } else {
        append(simpleEscapes[character] ?? character);
      }
      return;
    }
    if (escape === 2) {
      hex += character;
      if (hex.length === 4) {
        escape = 0;
        const code = Number.parseInt(hex, 16);
        append(Number.isNaN(code) ? "" : String.fromCharCode(code));
      }
      return;
    }
    if (character === "\\") {
      escape = 1;
      return;
    }
    if (character === '"') {
      closeString();
      return;
    }
    append(character);
  }

  function readStructuralCharacter(character: string) {
    const parent = top();
    switch (character) {
      case "{":
        openObject();
        return;
      case "[":
        if (started) openArray();
        return;
      case '"':
        if (started) openString();
        return;
      case "}":
      case "]":
        closeContainer();
        return;
      case ",":
        if (parent?.kind === "object" && parent.role !== "skip") {
          parent.key = null;
          parent.expectKey = true;
        }
        return;
      default:
        // Whitespace, `:` and the characters of numbers and literals carry nothing to keep.
        return;
    }
  }

  return {
    push(chunk) {
      for (const character of chunk) {
        if (finished) break;
        // Iterating a string yields code points; a lone surrogate half is one "character" too, so a
        // pair split between two pieces is joined again by the plain appends above.
        if (text) readTextCharacter(character);
        else readStructuralCharacter(character);
      }
      return snapshot();
    },
    state: snapshot,
    reset() {
      stack = [];
      text = null;
      escape = 0;
      hex = "";
      started = false;
      finished = false;
      paragraphs = [];
      draft = null;
    }
  };
}
