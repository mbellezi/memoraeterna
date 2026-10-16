import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scoreRun, serveRun } from "./rating-commands.js";
import { parseRatingArgs, ratingUsage } from "./rating-args.js";
import { ratingProfiles } from "./rating-core.js";
import type { RatingParts } from "./rating-core.js";
import {
  RatingRunError,
  answerKeyOf,
  ratingAnswerPrefix,
  ratingFiles,
  ratingTemplatePath,
  readRun,
  readTokensCss,
  renderRatingPage,
  resolveRunDirectory,
  sha256,
  writeRun
} from "./rating-run.js";
import { buildRatingParts } from "./rating-fixture.js";

const seed = 20261016;
let workDir = "";
let parts: RatingParts;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "memora-rating-"));
  parts = buildRatingParts(seed);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
});

async function written(name = "run-a") {
  const directory = join(workDir, name);
  const manifest = await writeRun(directory, {
    run: name,
    seed,
    createdAt: "2026-10-16T12:00:00.000Z",
    parts
  });
  return { directory, manifest };
}

describe("the run directory", () => {
  it("records the seed and each profile's config_hash in a manifest, written last", async () => {
    const { directory, manifest } = await written();
    expect(manifest.seed).toBe(seed);
    expect(manifest.profiles.map((profile) => [profile.label, profile.configHash])).toEqual([
      ["ENV-C", "hash-of-env-c"],
      ["ENV-G", "hash-of-env-g"],
      ["ENV-F", "hash-of-env-f"]
    ]);
    const onDisk = JSON.parse(await readFile(join(directory, ratingFiles.manifest), "utf8"));
    expect(onDisk).toEqual(manifest);
    expect(manifest.files.sample.sha256).toBe(
      sha256(await readFile(join(directory, ratingFiles.sample), "utf8"))
    );
    expect(manifest.files.sealed.sha256).toBe(
      sha256(await readFile(join(directory, ratingFiles.sealed), "utf8"))
    );
  });

  it("is never sampled again once it has a manifest", async () => {
    const { directory } = await written();
    const before = await readFile(join(directory, ratingFiles.sample), "utf8");
    await expect(
      writeRun(directory, { run: "run-a", seed: 2, createdAt: "later", parts: buildRatingParts(2) })
    ).rejects.toThrow(/never redrawn/u);
    expect(await readFile(join(directory, ratingFiles.sample), "utf8")).toBe(before);
  });

  it("is not served when the sample changed after it was drawn", async () => {
    const { directory } = await written();
    const path = join(directory, ratingFiles.sample);
    await writeFile(path, (await readFile(path, "utf8")).replace("Topic", "Tópico"), "utf8");
    await expect(readRun(directory)).rejects.toThrow(/changed after it was sampled/u);
    await expect(serveRun(directory, 0)).rejects.toThrow(RatingRunError);
  });

  it("is not served without a manifest", async () => {
    await expect(readRun(join(workDir, "missing"))).rejects.toThrow(/manifest/u);
  });

  it("resolves a run name under the cache and a path as itself", () => {
    vi.stubEnv("MEMORA_TOPICS_CACHE", "/tmp/cache");
    expect(resolveRunDirectory("seed-20261016")).toBe("/tmp/cache/topics/rating/seed-20261016");
    expect(resolveRunDirectory("/elsewhere/run")).toBe("/elsewhere/run");
    expect(() => resolveRunDirectory("..")).toThrow(RatingRunError);
  });
});

