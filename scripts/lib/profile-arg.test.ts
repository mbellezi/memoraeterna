import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultUserDataPath,
  parseProfileArg,
  ProfileArgError,
  readProfileDescriptor,
  resolveMatchingScriptProfile
} from "./profile-arg.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));

let workspace: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-profile-arg-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("parseProfileArg", () => {
  it("reads --profile in both spellings and returns the other arguments in order", () => {
    expect(parseProfileArg(["baseline", "--profile", "/work/profile", "0.9"])).toEqual({
      profile: "/work/profile",
      rest: ["baseline", "0.9"]
    });
    expect(parseProfileArg(["--profile=/work/profile", "--snapshot"])).toEqual({
      profile: "/work/profile",
      rest: ["--snapshot"]
    });
  });

  it("refuses a missing, empty, valueless, repeated or relative --profile", () => {
    for (const argv of [
      [],
      ["baseline"],
      ["--profile"],
      ["--profile", "--snapshot"],
      ["--profile="],
      ["--profile", "  "],
      ["--profile", "/a", "--profile", "/b"],
      ["--profile", "relative/dir"],
      ["--profile=./here"]
    ])
      expect(() => parseProfileArg(argv), JSON.stringify(argv)).toThrow(ProfileArgError);
    expect(() => parseProfileArg([])).toThrow("--profile is required");
    expect(() => parseProfileArg(["--profile", "relative/dir"])).toThrow("absolute");
  });

  it("refuses the default DEV userData path, inside it and above it, in any case", () => {
    const home = "/Users/example";
    const dflt = defaultUserDataPath(home);
    expect(dflt).toBe("/Users/example/Library/Application Support/@app/desktop");
    for (const path of [
      dflt,
      `${dflt}/`,
      join(dflt, "database"),
      dflt.toUpperCase(),
      "/Users/example/Library/Application Support",
      "/Users/example"
    ])
      expect(() => parseProfileArg(["--profile", path], { home }), path).toThrow(
        "default DEV userData"
      );
    expect(
      parseProfileArg(["--profile", join(homedir(), "elsewhere", "scratch")], { home }).profile
    ).toBe(join(homedir(), "elsewhere", "scratch"));
  });
});

describe("readProfileDescriptor", () => {
  async function profileWith(content: string) {
    await mkdir(join(workspace, "database"), { recursive: true });
    await writeFile(join(workspace, "database", "dev-connection.json"), content);
    return workspace;
  }

  it("returns a loopback DEV descriptor", async () => {
    const profile = await profileWith(
      JSON.stringify({
        developmentOnly: true,
        connectionString: "postgresql://user:pw@127.0.0.1:5544/db",
        psqlPath: "/x/bin/psql"
      })
    );
    expect(await readProfileDescriptor(profile)).toEqual({
      connectionString: "postgresql://user:pw@127.0.0.1:5544/db",
      psqlPath: "/x/bin/psql"
    });
  });

  it("refuses a missing file, a non-DEV file and a remote host without echoing the descriptor", async () => {
    await expect(readProfileDescriptor(workspace)).rejects.toThrow(ProfileArgError);
    for (const content of [
      "not json",
      JSON.stringify({
        developmentOnly: false,
        connectionString: "postgresql://u:topsecret@127.0.0.1/x"
      }),
      JSON.stringify({
        developmentOnly: true,
        connectionString: "postgresql://u:topsecret@db.example.com/x"
      }),
      JSON.stringify({ developmentOnly: true, connectionString: "topsecret" })
    ]) {
      const profile = await profileWith(content);
      const error = await readProfileDescriptor(profile).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProfileArgError);
      expect(String((error as Error).message)).not.toContain("topsecret");
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe("resolveMatchingScriptProfile", () => {
  it("accepts a scratch profile and gives the runner's artifact folder", async () => {
    const profile = join(workspace, ".cache", "f5", "scratch", "pilot");
    await mkdir(profile, { recursive: true });
    const resolved = await resolveMatchingScriptProfile(
      ["--profile", profile, "--baseline"],
      "pilot",
      { workspaceRoot: workspace }
    );
    expect(resolved).toEqual({
      profilePath: profile,
      outputDirectory: join(profile, "matching-pilot"),
      rest: ["--baseline"]
    });
  });

  it("refuses a profile that is not scratch, and writes nothing", async () => {
    const other = join(workspace, "dev");
    await mkdir(other, { recursive: true });
    await expect(
      resolveMatchingScriptProfile(["--profile", other], "benchmark", { workspaceRoot: workspace })
    ).rejects.toThrow("matching.errors.notScratchProfile");
    await expect(
      resolveMatchingScriptProfile([], "benchmark", { workspaceRoot: workspace })
    ).rejects.toThrow("--profile is required");
  });
});

const scripts = [
  "scripts/matching-pilot-report.ts",
  "scripts/matching-benchmark-report.ts",
  "scripts/matching-benchmark-status.ts",
  "scripts/select-matching-benchmark.ts",
  "scripts/analyze-matching-pilot.ts",
  "scripts/analyze-matching-benchmark.ts"
];

describe("the matching scripts", () => {
  it("read the profile only through --profile and never name the default profile or .cache artifacts", async () => {
    for (const script of scripts) {
      const source = await readFile(join(repository, script), "utf8");
      expect(source, script).toContain("./lib/profile-arg.ts");
      expect(source, script).toMatch(/scriptProfile\("(pilot|benchmark)"\)/u);
      expect(source, script).not.toContain("Application Support");
      expect(source, script).not.toContain("homedir");
      expect(source, script).not.toMatch(/\.cache\/matching-/u);
    }
  });

  it("exit 2 on a missing --profile and on the default path before any read (the light scripts; the rest by source)", async () => {
    const run = (script: string, args: string[]) =>
      new Promise<{ code: number | null; stderr: string; stdout: string }>((done) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
          cwd: repository,
          env: { ...process.env, MEMORA_USER_DATA_DIR: "" },
          stdio: ["ignore", "pipe", "pipe"]
        });
        let stderr = "";
        let stdout = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.on("close", (code) => done({ code, stderr, stdout }));
      });
    const cases = [
      { args: [], message: "--profile is required" },
      { args: ["--profile", defaultUserDataPath()], message: "default DEV userData" }
    ];
    // One process at a time: each start loads the TypeScript runner. The report and select scripts
    // import the database package before their first line runs, so they are checked by source above.
    const light = scripts.filter((script) => /status|analyze/u.test(script));
    for (const script of light)
      for (const c of cases) {
        const r = await run(script, c.args);
        expect(r.code, `${script} ${c.message}`).toBe(2);
        expect(r.stderr, `${script} ${c.message}`).toContain(c.message);
        expect(r.stdout, script).toBe("");
      }
  }, 240_000);
});
