import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// The hourly watchdog of the 7-day soak (F4 T89), rehearsed at the scale of seconds: a fake `npm`
// stands for the report's `--status` digest, a `sleep` for the app, and the plan is a copy with a
// profile that lasts a few seconds. What it proves: the stop checks write STOP (E1 and the token
// budget among them), the hard stop is the profile's duration plus an hour (read from the plan, not
// 25 h), the app is ended at the hard stop, and the local-model lock is given up only when it names
// the run.
const script = resolve(import.meta.dirname, "watch-soak.sh");
const scratch: string[] = [];
const children: number[] = [];
afterEach(() => {
  for (const pid of children.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function rehearsal(status: string, durationHours = 0.0006) {
  const root = mkdtempSync(join(tmpdir(), "watch-soak-"));
  scratch.push(root);
  const data = join(root, "data");
  const run = join(data, "f4", "soak", "run1");
  mkdirSync(run, { recursive: true });
  mkdirSync(join(data, "f2"), { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "status.txt"), `${status}\n`);
  writeFileSync(join(bin, "npm"), `#!/bin/sh\ncat "${join(root, "status.txt")}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const plan = join(root, "plan.json");
  writeFileSync(
    plan,
    JSON.stringify({ profiles: { quick: { durationHours }, long: { durationHours: 168 } } })
  );
  return { root, data, run, bin, plan, lock: join(data, "f2", "LOCAL_MODEL_BUSY") };
}

function watch(
  setup: ReturnType<typeof rehearsal>,
  profile: string,
  pid: number,
  env: Record<string, string> = {}
) {
  return spawn("zsh", [script, profile, setup.run, String(pid)], {
    env: {
      ...process.env,
      PATH: `${setup.bin}:${process.env.PATH}`,
      WATCH_PLAN: setup.plan,
      WATCH_INTERVAL_SECONDS: "1",
      WATCH_GRACE_HOURS: "0",
      WATCH_STOP_WAIT_SECONDS: "1",
      WATCH_TERM_WAIT_SECONDS: "1",
      // The rehearsal ends only its own `sleep`: never a dev server of the checkout it runs in.
      WATCH_KILL_PATTERN: "",
      ...env
    }
  });
}

const app = () => {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child.pid!);
  return child;
};

const output = (child: ReturnType<typeof spawn>) => {
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  return () => text;
};

const exited = (child: ReturnType<typeof spawn>) =>
  new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the watchdog of a soak", () => {
  it("reads the hard stop from the plan: the profile's duration plus an hour", () => {
    const { plan, run, bin } = rehearsal("Soak x: PASS so far");
    const result = spawnSync("zsh", [script, "long", run, "999999"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WATCH_PLAN: plan },
      encoding: "utf8"
    });
    // The app (pid 999999) does not exist: the loop never starts, so the line below is all it prints.
    expect(result.stdout).toContain("hard stop after 169 h 0 min");
    expect(
      spawnSync("zsh", [script, "nope", run, "1"], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WATCH_PLAN: plan },
        encoding: "utf8"
      }).stdout
    ).toContain("the plan has no profile nope");
  });

  it.each([
    "FAIL E1 blocked by another: 1 blocked task(s), 0 lock wait(s)",
    "FAIL Tokens and cap: 4700000 tokens",
    "FAIL Calls past deadline: 2 audited",
    "FAIL Helper restarts: 3 restart(s) for 2 injected kill(s)"
  ])(
    "writes STOP on %s",
    async (line) => {
      const setup = rehearsal(`Soak run: FAIL so far\n${line}`, 0.01);
      const target = app();
      const child = watch(setup, "quick", target.pid!);
      const text = output(child);
      await new Promise((done) => setTimeout(done, 2_200));
      expect(existsSync(join(setup.run, "STOP"))).toBe(true);
      expect(text()).toContain("STOP file written");
      expect(readFileSync(join(setup.run, "status-hourly.log"), "utf8")).toContain(line);
      process.kill(target.pid!, "SIGKILL");
      await exited(child);
    },
    20_000
  );

  it("ends an app that does not quit after a stop check's STOP (a wedged driver), so the spending stops", async () => {
    const setup = rehearsal("Soak run: FAIL so far\nFAIL Tokens and cap: 4700000 tokens", 0.01);
    const target = app();
    const child = watch(setup, "quick", target.pid!, { WATCH_FAIL_WAIT_SECONDS: "1" });
    const text = output(child);
    expect(await exited(child)).toBe(0);
    expect(existsSync(join(setup.run, "STOP"))).toBe(true);
    expect(text()).toContain("did not quit 1 s after STOP");
    expect(alive(target.pid!)).toBe(false);
  }, 30_000);

  it("writes no STOP for a review: a lane that is not exercised, or an E5 mismatch to look at", async () => {
    const setup = rehearsal(
      "Soak run: REVIEW so far\nREVIEW E1 blocked by another: not exercised",
      0.01
    );
    const target = app();
    const child = watch(setup, "quick", target.pid!);
    const text = output(child);
    await new Promise((done) => setTimeout(done, 2_200));
    expect(existsSync(join(setup.run, "STOP"))).toBe(false);
    expect(text()).toContain("REVIEW E1 blocked by another");
    process.kill(target.pid!, "SIGKILL");
    await exited(child);
  }, 20_000);

  it("ends the app at the hard stop after asking for a graceful end", async () => {
    const setup = rehearsal("Soak run: PASS so far", 0.0006);
    const target = app();
    const child = watch(setup, "quick", target.pid!);
    const text = output(child);
    expect(await exited(child)).toBe(0);
    expect(text()).toContain("hard stop reached");
    expect(existsSync(join(setup.run, "STOP"))).toBe(true);
    expect(alive(target.pid!)).toBe(false);
  }, 30_000);

  it("gives up the lock when it names the run, and leaves another holder's lock alone", async () => {
    for (const [content, kept] of [
      ["soak:soak7 pid 11 run run1\n", false],
      ["T69 pid 12\n", true],
      // Another run whose name begins with this one's is not this run.
      ["soak:soak7 pid 13 run run12\n", true]
    ] as const) {
      const setup = rehearsal("Soak run: PASS so far", 0.01);
      writeFileSync(setup.lock, content);
      const target = app();
      const child = watch(setup, "quick", target.pid!);
      await new Promise((done) => setTimeout(done, 300));
      process.kill(target.pid!, "SIGKILL");
      await exited(child);
      expect(existsSync(setup.lock)).toBe(kept);
    }
  }, 30_000);
});
