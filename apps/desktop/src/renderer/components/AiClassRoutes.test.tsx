import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes, type MessageKey } from "@app/i18n";

import type { AiClassRoutes, AiProfile } from "../../shared/ipc";
import {
  AiClassRoutesView,
  ClassRoutesEmpty,
  ClassRoutesError,
  ClassRoutesLoading,
  profileOffered,
  testErrorText,
  type AiClassRoutesViewProps
} from "./AiClassRoutes";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noTest = { state: "untested", model: null, ms: null, at: null, error: null } as const;
const visible = (html: string) => html.replaceAll("<!-- -->", "");

const routes = (overrides: Partial<AiClassRoutes> = {}): AiClassRoutes => ({
  preset: "hybrid",
  presets: [
    { id: "local", available: true, reason: null },
    { id: "hybrid", available: true, reason: null },
    { id: "cloud", available: true, reason: null }
  ],
  classes: [
    {
      id: "embed",
      profileId: id(1),
      profileName: "Embedder",
      modelId: "Qwen3-Embedding-0.6B",
      runtime: "gguf",
      remote: false,
      test: { state: "passed", model: "Qwen3-Embedding-0.6B", ms: 412, at: "now", error: null }
    },
    {
      id: "decide",
      profileId: null,
      profileName: null,
      modelId: null,
      runtime: null,
      remote: false,
      test: { state: "none", model: null, ms: null, at: null, error: null }
    },
    {
      id: "write-fast",
      profileId: id(2),
      profileName: "Writer",
      modelId: "gpt-writer",
      runtime: "remote",
      remote: true,
      test: {
        state: "failed",
        model: "gpt-writer",
        ms: 90,
        at: "now",
        error: "settings.ai.classes.errors.invalidOutput"
      }
    },
    {
      id: "write-quality",
      profileId: id(2),
      profileName: "Writer",
      modelId: "gpt-writer",
      runtime: "remote",
      remote: true,
      test: noTest
    },
    {
      id: "answer",
      profileId: id(2),
      profileName: "Writer",
      modelId: "gpt-writer",
      runtime: "remote",
      remote: true,
      test: noTest
    }
  ],
  judge: {
    profileId: id(2),
    profileName: "Writer",
    modelId: "gpt-writer",
    runtime: "remote",
    remote: true,
    providerName: "Example Cloud",
    routed: true,
    deciderMode: "ranker",
    test: noTest
  },
  ...overrides
});

const profiles = [
  {
    id: id(1),
    name: "Embedder",
    modelId: "embed",
    status: "active",
    providerConfigId: null,
    localModelId: id(11),
    capabilities: ["embedding"]
  },
  {
    id: id(2),
    name: "Writer",
    modelId: "gpt-writer",
    status: "active",
    providerConfigId: id(12),
    localModelId: null,
    capabilities: ["text-generation", "structured-output", "summarization"]
  },
  {
    id: id(3),
    name: "Ranker",
    modelId: "reranker",
    status: "active",
    providerConfigId: null,
    localModelId: id(13),
    capabilities: ["reranking", "offline"]
  },
  {
    id: id(4),
    name: "Local writer",
    modelId: "local-writer",
    status: "active",
    providerConfigId: null,
    localModelId: id(14),
    capabilities: ["text-generation", "structured-output"]
  }
] as unknown as AiProfile[];

function view(
  locale: string,
  overrides: Partial<AiClassRoutesViewProps> = {},
  data: AiClassRoutes = routes()
) {
  const t = createTranslator(locale);
  return renderToString(
    <AiClassRoutesView
      t={t}
      routes={data}
      profiles={profiles}
      busy={null}
      pendingSetup={null}
      pendingJudge={null}
      blocked={[]}
      blockedSetup={null}
      status=""
      onSelectSetup={() => {}}
      onConfirmSetup={() => {}}
      onCancelSetup={() => {}}
      onTest={() => {}}
      onChooseProfile={() => {}}
      onConfirmJudge={() => {}}
      onCancelJudge={() => {}}
      onChooseDecider={() => {}}
      {...overrides}
    />
  );
}

