import type { ScreenModule } from "../../../workspace/surfaces";
import { SectionScreen, describeFixture } from "../general/section-screen";
import { section } from "./PrivacySection";

/** Privacy and data, inside the Settings surface. */
export const fullWindow = true;

export const surface = "settings-privacy";

const test = {
  state: "passed",
  model: "model",
  ms: 420,
  at: "2026-11-12T08:00:00.000Z",
  error: null
};
const local = (id: string) => ({
  id,
  profileId: "0b2a4a7e-5f6e-4c8b-9a3b-1c2d3e4f5a61",
  profileName: "Local",
  modelId: "local-model",
  runtime: "mlx",
  remote: false,
  test
});
const cloud = (id: string) => ({
  id,
  profileId: "1c3b5b8f-6a7f-4d9c-8b4c-2d3e4f5a6b72",
  profileName: "ChatGPT subscription",
  modelId: "gpt-5",
  runtime: "remote",
  remote: true,
  test
});

/**
 * A Hybrid setup: the search and the comparison run on this Mac, the writing and the answers in the
 * cloud, OpenAI Decisions is off and book details come from the internet.
 */
const routes = {
  preset: "hybrid",
  presets: [],
  classes: [
    local("embed"),
    { ...local("decide") },
    cloud("write-fast"),
    cloud("write-quality"),
    cloud("answer")
  ],
  judge: {
    profileId: "1c3b5b8f-6a7f-4d9c-8b4c-2d3e4f5a6b72",
    profileName: "ChatGPT subscription",
    modelId: "gpt-5",
    runtime: "remote",
    remote: true,
    providerName: "ChatGPT subscription",
    routed: true,
    deciderMode: null,
    test
  }
};

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "settings.describe": describeFixture({
      bookLookup: { value: "auto", default: "auto" },
      debugFullCapture: { value: false, default: false }
    }),
    "ai.classRoutes": routes,
    "ai.decisionsStatus": {
      state: "off",
      enabled: false,
      presetAllowed: true,
      keyStored: false,
      keyInvalid: false,
      fallbackReason: null,
      model: "gpt-5",
      priceInputPerMillionUsd: 1.25,
      bodyCharacters: 600,
      spentTodayUsd: 0,
      dailyCapUsd: 1,
      requestsToday: 0,
      calibrated: false,
      lastUsedAt: null
    },
    "ai.listProviders": [
      { displayName: "ChatGPT subscription", secretConfigured: true },
      { displayName: "OpenAI-compatible", secretConfigured: true }
    ],
    "settings.getGoogleBooksKeyStatus": { configured: false },
    "questions.list": {
      items: Array.from({ length: 38 }, (_, index) => ({ id: String(index) })),
      next: undefined
    },
    "monitoring.list": { rows: [], totals: { count: 1284, failed: 0, running: 0 } }
  },
  empty: { "settings.describe": { entries: [] } }
};

export function render() {
  return <SectionScreen surface={surface} section={section.id} />;
}
