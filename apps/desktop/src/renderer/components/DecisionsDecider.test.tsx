import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createTranslator,
  supportedLanguageCodes,
  type LanguageCode,
  type MessageKey
} from "@app/i18n";
import { decisionsFallbackReasons } from "@app/domain";

import type { AiDecisionsStatus } from "../../shared/ipc";
import {
  createDecisionsActions,
  decisionsErrorKey,
  decisionsStatusLine,
  DecisionsDeciderView,
  formatUsd,
  type DecisionsApi,
  type DecisionsDeciderViewProps
} from "./DecisionsDecider";

const visible = (html: string) => html.replaceAll("<!-- -->", "");
/** Money keeps its number and symbol together with a no-break space; compare with plain spaces. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/gu, " ");

const status = (overrides: Partial<AiDecisionsStatus> = {}): AiDecisionsStatus => ({
  state: "off",
  enabled: false,
  presetAllowed: true,
  keyStored: false,
  keyInvalid: false,
  fallbackReason: null,
  model: "gpt-6-luna",
  priceInputPerMillionUsd: 0.1,
  bodyCharacters: 600,
  spentTodayUsd: 0,
  dailyCapUsd: 0.5,
  requestsToday: 0,
  calibrated: false,
  lastUsedAt: null,
  ...overrides
});

function view(
  locale: LanguageCode,
  current: AiDecisionsStatus,
  overrides: Partial<DecisionsDeciderViewProps> = {}
) {
  return visible(
    renderToString(
      <DecisionsDeciderView
        t={createTranslator(locale)}
        interfaceLanguage={locale}
        status={current}
        busy={false}
        confirming={false}
        keyDraft=""
        onKeyDraft={() => {}}
        onAskEnable={() => {}}
        onConfirmEnable={() => {}}
        onCancelEnable={() => {}}
        onDisable={() => {}}
        onSaveKey={() => {}}
        onRemoveKey={() => {}}
        onTestKey={() => {}}
        {...overrides}
      />
    )
  );
}

describe("Settings > AI: the OpenAI Decisions decider", () => {
  it("is off by default and says what leaves the device before it is turned on", () => {
    const html = view("en", status());
    expect(html).toContain("OpenAI Decisions (optional)");
    expect(html).toContain('role="note"');
    expect(html).toContain("Your note text is sent to OpenAI");
    expect(html).toContain("the first 600 characters of the text of each note");
    expect(html).toContain("model gpt-6-luna");
    expect(html).toContain("up to 30 days");
    expect(html).toContain("Nothing is sent while this is off");
    expect(plain(html)).toContain("about $0.10 per million input tokens");
    expect(plain(html)).toContain("at $0.50, and the local ranker takes over");
    expect(html).toContain("Off. The local ranker decides note relations.");
    expect(html).toContain("Turn on…");
    expect(html).not.toContain("Turn off");
  });

  it("is not offered in the Local setup: only the notice and why", () => {
    const html = view("en", status({ state: "unavailable_preset", presetAllowed: false }));
    expect(html).toContain("Not available in this setup");
    expect(html).toContain("never sends note text out");
    expect(html).not.toContain("Turn on…");
    expect(html).not.toContain('type="password"');
  });

  it("asks for a confirmation, after the notice, before it turns on", () => {
    const html = view("en", status(), { confirming: true });
    expect(html).toContain("Send note text to OpenAI?");
    expect(html).toContain(">Turn on<");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Turn on…");
  });

  it("takes the key in a password field and never shows one back", () => {
    const html = view("en", status({ keyStored: true, enabled: true, state: "ready" }), {
      keyDraft: ""
    });
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain("A key is saved.");
    expect(html).toContain("Test key");
    expect(html).toContain("Remove key");
    // The test sends a request, so it is offered only while the decider is on.
    const off = view("en", status({ keyStored: true }), { keyDraft: "" });
    expect(off).toContain("Remove key");
    expect(off).not.toContain("Test key");
    expect(html).not.toMatch(/sk-[A-Za-z0-9]{6}/u);
    // Saving needs a key of a sensible length and an idle card.
    const typed = view("en", status(), { keyDraft: "sk-proj-0123456789abcdef" });
    expect(typed).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<svg[^>]*><\/svg>Save key/u);
    expect(view("en", status(), { keyDraft: "short" })).toMatch(
      /<button[^>]*disabled=""[^>]*>(<svg[^>]*>.*?<\/svg>)?Save key/u
    );
    const none = view("en", status());
    expect(none).toContain("No key is saved.");
    expect(none).not.toContain("Test key");
  });

  it("says why the local ranker decides, and when the key was refused", () => {
    const fallback = view(
      "en",
      status({ state: "fallback", enabled: true, fallbackReason: "spend_cap", keyStored: true })
    );
    expect(fallback).toContain(
      "On, but the local ranker is deciding: today&#x27;s spending limit was reached."
    );
    expect(fallback).toContain("Turn off");
    const refused = view(
      "en",
      status({
        state: "fallback",
        enabled: true,
        fallbackReason: "invalid_key",
        keyStored: true,
        keyInvalid: true
      })
    );
    expect(refused).toContain("OpenAI refused the saved key. Save a valid one.");
    expect(refused).toContain('role="alert"');
  });

  it("shows what it spent today, and whether its relations apply or only suggest", () => {
    const ready = view(
      "en",
      status({
        state: "ready",
        enabled: true,
        keyStored: true,
        spentTodayUsd: 0.0123,
        requestsToday: 41,
        calibrated: true
      })
    );
    expect(ready).toContain("On. OpenAI Decisions decides note relations.");
    expect(plain(ready)).toContain("Spent today: $0.01 of $0.50 (41 requests).");
    expect(ready).toContain("applied automatically");
    expect(
      view("en", status({ state: "ready", enabled: true })).includes("not calibrated yet")
    ).toBe(true);
    // After a failed request the card is still on, and remembers why the local ranker decided.
    expect(
      decisionsStatusLine(
        createTranslator("en"),
        status({ state: "ready", enabled: true, fallbackReason: "network" })
      )
    ).toBe(
      "On. OpenAI Decisions decides note relations. The last time, the local ranker decided instead: OpenAI could not be reached."
    );
  });

  it("writes the price, the cap and the spend in the interface language", () => {
    const spent = status({ spentTodayUsd: 0.0123, requestsToday: 41 });
    const portuguese = plain(view("pt-BR", spent));
    expect(portuguese).toContain("Custa cerca de US$ 0,10 por milhão de tokens");
    expect(portuguese).toContain("ao chegar a US$ 0,50, e o ranqueador");
    expect(portuguese).toContain("Gasto hoje: US$ 0,01 de US$ 0,50 (41 requisições).");
    expect(portuguese).not.toMatch(/US\$ \d+\.\d/u);
    // French puts the symbol after the number.
    const french = plain(view("fr", spent));
    expect(french).toContain("Il coûte environ 0,10 $US par million de jetons");
    expect(french).toContain("à 0,50 $US, et le classeur local");
    expect(french).toMatch(/aujourd(?:'|&#x27;)hui : 0,01 \$US sur 0,50 \$US \(41 requêtes\)\./u);
    // Without the language the card writes English, as the rest of the Settings view does.
    const unspecified = plain(
      visible(
        renderToString(
          <DecisionsDeciderView
            t={createTranslator("en")}
            status={spent}
            busy={false}
            confirming={false}
            keyDraft=""
            onKeyDraft={() => {}}
            onAskEnable={() => {}}
            onConfirmEnable={() => {}}
            onCancelEnable={() => {}}
            onDisable={() => {}}
            onSaveKey={() => {}}
            onRemoveKey={() => {}}
            onTestKey={() => {}}
          />
        )
      )
    );
    expect(unspecified).toContain("about $0.10 per million");
    expect(unspecified).toContain("Spent today: $0.01 of $0.50 (41 requests).");
  });

  it.each([
    ["en", "$0.50", "$0.10", "$0.0012"],
    ["pt-BR", "US$ 0,50", "US$ 0,10", "US$ 0,0012"],
    ["it", "0,50 USD", "0,10 USD", "0,0012 USD"],
    ["fr", "0,50 $US", "0,10 $US", "0,0012 $US"],
    ["es", "0,50 US$", "0,10 US$", "0,0012 US$"]
  ] as const)(
    "formats US dollars in %s: cents, four decimals under a cent, the price with cents",
    (locale, cap, price, tiny) => {
      expect(plain(formatUsd(locale, 0.5))).toBe(cap);
      expect(plain(formatUsd(locale, 0.1, "price"))).toBe(price);
      expect(plain(formatUsd(locale, 0.0012))).toBe(tiny);
    }
  );

  it("keeps the precision rules: cents from one cent, four decimals below it, a finer price intact", () => {
    expect(plain(formatUsd("en", 0.01))).toBe("$0.01");
    expect(plain(formatUsd("en", 0.0099))).toBe("$0.0099");
    expect(plain(formatUsd("en", 0))).toBe("$0.0000");
    expect(plain(formatUsd("en", 12.345))).toBe("$12.35");
    expect(plain(formatUsd("pt-BR", 1234.5))).toBe("US$ 1.234,50");
    expect(plain(formatUsd("en", 0.075, "price"))).toBe("$0.075");
    expect(plain(formatUsd("en", 2, "price"))).toBe("$2.00");
  });

  it.each(supportedLanguageCodes)(
    "has every line in %s: the notice, the states, the reasons and the key flow",
    (locale) => {
      const t = createTranslator(locale);
      const html = view(locale, status({ keyStored: true }), { confirming: false });
      expect(html).not.toContain("[[missing");
      // The notice names OpenAI, the 30 days and the model, with no placeholder left over.
      const notice = html.slice(html.indexOf('role="note"')).split("</div>")[0]!;
      expect(notice).toContain("OpenAI");
      expect(notice).toContain("30");
      expect(notice).toContain("gpt-6-luna");
      expect(notice).toContain("600");
      // The length follows the setting the request is built with, not a number of the renderer.
      expect(
        view(locale, status({ keyStored: true, bodyCharacters: 450 }), { confirming: false })
      ).toContain("450");
      expect(notice).not.toMatch(/\{[a-z]+\}/u);
      for (const state of ["off", "unavailable_preset", "ready", "fallback"] as const)
        for (const reason of [null, ...decisionsFallbackReasons])
          expect(
            decisionsStatusLine(t, status({ state, enabled: true, fallbackReason: reason })),
            `${locale} ${state} ${reason}`
          ).not.toMatch(/\[\[missing|\{[a-z]+\}/u);
      const confirm = view(locale, status(), { confirming: true });
      expect(confirm).not.toContain("[[missing");
      for (const key of [
        "settings.ai.decisions.toasts.keySaved",
        "settings.ai.decisions.toasts.keyRemoved",
        "settings.ai.decisions.toasts.keyWorks",
        "settings.ai.decisions.toasts.turnedOn",
        "settings.ai.decisions.toasts.turnedOff",
        "errors.relations.decisions.noKey",
        "errors.relations.decisions.invalidKey",
        "errors.relations.decisions.spendCap",
        "errors.relations.decisions.quota",
        "errors.relations.decisions.breakerOpen",
        "errors.relations.decisions.network",
        "errors.relations.decisions.failed",
        "errors.relations.decisions.keyFormat",
        "errors.relations.decisions.presetNotAllowed"
      ] as MessageKey[])
        expect(t(key), `${locale} ${key}`).not.toContain("[[missing");
    }
  );

  it("keeps the notice and the switch in every language apart from English", () => {
    for (const locale of supportedLanguageCodes.filter((code) => code !== "en")) {
      const t = createTranslator(locale);
      expect(t("settings.ai.decisions.privacy.title")).not.toBe(
        createTranslator("en")("settings.ai.decisions.privacy.title")
      );
      expect(t("settings.ai.decisions.toggle.turnOn")).not.toBe("Turn on…");
    }
  });
});

describe("the key flow", () => {
  function setup(overrides: Partial<DecisionsApi> = {}) {
    const calls: string[] = [];
    const api: DecisionsApi = {
      decisionsStatus: vi.fn(async () => status({ keyStored: true })),
      setDecisionsEnabled: vi.fn(async (enabled: boolean) =>
        status({ enabled, state: enabled ? "ready" : "off", keyStored: true })
      ),
      saveDecisionsKey: vi.fn(async () => status({ keyStored: true })),
      removeDecisionsKey: vi.fn(async () => status()),
      testDecisionsKey: vi.fn(async () => status({ keyStored: true })),
      ...overrides
    };
    const seen = {
      statuses: [] as AiDecisionsStatus[],
      toasts: [] as Array<[string, string]>,
      busy: [] as boolean[],
      drafts: [] as string[],
      confirming: [] as boolean[]
    };
    const actions = createDecisionsActions({
      api,
      onStatus: (next) => seen.statuses.push(next),
      onToast: (message, tone) => seen.toasts.push([message, tone]),
      onBusy: (busy) => seen.busy.push(busy),
      onKeyDraft: (value) => {
        calls.push("draft");
        seen.drafts.push(value);
      },
      onConfirming: (value) => seen.confirming.push(value)
    });
    return { api, actions, seen, calls };
  }

  it("sends the key once, clears the field first, and keeps only the status", async () => {
    const key = "sk-proj-0123456789abcdefghij";
    const { api, actions, seen } = setup();
    await actions.saveKey(`  ${key}  `);
    expect(api.saveDecisionsKey).toHaveBeenCalledOnce();
    expect(api.saveDecisionsKey).toHaveBeenCalledWith(key);
    expect(seen.drafts).toEqual([""]);
    expect(seen.toasts).toEqual([["settings.ai.decisions.toasts.keySaved", "success"]]);
    expect(seen.busy).toEqual([true, false]);
    // Nothing the interface keeps holds the key.
    expect(JSON.stringify(seen)).not.toContain("0123456789abcdefghij");
  });

  it("turns on only after the confirmation, and off at once", async () => {
    const { api, actions, seen } = setup();
    await actions.enable();
    expect(seen.confirming).toEqual([false]);
    expect(api.setDecisionsEnabled).toHaveBeenCalledWith(true);
    await actions.disable();
    expect(api.setDecisionsEnabled).toHaveBeenLastCalledWith(false);
    expect(seen.toasts.map(([message]) => message)).toEqual([
      "settings.ai.decisions.toasts.turnedOn",
      "settings.ai.decisions.toasts.turnedOff"
    ]);
  });

  it("shows the localized reason of a refusal, then reads the status again", async () => {
    const { api, actions, seen } = setup({
      testDecisionsKey: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'app:ai:decisions:test-key': Error: errors.relations.decisions.invalidKey"
        );
      }),
      decisionsStatus: vi.fn(async () => status({ keyStored: true, keyInvalid: true }))
    });
    await actions.testKey();
    expect(seen.toasts).toEqual([["errors.relations.decisions.invalidKey", "error"]]);
    expect(api.decisionsStatus).toHaveBeenCalledOnce();
    expect(seen.statuses.at(-1)).toMatchObject({ keyInvalid: true });
    expect(seen.busy).toEqual([true, false]);
  });

  it("removes the key and reads a generic failure as the generic message", async () => {
    const { api, actions, seen } = setup();
    await actions.removeKey();
    expect(api.removeDecisionsKey).toHaveBeenCalledOnce();
    expect(seen.toasts[0]).toEqual(["settings.ai.decisions.toasts.keyRemoved", "success"]);
    expect(decisionsErrorKey(new Error("boom"))).toBe("errors.common.unknown");
    expect(decisionsErrorKey("boom")).toBe("errors.common.unknown");
    expect(decisionsErrorKey(new Error("x errors.relations.decisions.presetNotAllowed y"))).toBe(
      "errors.relations.decisions.presetNotAllowed"
    );
  });

  it.each(supportedLanguageCodes)(
    "has a message in %s for a decider that is off and for one the setup does not offer",
    (locale) => {
      const t = createTranslator(locale);
      // The two messages of `DecisionsDisabledError`, which the main process raises.
      const off = decisionsErrorKey(new Error("errors.relations.decisions.turnedOff"));
      const preset = decisionsErrorKey(new Error("errors.relations.decisions.presetNotAllowed"));
      for (const key of [off, preset]) {
        expect(t(key)).not.toMatch(/\[\[missing/u);
        expect(t(key)).not.toBe(key);
      }
      expect(t(off)).not.toBe(t(preset));
    }
  );
});
