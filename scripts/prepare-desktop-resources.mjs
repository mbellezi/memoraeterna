import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(root, "apps", "desktop");
const output = join(desktopRoot, "build-resources");
const platformArch = `${platform}-${arch}`;

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const artifacts = [
  {
    id: "postgres-sidecar",
    version: "18.4+pgvector-0.8.4+age-PG18-v1.7.0-rc0",
    source: join(root, "vendor", "sidecars", "postgres", platformArch, "postgresql-18.4"),
    destination: join(output, "sidecars", "postgres", platformArch, "postgresql-18.4"),
    include: ["bin", "lib", "share"],
    required: true
  },
  {
    id: "docling-sidecar",
    version: "cpython-3.13.13+docling-2.111.0",
    source: join(root, "vendor", "sidecars", "docling", platformArch),
    destination: join(output, "sidecars", "docling", platformArch),
    required: true
  },
  {
    id: "mlx-helper",
    version: "mlx-swift-0.31.6+mlx-swift-lm-3.31.4",
    source: join(root, "native", "mlx-helper", ".build", "release", "memora-mlx-helper"),
    destination: join(output, "sidecars", "mlx", "darwin-arm64", "memora-mlx-helper"),
    required: true,
    platform: "darwin-arm64"
  },
  {
    id: "drizzle-migrations",
    version: "workspace",
    source: join(root, "packages", "db", "drizzle"),
    destination: join(output, "drizzle"),
    required: true
  },
  {
    id: "database-seed",
    version: "workspace",
    source: join(root, "packages", "db", "seed"),
    destination: join(output, "db-seed"),
    required: true
  },
  {
    id: "docling-bridge",
    version: "1",
    source: join(root, "packages", "conversion", "sidecar", "docling_sidecar.py"),
    destination: join(output, "docling", "docling_sidecar.py"),
    required: true
  }
];

const manifestArtifacts = [];
for (const artifact of artifacts) {
  const targeted = !artifact.platform || artifact.platform === platformArch;
  const available = targeted && await exists(artifact.source);
  if (targeted && !available && artifact.required) {
    throw new Error(`Required package artifact is missing: ${relative(root, artifact.source)}`);
  }
  if (available) {
    if (artifact.include) {
      await mkdir(artifact.destination, { recursive: true });
      for (const item of artifact.include) {
        const source = join(artifact.source, item);
        if (!await exists(source)) {
          throw new Error(`Required ${artifact.id} runtime directory is missing: ${relative(root, source)}`);
        }
        await cp(source, join(artifact.destination, item), { recursive: true, force: false, errorOnExist: true });
      }
    } else {
      await mkdir(dirname(artifact.destination), { recursive: true });
      await cp(artifact.source, artifact.destination, { recursive: true, force: false, errorOnExist: true });
    }
  }
  const files = available ? await inventory(artifact.destination, output) : [];
  manifestArtifacts.push({
    id: artifact.id,
    version: artifact.version,
    available,
    files,
    packageChecksum: checksumInventory(files),
    components: artifact.id === "docling-sidecar" && available
      ? await readDoclingComponents(artifact.destination)
      : []
  });
}

const generatedAt = new Date().toISOString();
await writeJson(join(output, "runtime-manifest.json"), {
  version: 1,
  generatedAt,
  platform: platformArch,
  artifacts: manifestArtifacts
});
const topLevelPackages = manifestArtifacts.map((artifact) => ({
  name: artifact.id,
  SPDXID: `SPDXRef-Package-${artifact.id}`,
  versionInfo: artifact.version,
  downloadLocation: "NOASSERTION",
  filesAnalyzed: false,
  ...(artifact.available ? { checksums: [{ algorithm: "SHA256", checksumValue: artifact.packageChecksum }] } : {})
}));
const componentPackages = manifestArtifacts.flatMap((artifact) => artifact.components.map((component, index) => ({
  name: component.name,
  SPDXID: componentSpdxId(artifact.id, component.name, index),
  versionInfo: component.version,
  downloadLocation: component.repository ?? "NOASSERTION",
  filesAnalyzed: false,
  ...(component.sha256 ? { checksums: [{ algorithm: "SHA256", checksumValue: component.sha256 }] } : {})
})));
await writeJson(join(output, "sbom.spdx.json"), {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `memora-eterna-${platformArch}`,
  documentNamespace: `https://memoraeterna.dev/spdx/${encodeURIComponent(generatedAt)}`,
  creationInfo: { created: generatedAt, creators: ["Tool: scripts/prepare-desktop-resources.mjs"] },
  documentDescribes: topLevelPackages.map((artifact) => artifact.SPDXID),
  packages: [...topLevelPackages, ...componentPackages],
  relationships: manifestArtifacts.flatMap((artifact) => artifact.components.map((component, index) => ({
    spdxElementId: `SPDXRef-Package-${artifact.id}`,
    relationshipType: "CONTAINS",
    relatedSpdxElement: componentSpdxId(artifact.id, component.name, index)
  })))
});

console.info(`Prepared desktop resources for ${platformArch}.`);

async function inventory(path, rootPath) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await readlink(path);
    return [{
      path: relative(rootPath, path),
      sizeBytes: Buffer.byteLength(target),
      sha256: createHash("sha256").update(target).digest("hex"),
      symlink: target
    }];
  }
  if (info.isFile()) {
    return [{ path: relative(rootPath, path), sizeBytes: info.size, sha256: await sha256(path) }];
  }
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    result.push(...await inventory(join(path, entry.name), rootPath));
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function readDoclingComponents(path) {
  const manifest = JSON.parse(await readFile(join(path, "runtime-manifest.json"), "utf8"));
  return [
    ...manifest.packages.map((component) => ({
      name: component.name,
      version: component.version
    })),
    ...manifest.models.map((component) => ({
      name: component.repository,
      version: component.revision,
      repository: component.repository.includes("/")
        ? `https://huggingface.co/${component.repository}/tree/${component.revision}`
        : "NOASSERTION",
      sha256: component.manifestSha256
    }))
  ];
}

function checksumInventory(files) {
  const canonical = files.map((file) => `${file.path}:${file.sizeBytes}:${file.sha256}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function componentSpdxId(artifactId, name, index) {
  return `SPDXRef-Component-${artifactId}-${index}-${name.replace(/[^a-zA-Z0-9.-]/g, "-")}`;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
