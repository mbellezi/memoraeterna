// The IPC sequence of the first run in Hybrid (F4 T90): what the onboarding calls, in order, from
// the languages to the last class test. The harness plays the renderer and issues exactly this;
// the onboarding controller (T96) imports the same fixture and its test asserts that the calls it
// makes equal it, so the end-to-end proof and the screen cannot drift apart.
//
// Steps (decision 31): (1) the languages; (2) the AI mode, Hybrid: the writer first (the sign-in,
// then its provider and profile), then the two models (the embedder is asked for here; the ranker
// follows on its own once the embedding route exists, decision 19), then the preset, then one test
// per class that has a route; (3) the first source, which is the user phase of the run and is not
// part of this sequence.
import type { AiClassRouteTarget } from "../../../shared/ipc.js";
import { ipcChannels } from "../../../shared/ipc.js";

export type SetupStepId = "languages" | "writer" | "models" | "preset" | "tests";

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
    { step: "languages", channel: ipcChannels.appSettingsUpdate },
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
    { step: "models", channel: ipcChannels.localModelsList },
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
