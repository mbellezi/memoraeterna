import { resolve } from "node:path";

export interface ResolvePostgresSidecarPathsInput {
  readonly cwd?: string;
  readonly resourcesPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: NodeJS.Architecture;
  readonly env?: NodeJS.ProcessEnv;
}

export interface PostgresSidecarPaths {
  readonly rootDir: string;
  readonly binDir: string;
  readonly libDir: string;
  readonly shareDir: string;
}

export function resolvePostgresSidecarPaths(
  input: ResolvePostgresSidecarPathsInput = {}
): PostgresSidecarPaths {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const explicitRoot = env.MEMORA_POSTGRES_SIDECAR_ROOT;
  const explicitBin = env.MEMORA_POSTGRES_BIN_DIR;

  if (explicitRoot) {
    return fromRoot(explicitRoot);
  }

  if (explicitBin) {
    const rootDir = resolve(explicitBin, "..");
    return {
      rootDir,
      binDir: explicitBin,
      libDir: resolve(rootDir, "lib"),
      shareDir: resolve(rootDir, "share")
    };
  }

  const platformArch = `${platform}-${arch}`;
  const relativeRoot = `sidecars/postgres/${platformArch}/postgresql-18.4`;
  const baseDir = input.resourcesPath ?? resolve(input.cwd ?? process.cwd(), "vendor");
  return fromRoot(resolve(baseDir, relativeRoot));
}

function fromRoot(rootDir: string): PostgresSidecarPaths {
  return {
    rootDir,
    binDir: resolve(rootDir, "bin"),
    libDir: resolve(rootDir, "lib"),
    shareDir: resolve(rootDir, "share")
  };
}
