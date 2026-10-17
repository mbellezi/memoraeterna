import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readFile, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Script } from "node:vm";
import { extractFile, listPackage } from "@electron/asar";

// Static artifact validation only. Executable startup remains a separate,
// explicitly authorized smoke; this script never launches a native process.
const root = resolve(import.meta.dirname, "..");
const resources = join(root, "apps/desktop/release/mac-arm64/Memora Eterna.app/Contents/Resources");
const archive = join(resources, "app.asar");
const files = new Set(listPackage(archive));
for (const path of [
  "/out/main/index.js",
  "/out/preload/index.cjs",
  "/out/renderer/index.html",
  "/package.json"
])
  assert.ok(files.has(path), `Missing ${path}`);
for (const path of ["out/main/index.js", "out/renderer/index.html"])
  assert.deepEqual(
    extractFile(archive, path),
    await readFile(join(root, "apps/desktop", path)),
    `Stale packaged ${path}`
  );
const packagedPreload = extractFile(archive, "out/preload/index.cjs");
assert.deepEqual(packagedPreload, await readFile(join(root, "apps/desktop/out/preload/index.cjs")));
const exposed = new Map();
new Script(packagedPreload.toString("utf8"), { filename: "packaged-preload.cjs" }).runInNewContext({
  require(name) {
    assert.equal(name, "electron", `Sandbox preload cannot load ${name}`);
    return {
      contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
      ipcRenderer: { invoke: async () => null, on: () => {}, removeListener: () => {} }
    };
  },
  console,
  URL,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout
});
for (const [owner, methods] of Object.entries({
  prompts: ["command"],
  consultation: ["ask", "cancel"],
  wiki: ["search"],
  topics: [
    "tree",
    "path",
    "page",
    "notes",
    "shape",
    "changeSet",
    "mutate",
    "undo",
    "review",
    "status",
    "reembed",
    "overview",
    "cancelOverview",
    "subscribeChanged"
  ],
  system: ["subscribeNavigation"],
  relations: ["subscribeChanged"],
  ai: ["classRoutes", "applyPreset", "testClassRoute", "setClassRoute", "setDeciderMode"]
})) {
  for (const method of methods)
    assert.equal(typeof exposed.get("app")?.[owner]?.[method], "function", `${owner}.${method}`);
}
// The legacy wiki, curator, organization and maintenance surface was removed (F2 T39r, T40r): the
// packaged preload must not expose any of it.
const app = exposed.get("app");
for (const owner of ["curator", "organization", "maintenance", "investigations"])
  assert.equal(app?.[owner], undefined, `${owner} was removed from the preload`);
for (const [owner, methods] of Object.entries({
  consultation: ["save"],
  wiki: [
    "tree",
    "context",
    "get",
    "history",
    "linkedTarget",
    "resolveLinks",
    "collection",
    "save",
    "list"
  ],
  jobs: ["cancelBatch"]
}))
  for (const method of methods)
    assert.equal(app?.[owner]?.[method], undefined, `${owner}.${method} was removed`);
const manifest = JSON.parse(await readFile(join(resources, "runtime-manifest.json"), "utf8"));
assert.equal(manifest.platform, "darwin-arm64");
const required = [
  "postgres-sidecar",
  "docling-sidecar",
  "mlx-helper",
  "drizzle-migrations",
  "database-seed",
  "docling-bridge"
];
let checkedFiles = 0;
for (const name of required) {
  const artifact = manifest.artifacts.find((item) => item.id === name);
  assert.ok(artifact?.available, name);
  assert.ok(artifact.files.length);
  for (const file of artifact.files) {
    const path = resolve(resources, file.path),
      child = relative(resources, path);
    assert.ok(
      child && !child.startsWith("..") && !isAbsolute(child),
      "Manifest path remains inside Resources"
    );
    const info = await lstat(path);
    if (file.symlink !== undefined) {
      assert.ok(info.isSymbolicLink());
      const target = await readlink(path);
      assert.equal(target, file.symlink);
      assert.equal(Buffer.byteLength(target), file.sizeBytes);
      assert.equal(createHash("sha256").update(target).digest("hex"), file.sha256);
    } else {
      assert.ok(info.isFile());
      assert.equal(info.size, file.sizeBytes);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      assert.equal(hash.digest("hex"), file.sha256, file.path);
    }
    checkedFiles++;
  }
  assert.equal(
    createHash("sha256")
      .update(
        artifact.files.map((file) => `${file.path}:${file.sizeBytes}:${file.sha256}`).join("\n")
      )
      .digest("hex"),
    artifact.packageChecksum
  );
}
const journal = JSON.parse(
  await readFile(join(root, "packages/db/drizzle/meta/_journal.json"), "utf8")
);
assert.deepEqual(
  await readFile(join(resources, "drizzle/meta/_journal.json")),
  await readFile(join(root, "packages/db/drizzle/meta/_journal.json"))
);
for (const entry of journal.entries)
  assert.deepEqual(
    await readFile(join(resources, "drizzle", entry.tag + ".sql")),
    await readFile(join(root, "packages/db/drizzle", entry.tag + ".sql"))
  );
for (const name of ["baseline.sql", "manifest.json"])
  assert.deepEqual(
    await readFile(join(resources, "db-seed", name)),
    await readFile(join(root, "packages/db/seed", name))
  );
const sbom = JSON.parse(await readFile(join(resources, "sbom.spdx.json"), "utf8"));
assert.equal(sbom.spdxVersion, "SPDX-2.3");
for (const name of required)
  assert.ok(sbom.packages.some((item) => item.SPDXID === "SPDXRef-Package-" + name));
await access(join(resources, "LICENSE"));
const pluginRoot = join(root, "apps/obsidian-plugin/dist");
const plugin = await readFile(join(pluginRoot, "main.js"), "utf8");
const module = { exports: {} };
new Script(plugin, { filename: "obsidian-main.cjs" }).runInNewContext({
  module,
  exports: module.exports,
  require(name) {
    assert.equal(name, "obsidian", `Plugin bundle cannot load ${name}`);
    return {
      Plugin: class {},
      PluginSettingTab: class {},
      Modal: class {},
      ItemView: class {},
      Notice: class {}
    };
  },
  console,
  URL,
  TextEncoder,
  TextDecoder,
  setTimeout,
  clearTimeout
});
assert.equal(typeof module.exports, "function");
const pluginManifest = JSON.parse(await readFile(join(pluginRoot, "manifest.json"), "utf8"));
assert.deepEqual(
  pluginManifest,
  JSON.parse(await readFile(join(root, "apps/obsidian-plugin/public/manifest.json"), "utf8"))
);
console.log(
  JSON.stringify(
    {
      ok: true,
      executableStarted: false,
      platform: manifest.platform,
      migrations: journal.entries.length,
      runtimeArtifacts: required.length,
      checkedFiles,
      preloadOwners: [...exposed.keys()],
      pluginVersion: pluginManifest.version,
      packageRoot: dirname(resources),
      asarSha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex")
    },
    null,
    2
  )
);
