import { renderToStaticMarkup } from "react-dom/server";
import { defaultKnowledgeControls } from "@app/domain";
import { createTranslator } from "@app/i18n";
import { describe, expect, it } from "vitest";

import { appSettingsSchema, defaultAppSettings, defaultStorageSettings } from "../../../shared/ipc";
import {
  knowledgeControlDomIds,
  settingsRegistry,
  settingsScopeIds,
  visibleAutomationSettings,
  type SettingsScope
} from "../../../shared/settings-registry";
import { SettingsScopeMenu, SettingsView } from "../SettingsView";
import { KnowledgeControlsView } from "./KnowledgeControls";

// The registry against the screens (F4 T98, E7): every control a row names is rendered by the scope
// it names, inside an Advanced disclosure exactly when the row is placed in `advanced`; and the
// automation controls outside every disclosure are the six Knowledge controls, on the screen.
const t = createTranslator("en");
const appSettings = appSettingsSchema.parse({
  ...defaultAppSettings,
  language: "en",
  updatedAt: new Date(0).toISOString()
});
const storage = { ...defaultStorageSettings, updatedAt: appSettings.updatedAt };

function renderScope(scope: SettingsScope): string {
  const view = renderToStaticMarkup(
    <SettingsView
      activeScope={scope}
      appSettings={appSettings}
      settings={storage}
      isSaving={false}
      t={t}
      onAppSettingsChange={() => undefined}
      onChange={() => undefined}
      onSelectObsidianVault={async () => undefined}
      onScopeChange={() => undefined}
      onToast={() => undefined}
    />
  );
  // The Knowledge controls load their values first: show them as loaded.
  return scope === "knowledge"
    ? renderToStaticMarkup(
        <KnowledgeControlsView
          t={t}
          state={{
            phase: "ready",
            saved: defaultKnowledgeControls,
            shown: defaultKnowledgeControls,
            saving: 0,
            outcome: "idle"
          }}
          spend={null}
          onEdit={() => undefined}
          onRetry={() => undefined}
        />
      ) + view
    : view;
}

/** Every `id` of the markup with how many `<details>` disclosures it sits inside. */
function disclosureDepths(html: string): Map<string, number> {
  const depths = new Map<string, number>();
  let depth = 0;
  for (const match of html.matchAll(/<details\b|<\/details>|<[a-z][^>]*?\sid="([^"]+)"/gu)) {
    if (match[0].startsWith("</details")) depth -= 1;
    else if (match[0].startsWith("<details")) {
      depth += 1;
      const id = /\sid="([^"]+)"/u.exec(match[0])?.[1];
      if (id) depths.set(id, depth);
    } else if (match[1]) depths.set(match[1], depth);
  }
  return depths;
}

describe("the Settings scopes against the settings registry", () => {
  const scopes = [
    ...new Set(settingsRegistry.flatMap((entry) => (entry.scope ? [entry.scope] : [])))
  ];
  const rendered = new Map(scopes.map((scope) => [scope, disclosureDepths(renderScope(scope))]));

  it("renders every control a row names in the scope the row names", () => {
    for (const entry of settingsRegistry) {
      if (!entry.control || !entry.scope) continue;
      expect(rendered.get(entry.scope)?.has(entry.control), `${entry.id} → ${entry.control}`).toBe(
        true
      );
    }
  });

  it("puts a control inside an Advanced disclosure exactly when its row is placed in advanced", () => {
    for (const entry of settingsRegistry) {
      if (!entry.control || !entry.scope) continue;
      const depth = rendered.get(entry.scope)?.get(entry.control);
      if (entry.placement === "advanced") expect(depth, entry.id).toBeGreaterThan(0);
      else expect(depth, entry.id).toBe(0);
    }
  });

  it("shows exactly six automation controls outside every disclosure: the Knowledge controls", () => {
    const outside = settingsRegistry
      .filter(
        (entry) =>
          entry.category === "automation" &&
          entry.control &&
          entry.scope &&
          rendered.get(entry.scope)?.get(entry.control) === 0
      )
      .map((entry) => entry.control)
      .sort();
    expect(outside).toEqual(Object.values(knowledgeControlDomIds).sort());
    expect(outside.length).toBeLessThanOrEqual(6);
    expect(visibleAutomationSettings()).toHaveLength(6);
  });

  it("keeps the six Knowledge controls ahead of the Advanced disclosure", () => {
    const html = renderScope("knowledge");
    const advanced = html.indexOf("<details");
    for (const id of Object.values(knowledgeControlDomIds))
      expect(html.indexOf(`id="${id}"`), id).toBeLessThan(advanced);
  });

  it("offers Knowledge in the navigation instead of Matching", () => {
    const html = renderToStaticMarkup(
      <SettingsScopeMenu activeScope="knowledge" t={t} onScopeChange={() => undefined} />
    );
    expect(html).toContain('id="settings-tab-knowledge"');
    expect(html).not.toContain("settings-tab-matching");
    expect(html).toContain("Automatic organizing and its limits");
    expect(settingsScopeIds).toContain("knowledge");
  });

  it("lets Obsidian sync be off, on or paused in one control, and the lookup be one choice", () => {
    const connections = renderScope("connections");
    expect(connections).toContain('id="obsidianSyncMode"');
    expect(connections).not.toContain("Delete policy");
    expect(connections).not.toContain("Tombstone");
    for (const label of ["Off", "On", "Paused"])
      expect(connections).toContain(`>${label}</option>`);
    const services = renderScope("external-services");
    expect(services).toContain('id="bookMetadataProvider"');
    expect(services.match(/<select/g)).toHaveLength(1);
    for (const label of ["Off", "Open Library", "Google Books"])
      expect(services).toContain(`>${label}</option>`);
  });
});
