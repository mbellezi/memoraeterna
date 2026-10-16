// Serves a generated evaluation page on 127.0.0.1 and persists the owner's answers to a JSON
// file, so evaluations never need to be copied by hand. The spike pages run it from the command
// line; `scripts/topics/rating-page.ts` (E4) starts it through `createEvalServer`.
//
// Usage: npx tsx scripts/spikes/eval-server.ts [--page <html>] [--out <json>] [--port <n>]
// Defaults: .cache/spikes/topic-tree/avaliacao.html → avaliacao-respostas.json, port 5179.
//
// The page keeps answers in localStorage under keys starting with the answer prefix. An injected
// script mirrors every write of those keys to POST /answers and, on load, restores answers saved
// by the server when the browser has none (any browser works). It also reports every save on
// `window` as an `evalserver-save` event ({ detail: { ok } }), so a page can show whether the
// answers reached the disk. Nothing leaves 127.0.0.1: the server answers only requests addressed
// to a loopback host name and only accepts JSON posted by a page it served.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const defaultAnswerPrefix = "memora.spikeB.avaliacao.";
const MAX_BODY_BYTES = 1_000_000;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface EvalServerOptions {
  /** The self-contained HTML page served at `/`. Read on every request, so it can be regenerated. */
  pagePath: string;
  /** Where the answers are written: `{ key, value, answers, savedAt }`. */
  outPath: string;
  /** Only localStorage keys starting with this are mirrored and accepted. */
  answerPrefix?: string;
}

function injectedScript(prefix: string): string {
  return `<script>
(function () {
  var prefix = ${JSON.stringify(prefix)};
  var original = Storage.prototype.setItem;
  function report(ok) {
    try {
      window.dispatchEvent(new CustomEvent("evalserver-save", { detail: { ok: ok } }));
    } catch (error) {}
  }
  function push(key, value) {
    fetch("/answers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: key, value: value })
    }).then(function (response) { report(response.ok); }, function () { report(false); });
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
}

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

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(body);
}

/** True when the request names a loopback host and the port this server listens on (no DNS rebinding). */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const header = request.headers.host;
  if (!header) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/u.exec(header);
  if (!match) return false;
  const port = Number(match[2] ?? 80);
  return loopbackHosts.has((match[1] ?? "").toLowerCase()) && port === request.socket.localPort;
}

/** An HTTP server for one evaluation page; the caller listens on it (127.0.0.1 only). */
export function createEvalServer(options: EvalServerOptions): Server {
  const prefix = options.answerPrefix ?? defaultAnswerPrefix;
  const hook = injectedScript(prefix);
  const { pagePath, outPath } = options;

  async function saveAnswers(body: string): Promise<void> {
    const parsed = JSON.parse(body) as { key?: unknown; value?: unknown };
    if (typeof parsed.key !== "string" || !parsed.key.startsWith(prefix)) {
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

  return createServer((request, response) => {
    void (async () => {
      try {
        if (!isLoopbackRequest(request)) {
          send(response, 403, "text/plain", "forbidden");
        } else if (
          request.method === "GET" &&
          (request.url === "/" || request.url === "/index.html")
        ) {
          const html = await readFile(pagePath, "utf8");
          const withHook = html.includes("<head>")
            ? html.replace("<head>", () => `<head>${hook}`)
            : `${hook}${html}`;
          send(response, 200, "text/html; charset=utf-8", withHook);
        } else if (request.method === "GET" && request.url === "/answers") {
          const saved = await readFile(outPath, "utf8").catch(() => "{}");
          send(response, 200, "application/json", saved);
        } else if (request.method === "POST" && request.url === "/answers") {
          // Only a page this server served can send JSON without a failed CORS preflight.
          if (!(request.headers["content-type"] ?? "").startsWith("application/json")) {
            send(response, 415, "text/plain", "json only");
          } else {
            await saveAnswers(await readBody(request));
            send(response, 204, "text/plain", "");
          }
        } else {
          send(response, 404, "text/plain", "not found");
        }
      } catch (error) {
        send(response, 400, "text/plain", error instanceof Error ? error.message : "error");
      }
    })();
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  const { values } = parseArgs({
    options: {
      page: { type: "string", default: ".cache/spikes/topic-tree/avaliacao.html" },
      out: { type: "string" },
      port: { type: "string", default: "5179" }
    }
  });
  const pagePath = resolve(values.page ?? "");
  const outPath = resolve(values.out ?? join(dirname(pagePath), "avaliacao-respostas.json"));
  createEvalServer({ pagePath, outPath }).listen(Number(values.port), "127.0.0.1", () => {
    console.log(`Evaluation page: http://127.0.0.1:${values.port}/  (answers → ${outPath})`);
  });
}
