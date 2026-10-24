import type { IpcMain } from "electron";
import {
  OnboardingFinishInputSchema,
  OnboardingStateSchema,
  type OnboardingOutcome,
  type OnboardingState
} from "@app/domain";
import { z } from "zod";

import { ipcChannels } from "../../../shared/ipc.js";

/** No argument: what the preload sends, and what a harness that plays it sends with `undefined`. */
const noArguments = z.union([z.tuple([]), z.tuple([z.undefined()])]);

/**
 * `onboarding.state` and `onboarding.finish` (F4 D31, spec 3.11): the first run's stored state. The
 * renderer reads the state when it starts and writes it once, when the three steps are finished or
 * skipped. Requests and answers are validated at the boundary.
 */
export function registerOnboardingIpc(
  ipc: Pick<IpcMain, "handle">,
  service: {
    state(): Promise<OnboardingState>;
    finish(outcome: OnboardingOutcome): Promise<OnboardingState>;
  }
): void {
  ipc.handle(
    ipcChannels.onboardingState,
    async (_event, ...args: unknown[]): Promise<OnboardingState> => {
      noArguments.parse(args);
      return OnboardingStateSchema.parse(await service.state());
    }
  );
  ipc.handle(
    ipcChannels.onboardingFinish,
    async (_event, input: unknown): Promise<OnboardingState> =>
      OnboardingStateSchema.parse(
        await service.finish(OnboardingFinishInputSchema.parse(input).outcome)
      )
  );
}
