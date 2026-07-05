import type { ChildProcess } from "node:child_process";

export interface SidecarExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface SidecarExecResult {
  stdout: string;
  stderr: string;
}

export interface SidecarCommandRunner {
  execFile(file: string, args: readonly string[], options?: SidecarExecOptions): Promise<SidecarExecResult>;
  spawn(file: string, args: readonly string[], options?: SidecarExecOptions): ChildProcess;
}

export interface PostgresSidecarConfig {
  binDir: string;
  dataDir: string;
  database: string;
  user: string;
  password: string;
  host?: string;
  port?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  extraServerOptions?: readonly string[];
  runner?: SidecarCommandRunner;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export interface PostgresSidecarConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionString: string;
}

export type PostgresSidecarState = "stopped" | "starting" | "running" | "stopping";
