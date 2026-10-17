import { describe, expect, it } from "vitest";

import { NodeLlamaCppAdapter, type AiTaskRequest } from "./index.js";

/**
 * F3 D37: a GGUF `embedMany` is the single calls of its texts on one embedding context, so it must
 * return the very vectors the single path returns, bit for bit; otherwise it is a new embedding
 * space and does not ship. This runs the real model, so it takes the local-model slot and only runs
 * when a model file is named:
 *
 *   MEMORA_TEST_GGUF_EMBEDDING=<Qwen3-Embedding-0.6B-Q8_0.gguf> npx vitest run \
 *     packages/ai/src/local-embedding-equality.test.ts
 */
const modelPath = process.env.MEMORA_TEST_GGUF_EMBEDDING?.trim();

const portuguese = [
  "A repetição espaçada distribui as revisões ao longo do tempo para reduzir o esquecimento.",
  "Recuperar uma informação da memória a fortalece mais do que relê-la.",
  "O sono consolida as memórias aprendidas durante o dia.",
  "Intercalar assuntos diferentes melhora a transferência do aprendizado.",
  "A curva do esquecimento de Ebbinghaus mostra que a retenção cai depressa sem revisão.",
  "Explicar o conteúdo com as próprias palavras revela o que ainda não foi compreendido.",
  "Os mapas conceituais organizam ideias e as relações entre elas.",
  "A atenção dividida prejudica a codificação de novas informações.",
  "Dificuldades desejáveis tornam o aprendizado mais lento e mais duradouro.",
  "O efeito de testagem não depende de feedback imediato para existir.",
  "Notas atômicas guardam uma única ideia, com a evidência que a sustenta.",
  "Um sistema de conhecimento pessoal cresce quando as notas se ligam entre si.",
  "A paráfrase obriga o leitor a reconstruir o argumento do autor.",
  "Ler em voz alta ajuda a perceber lacunas no raciocínio.",
  "O contexto de estudo influencia a lembrança, mas varia entre pessoas.",
  "Resumos escritos depois da leitura consolidam o essencial do texto.",
  "A motivação intrínseca sustenta hábitos de estudo por mais tempo.",
  "Perguntas feitas antes da leitura orientam a atenção para o que importa.",
  "Cartões de revisão funcionam melhor quando cada um testa um só fato.",
  "O planejamento reverso parte do objetivo e volta até a primeira tarefa.",
  "Pausas curtas restauram a atenção em sessões longas de estudo.",
  "Exemplos concretos tornam princípios abstratos mais fáceis de lembrar.",
  "A metacognição é o conhecimento que alguém tem do próprio aprendizado.",
  "Revisar o erro cometido ensina mais do que repetir o acerto.",
  "Textos curtos e densos pedem leitura lenta e releitura."
];
const english = [
  "Spaced repetition spreads reviews over time to slow forgetting.",
  "Retrieving a memory strengthens it more than rereading the same page.",
  "Sleep consolidates what was learned during the day.",
  "Interleaving different topics improves the transfer of learning.",
  "Ebbinghaus showed that retention falls quickly without review.",
  "Explaining a concept in your own words exposes what you have not understood.",
  "Concept maps organize ideas and the relations between them.",
  "Divided attention harms the encoding of new information.",
  "Desirable difficulties make learning slower and longer lasting.",
  "The testing effect does not need immediate feedback to appear.",
  "Atomic notes keep one idea together with the evidence behind it.",
  "A personal knowledge system grows when its notes link to each other.",
  "Paraphrasing forces the reader to rebuild the author's argument.",
  "Reading aloud helps to notice gaps in reasoning.",
  "Study context shapes recall, although it differs between people.",
  "Written summaries after reading consolidate the essentials of a text.",
  "Intrinsic motivation sustains study habits for longer.",
  "Questions asked before reading steer attention to what matters.",
  "Flashcards work best when each one tests a single fact.",
  "Backward planning starts from the goal and returns to the first task.",
  "Short breaks restore attention in long study sessions.",
  "Concrete examples make abstract principles easier to remember.",
  "Metacognition is what someone knows about their own learning.",
  "Reviewing a mistake teaches more than repeating a success.",
  "Short dense texts call for slow reading and rereading."
];

describe.skipIf(!modelPath)("GGUF embedMany on the real model (F3 D37)", () => {
  const texts = [...portuguese, ...english];
  const request = (text: string): AiTaskRequest => ({
    taskType: "embedding",
    input: text,
    modelId: "qwen3-embedding-0.6b",
    requiredCapabilities: [],
    parameters: { dimensions: 768 },
    metadata: {}
  });

  it("returns, for 50 Portuguese and English texts, the vectors of the single calls bit for bit", async () => {
    const adapter = new NodeLlamaCppAdapter({
      modelId: "qwen3-embedding-0.6b",
      modelPath: modelPath!,
      capabilities: ["embedding", "offline"]
    });
    try {
      const single: number[][] = [];
      for (const text of texts) single.push((await adapter.run(request(text))).output as number[]);
      const many = await adapter.embedMany(texts, {
        parameters: { dimensions: 768 },
        modelId: "qwen3-embedding-0.6b"
      });
      expect(many.embeddings).toHaveLength(50);
      expect(many.embeddings[0]).toHaveLength(768);
      let differing = 0;
      for (const [index, vector] of many.embeddings.entries()) {
        // `toEqual` on numbers is exact: one differing bit fails the test.
        if (!Object.is(vector.length, single[index]!.length)) differing += 1;
        else if (vector.some((value, position) => !Object.is(value, single[index]![position])))
          differing += 1;
      }
      expect(differing).toBe(0);
      expect(many.itemInputTokens).toHaveLength(50);
      // A second batch in a different order gives the same vectors: no state leaks between texts.
      const reversed = await adapter.embedMany([...texts].reverse(), {
        parameters: { dimensions: 768 },
        modelId: "qwen3-embedding-0.6b"
      });
      expect(reversed.embeddings.toReversed()).toEqual(many.embeddings);
    } finally {
      await adapter.dispose();
    }
  }, 300_000);
});
