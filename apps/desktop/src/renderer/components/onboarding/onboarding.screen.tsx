import { useEffect, useRef } from "react";
import { presetCatalogIds } from "@app/domain";

import { defaultAppSettings } from "../../../shared/ipc";
import type { ScreenModule } from "../../workspace/surfaces";
import { catalogRows } from "./onboarding-fixtures";
import { useFirstRun } from "./use-first-run";

export const surface = "onboarding";

const gib = 1024 ** 3;

/** What `hardware.profile` answers on an Apple silicon Mac (the tier card reads a subset of it). */
const macReading = (memoryBytes: number) => {
  const api = (monthlyUsd: number) => ({ kind: "api", monthlyUsd });
  return {
    profile: {
      platform: "darwin",
      nativeArch: "arm64",
      translated: false,
      cpu: { brand: "Apple M4 Max" },
      memoryBytes,
      workingSet: { bytes: memoryBytes * 0.75 }
    },
    recommendation: {
      recommended: "hybrid",
      local: {
        offer: "available",
        unavailableReason: null,
        writerCatalogId: presetCatalogIds.writerLarge
      },
      costs: {
        local: { routes: [{ kind: "local", monthlyUsd: 0 }] },
        hybrid: { routes: [api(0.39)] },
        cloud: { routes: [api(0.44)] }
      }
    }
  };
};

/** A PC without a local writer: the tier card offers the cloud setups only, and no model is installed. */
const windowsReading = {
  profile: {
    platform: "win32",
    nativeArch: "x64",
    translated: false,
    cpu: { brand: null },
    memoryBytes: 16 * gib,
    workingSet: null
  },
  recommendation: {
    recommended: "hybrid",
    local: {
      offer: "unavailable",
      unavailableReason: "no_local_writer_for_platform",
      writerCatalogId: null
    },
    costs: {
      local: { routes: [{ kind: "local", monthlyUsd: 0 }] },
      hybrid: { routes: [{ kind: "api", monthlyUsd: 0.39 }] },
      cloud: { routes: [{ kind: "api", monthlyUsd: 0.44 }] }
    }
  }
};

const due = { outcome: null, at: null, libraryEmpty: true, show: true };
const saved = (update: object) => ({
  ...defaultAppSettings,
  ...update,
  updatedAt: new Date(0).toISOString()
});

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "onboarding.state": due,
    "settings.updateApp": saved,
    "hardware.profile": macReading(48 * gib),
    "localModels.list": catalogRows,
    "localModels.download": null
  },
  empty: {
    "onboarding.state": due,
    "settings.updateApp": saved,
    "hardware.profile": windowsReading,
    "localModels.list": []
  }
};

/**
 * The first run takes the place of the shell while it is due, and nothing when the question about
 * it fails (a failed question never hides the app). That second answer is this surface's error
 * state, so the host says so with `data-screen-passthrough`, which the screens check accepts for
 * error. The first step is passed through, as a click on Continue would, so the screen shows the
 * AI mode step with the tier card, where the loads and failures of this surface are.
 */
function FirstRun() {
  const host = useRef<HTMLDivElement>(null);
  const advanced = useRef(false);
  const node = useFirstRun({
    enabled: true,
    language: "en",
    contentLanguage: "en",
    dark: false,
    metadataEnrichmentEnabled: false,
    onSettings: () => undefined,
    onOpenSource: () => undefined
  });
  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const advance = () => {
      const submit = element.querySelector<HTMLButtonElement>("form button[type='submit']");
      if (!submit || advanced.current) return;
      advanced.current = true;
      submit.click();
    };
    advance();
    const observer = new MutationObserver(advance);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={host} className="h-full">
      {node ?? <div data-screen-passthrough="">{null}</div>}
    </div>
  );
}

export function render() {
  return <FirstRun />;
}