describe("Settings > AI workload classes", () => {
  it("lists the five classes and the generative judge with their models and tests", () => {
    const html = visible(view("en"));
    for (const name of ["Embeddings", "Ranking", "Quick writing", "Careful writing", "Answers"])
      expect(html).toContain(name);
    expect(html).toContain("Generative judge");
    expect(html).toContain("Qwen3-Embedding-0.6B");
    expect(html).toContain("Test passed in 412 ms");
    expect(html).toContain(
      "Test failed: The model answered, but not in the form the test expects."
    );
    expect(html).toContain("Not tested");
    // The ranker is the one class that can intentionally have no model.
    expect(html).toContain("No ranker installed");
    expect(html).toContain("No ranker");
  });

  it("offers the modes, disables an unavailable one and names the chosen setup", () => {
    const html = visible(
      view(
        "en",
        {},
        routes({
          presets: [
            { id: "local", available: false, reason: "local_requires_apple_silicon" },
            { id: "hybrid", available: true, reason: null },
            { id: "cloud", available: true, reason: null }
          ]
        })
      )
    );
    for (const mode of ["Local", "Hybrid", "Cloud", "Custom"]) expect(html).toContain(mode);
    expect(html).toMatch(/<option value="local" disabled="">Local<\/option>/);
    expect(html).toContain("Embeddings and ranking run on this Mac");
    const unset = visible(view("en", {}, routes({ preset: null })));
    expect(unset).toContain("Not chosen yet");
  });

  it("shows the profile selects only in Custom mode", () => {
    const section = (html: string, name: string) =>
      html.slice(html.indexOf(`<section aria-label="${name}"`)).split("</section>")[0]!;
    const hybrid = view("en", {}, routes({ preset: "hybrid" }));
    expect(section(hybrid, "Embeddings")).not.toContain("<select");
    const custom = view("en", {}, routes({ preset: "custom" }));
    expect(section(custom, "Embeddings")).toMatch(/<option [^>]*>Embedder<\/option>/);
    // Only profiles that can serve the class are offered: a writer is no embedder.
    expect(section(custom, "Embeddings")).not.toContain("Local writer");
    expect(section(custom, "Quick writing")).toMatch(/<option [^>]*>Local writer<\/option>/);
    expect(section(custom, "Quick writing")).not.toContain("Embedder");
    // The judge row always offers its model.
    expect(section(hybrid, "Generative judge")).toContain("<select");
  });

  it("asks for the confirmation of a setup before it applies", () => {
    const html = visible(view("en", { pendingSetup: "cloud" }));
    expect(html).toContain("Apply the Cloud setup?");
    expect(html).toContain("replaces the models of all five workloads");
    expect(html).toContain("Apply and test");
    expect(html).toContain("Cancel");
  });

  it("explains a setup that could not be applied and names the missing model", () => {
    const html = visible(
      view("en", {
        blockedSetup: "local",
        blocked: [
          {
            route: "write-fast",
            reason: "model_missing",
            catalogId: "mlx-qwen3.5-9b-4bit",
            modelName: "Qwen 3.5 9B 4-bit"
          },
          { route: "judge", reason: "no_remote_profile", catalogId: null, modelName: null }
        ]
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The Local setup could not be applied.");
    expect(html).toContain("Quick writing needs Qwen 3.5 9B 4-bit, which is not installed.");
    expect(html).toContain("Generative judge needs a remote model.");
  });

  it("shows the decider modes with a line for each and the remote disclosure of the judge", () => {
    const html = visible(view("en"));
    for (const line of [
      "Automatic: follows your models",
      "Ranker only: only a validated ranker decides",
      "Ranker, else judge: the ranker decides",
      "Judge only: the judge decides every relation"
    ])
      expect(html).toContain(line);
    expect(html).toContain("Example Cloud receives your text");
    expect(html).toContain("sent to Example Cloud");
    expect(html).toContain('role="note"');
    // A local judge discloses nothing.
    const local = routes({
      judge: { ...routes().judge, remote: false, providerName: null, runtime: "mlx" }
    });
    expect(visible(view("en", {}, local))).not.toContain("receives your text");
  });

  it("keeps the decider mode inside an Advanced disclosure (F4 D33: not counted among the visible automation)", () => {
    const html = visible(view("en"));
    const advanced = html.indexOf("<details");
    expect(advanced).toBeGreaterThan(-1);
    const mode = html.indexOf("Who decides note relations");
    expect(mode).toBeGreaterThan(advanced);
    expect(html.indexOf("</details>")).toBeGreaterThan(mode);
    // The routes themselves stay in view, ahead of it.
    expect(html.indexOf("Generative judge")).toBeLessThan(advanced);
  });

  it("discloses a remote judge before the choice applies", () => {
    const html = visible(
      view(
        "en",
        { pendingJudge: id(2) },
        routes({ judge: { ...routes().judge, remote: false, providerName: null } })
      )
    );
    expect(html).toContain("Writer receives your text");
    expect(html).toContain("Use this model");
  });

  it("marks a running test and a running setup", () => {
    const html = visible(view("en", { busy: "write-fast", status: "Testing Quick writing…" }));
    expect(html).toContain("Testing…");
    expect(html).toContain('role="status"');
    expect(html).toContain("Testing Quick writing…");
  });

  it("covers the loading, error and empty states", () => {
    const t = createTranslator("en");
    expect(renderToString(<ClassRoutesLoading t={t} />)).toContain("Loading models…");
    const error = renderToString(<ClassRoutesError t={t} onRetry={() => {}} />);
    expect(error).toContain('role="alert"');
    expect(error).toContain("The models could not be loaded.");
    expect(error).toContain("Retry");
    expect(renderToString(<ClassRoutesEmpty t={t} />)).toContain("No profiles yet.");
  });

  it("renders every state without a missing message in all five locales", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      const html = [
        view(locale, { pendingSetup: "hybrid" }),
        view(locale, { pendingJudge: id(2) }),
        view(
          locale,
          {
            blockedSetup: "local",
            blocked: [
              { route: "embed", reason: "model_missing", catalogId: "x", modelName: "Model" },
              { route: "judge", reason: "no_remote_profile", catalogId: null, modelName: null },
              {
                route: null,
                reason: "local_requires_apple_silicon",
                catalogId: null,
                modelName: null
              }
            ]
          },
          routes({ preset: "custom" })
        ),
        view(locale, {}, routes({ preset: null })),
        renderToString(<ClassRoutesLoading t={t} />),
        renderToString(<ClassRoutesError t={t} onRetry={() => {}} />),
        renderToString(<ClassRoutesEmpty t={t} />)
      ].join("");
      expect(html, locale).not.toContain("[[missing:");
      expect(html, locale).not.toMatch(/\{(setup|name|model|provider|ms|reason)\}/);
    }
  });

  it("translates a stored test error and keeps unknown reasons as they are", () => {
    const t = createTranslator("pt-BR");
    expect(testErrorText(t, "settings.ai.classes.errors.invalidOutput")).toBe(
      "O modelo respondeu, mas não no formato que o teste espera."
    );
    expect(testErrorText(t, "errors.nothing.here" as MessageKey)).toBe("errors.nothing.here");
    expect(testErrorText(t, "connect ECONNREFUSED 127.0.0.1")).toBe(
      "connect ECONNREFUSED 127.0.0.1"
    );
  });
});

describe("the profiles a route offers", () => {
  const by = (route: Parameters<typeof profileOffered>[1]) =>
    profiles.filter((profile) => profileOffered(profile, route)).map((profile) => profile.name);

  it("keeps rankers on class:decide, writers on the write classes and embedders on embed", () => {
    expect(by("embed")).toEqual(["Embedder"]);
    expect(by("decide")).toEqual(["Ranker"]);
    expect(by("write-fast")).toEqual(["Writer", "Local writer"]);
    expect(by("answer")).toEqual(["Writer", "Local writer"]);
  });

  it("offers only generative models as the judge, never a ranker", () => {
    expect(by("judge")).toEqual(["Writer", "Local writer"]);
    const decider = [
      ...profiles,
      { ...profiles[1]!, id: id(5), name: "Decision-only remote", capabilities: ["reranking"] }
    ] as AiProfile[];
    expect(
      decider.filter((profile) => profileOffered(profile, "judge")).map((profile) => profile.name)
    ).toEqual(["Writer", "Local writer", "Decision-only remote"]);
    // The validated local ranker is never the judge's.
    expect(by("judge")).not.toContain("Ranker");
  });
});