describe("the page the owner sees", () => {
  const html = async (): Promise<{
    page: string;
    data: { topics: unknown[]; answerKey: string };
  }> => {
    const { directory } = await written();
    const loaded = await readRun(directory);
    const page = renderRatingPage({
      template: await readFile(ratingTemplatePath, "utf8"),
      tokensCss: await readTokensCss(),
      sample: loaded.sample,
      sampleSha256: loaded.sampleSha256
    });
    const match = /<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/u.exec(
      page
    );
    return { page, data: JSON.parse(match?.[1] ?? "{}") as never };
  };

  it("embeds the 30 topics and the answer key, and nothing from the sealed map", async () => {
    const { page, data } = await html();
    expect(data.topics).toHaveLength(30);
    expect(Object.keys(data).sort()).toEqual(["answerKey", "topics"]);
    expect(data.answerKey.startsWith(ratingAnswerPrefix)).toBe(true);
    for (const topic of data.topics as { key: string }[]) {
      expect(Object.keys(topic).sort()).toEqual([
        "aliases",
        "description",
        "key",
        "members",
        "name"
      ]);
    }
    expect(page).toContain("Coerente?");
    expect(page).toContain("Bem nomeado (inclui estar no idioma do conteúdo)?");
    expect(page).toContain('lang="pt-BR"');
  });

  it("shows no level, dataset, naming source, tree, hash or topic id", async () => {
    const { page } = await html();
    const text = page.toLowerCase();
    const sealedValues = parts.sealed.entries.flatMap((entry) => [
      entry.topicId,
      entry.treeId,
      entry.configHash,
      entry.stratum,
      entry.nameSource ?? ""
    ]);
    const forbidden = [
      ...ratingProfiles,
      ...ratingProfiles.map((profile) => profile.toUpperCase()),
      ...sealedValues,
      "dataset",
      "level",
      "nível",
      "nivel",
      "profile",
      "perfil",
      "tfidf",
      "provisional",
      "provisório",
      "config_hash",
      "sealed",
      "stratum"
    ].filter((value) => value.length > 0);
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const value of new Set(forbidden)) {
      const word = new RegExp(`(?<![\\w-])${escape(value.toLowerCase())}(?![\\w-])`, "u");
      expect(text, `the page mentions "${value}"`).not.toMatch(word);
    }
  });

  it("cannot be broken by markup in a note", () => {
    const hostile = {
      version: 1 as const,
      topics: [
        {
          key: "t01",
          name: "</script><script>alert(1)</script>",
          description: null,
          aliases: [],
          members: []
        }
      ]
    };
    const page = renderRatingPage({
      template: '<script id="page-data" type="application/json">__PAGE_DATA__</script>',
      tokensCss: "",
      sample: hostile,
      sampleSha256: "abc"
    });
    expect(page.match(/<\/script>/gu)).toHaveLength(1);
    expect(page).toContain("\\u003c/script>");
  });

  it("is written in Portuguese, follows the system colour scheme and uses the shared tokens", async () => {
    const { page } = await html();
    expect(page).toContain("--surface-canvas");
    expect(page).toContain("prefers-color-scheme: dark");
    // The page's own styles hold no colour literal: every colour is a token.
    expect(await readFile(ratingTemplatePath, "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
    expect(page).not.toContain("/*__TOKENS_CSS__*/");
    expect(page).not.toContain("__PAGE_DATA__");
  });
});

interface Reply {
  status: number;
  body: string;
}

function send(
  url: string,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: options.path ?? "/",
        method: options.method ?? "GET",
        headers: options.headers
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("the local server and the answers", () => {
  const json = { "content-type": "application/json" };

  async function serving() {
    const { directory } = await written();
    const served = await serveRun(directory, 0);
    const loaded = await readRun(directory);
    const key = answerKeyOf(loaded.sampleSha256);
    return { directory, served, key };
  }

  it("serves only the page and the answers, on 127.0.0.1", async () => {
    const { served } = await serving();
    try {
      expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
      const page = await send(served.url);
      expect(page.status).toBe(200);
      expect(page.body).toContain("Avaliação de tópicos");
      expect(page.body).toContain("evalserver-save");
      for (const path of [
        "/sealed.json",
        "/manifest.json",
        "/sample.json",
        "/answers.json",
        "/../sealed.json",
        "/%2e%2e/sealed.json"
      ]) {
        expect((await send(served.url, { path })).status, path).toBe(404);
      }
    } finally {
      await served.close();
    }
  });

  it("saves the answers as the owner goes and gives them back after a reload", async () => {
    const { directory, served, key } = await serving();
    try {
      expect(JSON.parse((await send(served.url, { path: "/answers" })).body)).toEqual({});
      const answers = {
        t01: { coerente: true, bemNomeado: false, notas: "nome em inglês" },
        t02: { coerente: true, bemNomeado: true, notas: "" }
      };
      const saved = await send(served.url, {
        method: "POST",
        path: "/answers",
        headers: json,
        body: JSON.stringify({ key, value: JSON.stringify(answers) })
      });
      expect(saved.status).toBe(204);
      const file = JSON.parse(await readFile(join(directory, ratingFiles.answers), "utf8"));
      expect(file.key).toBe(key);
      expect(file.answers).toEqual(answers);

      // A new server over the same run restores them (resume after the server restarts).
      await served.close();
      const again = await serveRun(directory, 0);
      try {
        const restored = JSON.parse((await send(again.url, { path: "/answers" })).body);
        expect(restored.answers).toEqual(answers);
        expect(restored.key).toBe(key);
      } finally {
        await again.close();
      }
    } finally {
      await served.close();
    }
  });

  it("refuses answers under another key, non-JSON posts and other host names", async () => {
    const { served, key, directory } = await serving();
    try {
      const post = (body: string, headers: Record<string, string>) =>
        send(served.url, { method: "POST", path: "/answers", headers, body });
      const body = JSON.stringify({ key, value: "{}" });
      expect((await post(JSON.stringify({ key: "other.key", value: "{}" }), json)).status).toBe(
        400
      );
      expect((await post(body, { "content-type": "text/plain" })).status).toBe(415);
      expect((await post("not json", json)).status).toBe(400);
      expect((await send(served.url, { headers: { host: "evil.example" } })).status).toBe(403);
      expect(
        (await send(served.url, { path: "/answers", headers: { host: "evil.example" } })).status
      ).toBe(403);
      await expect(readFile(join(directory, ratingFiles.answers), "utf8")).rejects.toThrow();
      expect((await post(body, json)).status).toBe(204);
    } finally {
      await served.close();
    }
  });

  it("scores the saved answers against the D20 bar and writes the result next to them", async () => {
    const { directory, served, key } = await serving();
    try {
      const answers = Object.fromEntries(
        parts.sealed.entries.map((entry, at) => [
          entry.key,
          { coerente: true, bemNomeado: at < 24, notas: at < 24 ? "" : "idioma errado" }
        ])
      );
      await send(served.url, {
        method: "POST",
        path: "/answers",
        headers: json,
        body: JSON.stringify({ key, value: JSON.stringify(answers) })
      });
    } finally {
      await served.close();
    }
    const { score, text, resultPath } = await scoreRun(directory);
    expect(score.total.both).toBe(24);
    expect(score.passes).toBe(true);
    expect(text).toContain("E4 PASSES.");
    expect(resultPath).toBe(join(directory, ratingFiles.resultMarkdown));
    const markdown = await readFile(resultPath, "utf8");
    expect(markdown).toContain("# E4 owner blind rating: PASS");
    expect(markdown).toContain("idioma errado");
    expect(markdown).toContain("`hash-of-env-c`");
    const result = JSON.parse(await readFile(join(directory, ratingFiles.resultJson), "utf8"));
    expect(result.score.total.both).toBe(24);
  });

  it("will not score answers of another sample, or before any answer exists", async () => {
    const { directory } = await written();
    await expect(scoreRun(directory)).rejects.toThrow(/no answers yet/u);
    await writeFile(
      join(directory, ratingFiles.answers),
      JSON.stringify({ key: `${ratingAnswerPrefix}other`, value: "{}", answers: {} }),
      "utf8"
    );
    await expect(scoreRun(directory)).rejects.toThrow(/different sample/u);
  });
});

describe("the command line", () => {
  const connections = ["--env-c", "c.json", "--env-g", "g.json", "--env-f", "f.json"];

  it("parses sample, serve and score", () => {
    expect(parseRatingArgs(["sample", ...connections, "--seed", "20261016"])).toEqual({
      kind: "sample",
      connections: { "env-c": "c.json", "env-g": "g.json", "env-f": "f.json" },
      seed: 20261016,
      run: "seed-20261016"
    });
    expect(
      parseRatingArgs(["sample", ...connections, "--seed", "1", "--run", "second"])
    ).toMatchObject({
      run: "second"
    });
    expect(parseRatingArgs(["serve", "seed-1"])).toEqual({
      kind: "serve",
      run: "seed-1",
      port: 5179
    });
    expect(parseRatingArgs(["serve", "seed-1", "--port", "6000"])).toMatchObject({ port: 6000 });
    expect(parseRatingArgs(["score", "seed-1"])).toEqual({ kind: "score", run: "seed-1" });
  });

  it("explains the three commands", () => {
    expect(parseRatingArgs([])).toEqual({ kind: "help" });
    expect(parseRatingArgs(["--help"])).toEqual({ kind: "help" });
    for (const word of ["sample", "serve", "score", "--seed", "D20", "24/30"]) {
      expect(ratingUsage).toContain(word);
    }
  });

  it("rejects missing connections, a bad seed, a bad run name and unknown commands", () => {
    expect(() => parseRatingArgs(["sample", "--seed", "1"])).toThrow(/--env-c is required/u);
    expect(() => parseRatingArgs(["sample", ...connections])).toThrow(/--seed is required/u);
    expect(() => parseRatingArgs(["sample", ...connections, "--seed=-1"])).toThrow(/whole number/u);
    expect(() => parseRatingArgs(["sample", ...connections, "--seed", "1.5"])).toThrow(
      /whole number/u
    );
    expect(() =>
      parseRatingArgs(["sample", ...connections, "--seed", "1", "--run", "../x"])
    ).toThrow(/plain name/u);
    expect(() => parseRatingArgs(["serve"])).toThrow(/exactly one/u);
    expect(() => parseRatingArgs(["frobnicate"])).toThrow(/Unknown command/u);
  });
});
