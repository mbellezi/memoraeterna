import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
const source = await readFile(
  new URL("../apps/desktop/out/preload/index.cjs", import.meta.url),
  "utf8"
);
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

// The typed event bus (F4 D26): one IPC listener serves every subscription, a payload that does not
// match its schema is dropped in the preload, and the listener goes with the last subscription.
const app = exposed.get("app");
assert.equal(typeof app?.onAppEvent, "function");
assert.equal((wires.get("app:events") ?? []).length, 0);
const received = [];
const stopJobs = app.onAppEvent("job.progress", (event) => received.push(event.type));
const stopDownloads = app.onAppEvent("model.download", (event) => received.push(event.type));
assert.equal(wires.get("app:events").length, 1);
const deliver = (payload) => wires.get("app:events").forEach((handler) => handler({}, payload));
const counts = { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
deliver({ type: "job.progress", lanes: "not counts" });
deliver({ type: "nothing.here" });
deliver({
  type: "job.progress",
  lanes: { heavy: counts, light: counts },
  changedIds: [],
  changedIdsTruncated: false
});
assert.deepEqual([...received], ["job.progress"]);
stopJobs();
assert.equal(wires.get("app:events").length, 1);
stopDownloads();
assert.equal(wires.get("app:events").length, 0);
console.log(
  "Built sandbox preload initializes with only Electron available, exposes the typed prompt command surface and validates the typed event bus."
);
