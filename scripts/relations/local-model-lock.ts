/**
 * The machine-wide local-model lock file of the F3 proofs (`.cache/f2/LOCAL_MODEL_BUSY`, decision D45):
 * a script that runs local inference waits while the file exists, creates it with its task id, and
 * removes it when done, also on failure and on SIGINT or SIGTERM. One local model runs at a time.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LockOptions {
  /** Where the lock file lives. */
  path: string;
  /** Written first in the file so the owner of a lock can be told. */
  owner: string;
  pollMs?: number;
  onWait?: (path: string) => void;
}

/** Waits for the lock file to disappear, creates it atomically and returns its remover. */
export async function acquireLocalModelLock(options: LockOptions): Promise<() => Promise<void>> {
  await mkdir(dirname(options.path), { recursive: true });
  for (;;) {
    try {
      await writeFile(options.path, `${options.owner} pid ${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      options.onWait?.(options.path);
      await new Promise((done) => setTimeout(done, options.pollMs ?? 30_000));
    }
  }
  let released = false;
  const onSignal = (): void => {
    void release().finally(() => process.exit(130));
  };
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await rm(options.path, { force: true });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return release;
}

/** The scorers of `scripts/relations/` take the lock before they run local inference. */
const cooperatesWithTheLock = /scripts\/relations\//u;

/**
 * Waits until no local-model process runs that does not respect the lock file (the DEV app's helper, a
 * spike scorer, node-llama-cpp). `jobs` lists the other local-model processes, as
 * `otherLocalModelJobs()` of the machine-wide slot does. A scorer of `scripts/relations/` that is only
 * waiting for the lock matches the slot pattern too, so those are ignored here: they cannot run before
 * this one releases the lock, and two waiting scorers would otherwise wait for each other for ever.
 */
export async function waitForModelsOutsideTheLock(
  jobs: () => string[],
  options: { pollMs?: number; onWait?: (waitingFor: string[]) => void } = {}
): Promise<void> {
  for (;;) {
    const others = jobs().filter((job) => !cooperatesWithTheLock.test(job));
    if (others.length === 0) return;
    options.onWait?.(others);
    await new Promise((done) => setTimeout(done, options.pollMs ?? 30_000));
  }
}

/** Runs `work` while holding the lock; the lock is removed whether `work` returns or throws. */
export async function withLocalModelLock<T>(
  options: LockOptions,
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireLocalModelLock(options);
  try {
    return await work();
  } finally {
    await release();
  }
}
