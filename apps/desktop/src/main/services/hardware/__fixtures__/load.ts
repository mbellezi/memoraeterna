import { readFileSync } from "node:fs";

import {
  macCommands,
  windowsCommand,
  type CommandRunner,
  type HardwareCommand
} from "../commands.js";

/**
 * Recorded and documented command outputs of the hardware probe (F4 T97):
 * - `macos-m4-max-64gb.*` were recorded on a MacBook Pro (M4 Max, 64 GB, macOS 27) with the displays
 *   replaced by synthetic ones, so no real display serial number is committed;
 * - `macos-derived-*` change the recorded values to the machines named (an M3 with 16 GB, an M1 under
 *   Rosetta, a wired limit, an Intel Mac): the format is the recorded one, the values are not
 *   measured on those machines;
 * - `windows-documented-*` follow the output format Microsoft documents for the CIM classes and the
 *   registry value the script reads; no Windows hardware was available, so they are not recordings.
 * Every fixture also carries identifiers (serial numbers, hostnames, device paths) that must never
 * reach a profile.
 */
export function fixture(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

export interface MacFixture {
  sysctl: string;
  displays: string;
}

export const macFixtures = {
  m4Max64: { sysctl: "macos-m4-max-64gb.sysctl.txt", displays: "macos-m4-max-64gb.displays.json" },
  m3Mac16: {
    sysctl: "macos-derived-m3-16gb.sysctl.txt",
    displays: "macos-derived-m3-16gb.displays.json"
  },
  rosettaM1: {
    sysctl: "macos-derived-rosetta-m1-8gb.sysctl.txt",
    displays: "macos-derived-rosetta-m1-8gb.displays.json"
  },
  wiredLimit24: {
    sysctl: "macos-derived-m4-pro-24gb-wired-limit.sysctl.txt",
    displays: "macos-derived-m4-pro-24gb-wired-limit.displays.json"
  },
  intel32: {
    sysctl: "macos-derived-intel-32gb.sysctl.txt",
    displays: "macos-derived-intel-32gb.displays.json"
  }
} as const;

export const windowsFixtures = {
  rtx4090: "windows-documented-rtx-4090.json",
  coreUltra: "windows-documented-core-ultra-igpu.json",
  snapdragon: "windows-documented-snapdragon-x.json",
  displayOnly: "windows-documented-basic-display-only.json",
  error: "windows-documented-error.txt"
} as const;

/** What a fake runner answers per command; a missing answer means the command did not answer. */
export interface FakeAnswers {
  sysctl?: string | null;
  displays?: string | null;
  windows?: string | null;
}

export function fakeRunner(answers: FakeAnswers): CommandRunner & { calls: HardwareCommand[] } {
  const calls: HardwareCommand[] = [];
  const windows = windowsCommand({}).file;
  const run = async (command: HardwareCommand): Promise<string | null> => {
    calls.push(command);
    if (command.file === macCommands.sysctl.file) return answers.sysctl ?? null;
    if (command.file === macCommands.displays.file) return answers.displays ?? null;
    if (command.file === windows) return answers.windows ?? null;
    throw new Error(`unexpected command ${command.file}`);
  };
  return Object.assign(run, { calls });
}

export function macRunner(files: MacFixture): CommandRunner & { calls: HardwareCommand[] } {
  return fakeRunner({ sysctl: fixture(files.sysctl), displays: fixture(files.displays) });
}
