import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Script } from "node:vm";

// The built preload to check: the one `electron-vite build` wrote, or the file named on the command
// line (the unit test builds a preload of its own and runs this script against it).
const preloadFile = process.argv[2]
  ? resolve(process.argv[2])
  : new URL("../apps/desktop/out/preload/index.cjs", import.meta.url);
const source = await readFile(preloadFile, "utf8");
const exposed = new Map();
const wires = new Map();
new Script(source, { filename: "sandbox-preload.js" }).runInNewContext({
  require(name) {
    assert.equal(name, "electron", `Sandbox preload cannot resolve external module ${name}`);
    return {
      contextBridge: { exposeInMainWorld: (key, api) => exposed.set(key, api) },
      ipcRenderer: {
        invoke: async () => null,
        on: (channel, handler) => wires.set(channel, [...(wires.get(channel) ?? []), handler]),
        removeListener: (channel, handler) =>
          wires.set(
            channel,
            (wires.get(channel) ?? []).filter((candidate) => candidate !== handler)
          )
      }
    };
  },
  console,
  URL,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout
});
assert.equal(typeof exposed.get("app")?.prompts?.command, "function");
// The preload exposes one object and, once loaded, listens on one channel only: the typed event bus.
assert.deepEqual([...exposed.keys()], ["app"]);
assert.deepEqual([...wires.keys()], ["app:events"]);

// The typed event bus (F5 D16, T125). The preload listens from the start, so the sticky events main
// replays after the page loads (before any view has subscribed) are not lost: exactly one IPC
// listener exists for the life of the preload, however many subscriptions come and go (never one
// per subscription, never none while one is alive), a payload that does not match its schema is
// dropped in the preload, and a sticky event sent before the first subscription reaches the first
// subscriber once.
const app = exposed.get("app");
assert.equal(typeof app?.onAppEvent, "function");
const listeners = () => (wires.get("app:events") ?? []).length;
const send = (payload) =>
  (wires.get("app:events") ?? []).forEach((handler) => handler({}, payload));
assert.equal(listeners(), 1);

const sticky = (state) => ({ type: "model.loading", modelId: "mlx-embedding", state });
send(sticky("loading"));
send({ type: "job.progress", lanes: "not counts" });
const firstSeen = [];
const stopFirst = app.onAppEvent("model.loading", (event) => firstSeen.push(event.state));
assert.deepEqual(firstSeen, ["loading"]);
assert.equal(listeners(), 1);
send(sticky("ready"));
assert.deepEqual(firstSeen, ["loading", "ready"]);

const received = [];
const stopJobs = app.onAppEvent("job.progress", (event) => received.push(event.type));
const stopDownloads = app.onAppEvent("model.download", (event) => received.push(event.type));
assert.equal(listeners(), 1);
const counts = { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
send({ type: "job.progress", lanes: "not counts" });
send({ type: "nothing.here" });
send({
  type: "job.progress",
  lanes: { heavy: counts, light: counts },
  changedIds: [],
  changedIdsTruncated: false
});
assert.deepEqual([...received], ["job.progress"]);
assert.deepEqual(firstSeen, ["loading", "ready"]);
stopJobs();
assert.equal(listeners(), 1);
stopDownloads();
assert.equal(listeners(), 1);
stopFirst();
assert.equal(listeners(), 1);

// With no subscription left the listener stays, keeps the newest sticky state and hands it, once, to
// the next subscriber; subscribing again adds no listener.
send(sticky("released"));
const lateSeen = [];
const stopLate = app.onAppEvent("model.loading", (event) => lateSeen.push(event.state));
assert.deepEqual(lateSeen, ["released"]);
assert.equal(listeners(), 1);
stopLate();
assert.equal(listeners(), 1);
console.log(
  "Built sandbox preload initializes with only Electron available, exposes the typed prompt command surface and validates the typed event bus."
);
