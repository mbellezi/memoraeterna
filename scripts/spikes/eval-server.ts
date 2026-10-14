// Serves a generated spike evaluation page on 127.0.0.1 and persists the owner's
// answers to a JSON file, so evaluations never need to be copied by hand.
//
// Usage: npx tsx scripts/spikes/eval-server.ts [--page <html>] [--out <json>] [--port <n>]
// Defaults: .cache/spikes/topic-tree/avaliacao.html → avaliacao-respostas.json, port 5179.
//
// The page keeps answers in localStorage under keys starting with ANSWER_PREFIX. An
// injected script mirrors every write of those keys to POST /answers and, on load,
// restores answers saved by the server when the browser has none (any browser works).
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ANSWER_PREFIX = "memora.spikeB.avaliacao.";
const MAX_BODY_BYTES = 1_000_000;

const { values } = parseArgs({
  options: {
    page: { type: "string", default: ".cache/spikes/topic-tree/avaliacao.html" },
    out: { type: "string" },
    port: { type: "string", default: "5179" }
  }
});

const pagePath = resolve(values.page ?? "");
const outPath = resolve(values.out ?? join(dirname(pagePath), "avaliacao-respostas.json"));
const port = Number(values.port);

const injected = `<script>
(function () {
  var prefix = ${JSON.stringify(ANSWER_PREFIX)};
  var original = Storage.prototype.setItem;
  function push(key, value) {
    fetch("/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: key, value: value })
    }).catch(function () {});
  }
  Storage.prototype.setItem = function (key, value) {
    original.call(this, key, value);
    if (String(key).indexOf(prefix) === 0) push(String(key), String(value));
  };
  try {
    var request = new XMLHttpRequest();
    request.open("GET", "/answers", false);
    request.send();
    if (request.status === 200) {
      var saved = JSON.parse(request.responseText);
      if (saved && saved.key && saved.value && !window.localStorage.getItem(saved.key)) {
        original.call(window.localStorage, saved.key, saved.value);
      }
    }
  } catch (error) {}
})();
</script>`;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function saveAnswers(body: string): Promise<void> {
  const parsed = JSON.parse(body) as { key?: unknown; value?: unknown };
  if (typeof parsed.key !== "string" || !parsed.key.startsWith(ANSWER_PREFIX)) {
    throw new Error("unexpected key");
  }
  if (typeof parsed.value !== "string") throw new Error("value must be a string");
  const record = {
    key: parsed.key,
    value: parsed.value,
    answers: JSON.parse(parsed.value) as unknown,
    savedAt: new Date().toISOString()
  };
  const temporary = `${outPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporary, outPath);
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

const server = createServer((request, response) => {
  void (async () => {
    try {
      if (request.method === "GET" && (request.url === "/" || request.url === "/index.html")) {
        const html = await readFile(pagePath, "utf8");
        const withHook = html.includes("<head>")
          ? html.replace("<head>", `<head>${injected}`)
          : `${injected}${html}`;
        send(response, 200, "text/html; charset=utf-8", withHook);
      } else if (request.method === "GET" && request.url === "/answers") {
        const saved = await readFile(outPath, "utf8").catch(() => "{}");
        send(response, 200, "application/json", saved);
      } else if (request.method === "POST" && request.url === "/answers") {
        await saveAnswers(await readBody(request));
        send(response, 204, "text/plain", "");
      } else {
        send(response, 404, "text/plain", "not found");
      }
    } catch (error) {
      send(response, 400, "text/plain", error instanceof Error ? error.message : "error");
    }
  })();
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Evaluation page: http://127.0.0.1:${port}/  (answers → ${outPath})`);
});
