import { describe, expect, it } from "vitest";

import { messages } from "./index.js";

// The surfaces the unified workspace keeps (card G20) read in pt-BR with their accents. The words
// below are the ones a plain-ASCII value tends to drop; "esta" is a demonstrative when it comes
// before a noun, so it only counts as a verb in front of the words that follow it as one.
const namespaces = [
  "errors",
  "shell",
  "database",
  "app",
  "backup",
  "processing",
  "search",
  "library.containerHint"
];
const unaccented = new RegExp(
  `(?<![\\p{L}\\p{N}])(${[
    "nao",
    "sao",
    "ja",
    "voce",
    "voces",
    "tambem",
    "ate",
    "alem",
    "configuracao",
    "configuracoes",
    "conexao",
    "informacao",
    "informacoes",
    "possivel",
    "disponivel",
    "compativel",
    "invalido",
    "invalida",
    "memoria",
    "evidencia",
    "evidencias",
    "pagina",
    "paginas",
    "secao",
    "secoes",
    "relacao",
    "relacoes",
    "acao",
    "operacao",
    "autenticacao",
    "verificacao",
    "atomica",
    "automatica",
    "automatico",
    "necessaria",
    "obrigatoria",
    "esta (?:em|pronto|pronta|configurad[oa]|ausente|dispon[ií]vel|instalad[oa]|ocupad[oa])"
  ].join("|")})(?![\\p{L}\\p{N}])`,
  "iu"
);

const flat = (node: unknown, path = "", out: [string, string][] = []): [string, string][] => {
  if (typeof node === "string") out.push([path, node]);
  else if (node !== null && typeof node === "object")
    for (const [key, value] of Object.entries(node))
      flat(value, path === "" ? key : `${path}.${key}`, out);
  return out;
};

describe("pt-BR values of the kept surfaces", () => {
  it("keep their accents", () => {
    const lacking = flat(messages["pt-BR"])
      .filter(([key]) => namespaces.some((ns) => key === ns || key.startsWith(`${ns}.`)))
      .filter(([, value]) => unaccented.test(value));
    expect(lacking).toEqual([]);
  });
});
