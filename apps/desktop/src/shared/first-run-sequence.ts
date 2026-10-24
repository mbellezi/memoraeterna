// The IPC sequence of the first run in Hybrid (F4 T90, extended by T96): what the onboarding calls,
// in order, from the question whether the first run is due to the last class test. The first-run
// end-to-end harness plays the renderer and issues exactly this; the onboarding controller makes
// these calls and its test asserts that they equal this fixture, so the proof and the screen cannot
// drift apart. Pure and free of Electron, so the renderer and the harness both import it.
//
// Steps (decision 31): the view is due (`onboarding.state`); (1) the languages; (2) the AI mode, in
// Hybrid: the tier card (`hardware.profile` and the model list, which state what the setups
// download before anything is fetched), the writer (the sign-in, then its provider and profile),
// the embedder (the ranker follows on its own once the embedding route exists, decision 19), the
// preset, then one test per class that has a route; (3) the first source, which is the user phase
// of the run and is not part of this sequence.
import type { AiClassRouteTarget } from "./ipc.js";
import { ipcChannels } from "./ipc.js";

export type SetupStepId = "state" | "languages" | "card" | "writer" | "models" | "preset" | "tests";

export interface SetupCall {
  step: SetupStepId;
  /** The IPC channel the renderer invokes. */
  channel: string;
  /**
   * The browser sign-in cannot run without a browser: the harness puts the credential where the
   * sign-in leaves it (`pendingOpenAiCodexCredential`) and does not invoke the channel. A controller
   * test that drives the real channel skips these entries.
   */
  substitutedByHarness?: boolean;
}

/** The classes tested right after the preset, in the order Settings lists them. `decide` has no route yet. */
export const firstRunClassTests: readonly AiClassRouteTarget[] = [
  "embed",
  "write-fast",
  "write-quality",
  "answer",
  "judge"
];

export type WriterKind = "codex" | "remote";

/** The setup calls of the first run in Hybrid, in order, for a writer signed in with `writer`. */
export function hybridSetupSequence(writer: WriterKind): readonly SetupCall[] {
  return [
    { step: "state", channel: ipcChannels.onboardingState },
    { step: "languages", channel: ipcChannels.appSettingsUpdate },
    { step: "card", channel: ipcChannels.hardwareProfile },
    { step: "card", channel: ipcChannels.localModelsList },
    ...(writer === "codex"
      ? [
          {
            step: "writer" as const,
            channel: ipcChannels.aiOpenAiCodexConnect,
            substitutedByHarness: true
          }
        ]
      : []),
    { step: "writer", channel: ipcChannels.aiProvidersSave },
    { step: "writer", channel: ipcChannels.aiProfilesCreate },
    { step: "writer", channel: ipcChannels.aiProfilesUpdate },
    { step: "models", channel: ipcChannels.localModelsDownload },
    { step: "preset", channel: ipcChannels.aiApplyPreset },
    ...firstRunClassTests.map((): SetupCall => ({
      step: "tests",
      channel: ipcChannels.aiTestClassRoute
    }))
  ];
}

/** The channels the harness invokes in the setup phase: the sequence without what it substitutes. */
export function invokedSetupChannels(writer: WriterKind): string[] {
  return hybridSetupSequence(writer)
    .filter((call) => !call.substitutedByHarness)
    .map((call) => call.channel);
}
