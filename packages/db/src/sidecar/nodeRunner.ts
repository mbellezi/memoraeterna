import { execFile as execFileCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

import type { SidecarCommandRunner, SidecarExecOptions, SidecarExecResult } from "./types.js";

const execFileAsync = promisify(execFileCallback);

export class NodeSidecarCommandRunner implements SidecarCommandRunner {
  async execFile(file: string, args: readonly string[], options: SidecarExecOptions = {}): Promise<SidecarExecResult> {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs
    });
    return {
      stdout: String(stdout),
      stderr: String(stderr)
    };
  }

  spawn(file: string, args: readonly string[], options: SidecarExecOptions = {}) {
    return spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "ignore", "ignore"]
    });
  }
}
