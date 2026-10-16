import { describe, expect, it } from "vitest";
import type { AiModelAdapter, AiTaskRequest } from "@app/ai";

import {
  namingGroups,
  syntheticArticle,
  syntheticDimensions,
  syntheticEmbedding,
  syntheticLanguage,
  syntheticNaming,
  syntheticProvider
} from "./synthetic.js";

const dot = (a: number[], b: number[]) =>
  a.reduce((total, value, index) => total + value * b[index]!, 0);

describe("the synthetic library", () => {
  it("is written in the content language, three themes of twelve notes under one source", () => {
    const pt = syntheticArticle("pt");
    const en = syntheticArticle("en");
    expect(pt.notes).toHaveLength(36);
    expect(pt.lang).toBe("pt");
    expect(pt.notes[0]!.text).toContain("O estudo mostra");
    expect(en.notes[0]!.text).toContain("The study shows");
    expect(new Set(pt.notes.map((note) => note.id)).size).toBe(36);
  });

  it("chooses Portuguese or English from a locale and refuses others", () => {
    expect(syntheticLanguage("pt-BR")).toBe("pt");
    expect(syntheticLanguage("en-US")).toBe("en");
    expect(() => syntheticLanguage("fr")).toThrow(/Portuguese or English/);
  });
});

describe("the synthetic embedding", () => {
  it("is a deterministic unit vector", () => {
    const a = syntheticEmbedding("Esquecimento e retenção do intervalo");
    expect(a).toHaveLength(syntheticDimensions);
    expect(syntheticEmbedding("Esquecimento e retenção do intervalo")).toEqual(a);
    expect(dot(a, a)).toBeCloseTo(1, 10);
  });

  it("puts the notes of one theme close and the notes of other themes far apart", () => {
    const notes = syntheticArticle("pt").notes.map((note) => syntheticEmbedding(note.text));
    const within = (theme: number) => {
      const members = notes.slice(theme * 12, theme * 12 + 12);
      let total = 0;
      let pairs = 0;
      for (let i = 0; i < members.length; i += 1)
        for (let j = i + 1; j < members.length; j += 1) {
          total += dot(members[i]!, members[j]!);
          pairs += 1;
        }
      return total / pairs;
    };
    const across =
      dot(notes[0]!, notes[12]!) + dot(notes[0]!, notes[24]!) + dot(notes[12]!, notes[24]!);
    for (const theme of [0, 1, 2]) expect(within(theme)).toBeGreaterThan(0.2);
    expect(across / 3).toBeLessThan(0.1);
  });
});

function namingPrompt(groups: unknown): string {
  return `Name the topics.\nReturn only JSON.\nTopics:\n${JSON.stringify(groups)}`;
}

describe("the synthetic naming model", () => {
  const groups = [
    {
      parent: null,
      topics: [
        {
          alias: "T1",
          notes: syntheticArticle("pt")
            .notes.slice(0, 4)
            .map((note) => ({ title: note.title, idea: note.idea }))
        },
        {
          alias: "T2",
          notes: syntheticArticle("pt")
            .notes.slice(12, 16)
            .map((note) => ({ title: note.title, idea: note.idea }))
        }
      ]
    }
  ];

  it("reads the groups of a naming prompt and ignores a repair block after them", () => {
    expect(namingGroups(namingPrompt(groups))).toHaveLength(1);
    expect(namingGroups(`${namingPrompt(groups)}\n\nValidation errors: x`)).toHaveLength(1);
    expect(namingGroups("no topics here")).toBeNull();
    expect(namingGroups("\nTopics:\nnot json")).toBeNull();
  });

  it("names every topic of the call from the words of its notes, in the content language", () => {
    const answer = JSON.parse(syntheticNaming(namingPrompt(groups), "pt", "pt-BR")!) as {
      topics: Array<{ alias: string; title: string; description: string; language: string }>;
    };
    expect(answer.topics.map((topic) => topic.alias)).toEqual(["T1", "T2"]);
    expect(new Set(answer.topics.map((topic) => topic.title)).size).toBe(2);
    expect(answer.topics.every((topic) => topic.language === "pt-BR")).toBe(true);
    expect(answer.topics[0]!.description).toMatch(/^Reúne as notas sobre /);
    expect(answer.topics[0]!.title).toMatch(/ e /);
  });

  it("keeps the names of siblings apart when their notes share words", () => {
    const same = [
      {
        parent: "Memória",
        topics: ["T1", "T2"].map((alias) => ({
          alias,
          notes: syntheticArticle("en")
            .notes.slice(0, 3)
            .map((note) => ({ title: note.title, idea: note.idea }))
        }))
      }
    ];
    const answer = JSON.parse(syntheticNaming(namingPrompt(same), "en", "en")!) as {
      topics: Array<{ title: string }>;
    };
    expect(new Set(answer.topics.map((topic) => topic.title.toLowerCase())).size).toBe(2);
  });

  it("returns null for a prompt that is not a naming prompt", () => {
    expect(syntheticNaming("Summarize this.", "pt", "pt-BR")).toBeNull();
  });
});

describe("the synthetic provider", () => {
  const adapter = {
    describe: () => ({ providerId: "openai-compatible", modelId: "m", runtime: "remote" }),
    canHandle: () => true,
    run: async () => {
      throw new Error("the real adapter must not be called");
    }
  } as unknown as AiModelAdapter;
  const provider = syntheticProvider(adapter, { language: "pt", contentLanguage: "pt-BR" });
  const request = (taskType: string, input: string) =>
    ({ taskType, input, modelId: "m" }) as unknown as AiTaskRequest;

  it("answers an embedding with a vector and a naming prompt with JSON, never calling the adapter", async () => {
    const embedding = await provider.run(request("embedding", "texto de teste"));
    expect(embedding).toMatchObject({
      taskType: "embedding",
      providerId: "openai-compatible",
      runtime: "remote"
    });
    expect(embedding.output).toHaveLength(syntheticDimensions);
    const naming = await provider.run(
      request(
        "structured-output",
        namingPrompt([
          { parent: null, topics: [{ alias: "T1", notes: [{ title: "Sono e hipocampo" }] }] }
        ])
      )
    );
    expect(JSON.parse(naming.output as string).topics[0].alias).toBe("T1");
    expect((await provider.run(request("summarization", "x"))).output).toBe("{}");
  });

  it("reports itself loaded and streams a single finished progress event", async () => {
    expect(provider.isLoaded?.()).toBe(true);
    const progress: number[] = [];
    await provider.runStreaming!(request("embedding", "x"), undefined, (event) =>
      progress.push(event.progress)
    );
    expect(progress).toEqual([1]);
  });
});
