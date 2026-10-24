import { readFileSync } from "node:fs";

import { sha256 } from "@app/conversion";
import {
  MatchingConfigurationSchema,
  matchingCalibrationDifferences,
  matchingValueControlIds,
  recommendedMatchingConfiguration,
  relationsConfig
} from "@app/domain";
import { describe, expect, it } from "vitest";

import { appSettingsSchema, defaultAppSettings } from "../../../shared/ipc";
import { parseSavedAppSettings } from "../settings-service.js";
import { sourceJudgeRequestSettings } from "../source-relation-processing.js";
import {
  matchValueHashes,
  matchValuesHistoryLimit,
  otherValueRanges,
  recordMatchValues,
  type MatchValueHashes
} from "./relation-match-values.js";

const judge = relationsConfig.sourceJudge;
const hashesOf = (changes: Record<string, unknown> = {}) =>
  matchValueHashes(
    MatchingConfigurationSchema.parse({ ...recommendedMatchingConfiguration, ...changes }),
    judge
  );
const t0 = new Date("2026-10-01T10:00:00Z");
const at = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);

describe("the values a stored decision was made under", () => {
  it("opens the history at the first sight, and records nothing for the same values", () => {
    const first = recordMatchValues(null, hashesOf(), t0);
    expect(first).toEqual({
      changed: false,
      history: { periods: [{ from: null, ...hashesOf() }] }
    });
    expect(recordMatchValues(first.history, hashesOf(), at(1))).toEqual({
      changed: false,
      history: first.history
    });
    // A history that does not parse starts over, as a first sight.
    expect(recordMatchValues({ periods: [] }, hashesOf(), at(1)).history.periods).toHaveLength(1);
    expect(recordMatchValues("damaged", hashesOf(), at(1)).changed).toBe(false);
  });

  it("opens a period at the moment a value that shapes a decision changed", () => {
    const history = recordMatchValues(null, hashesOf(), t0).history;
    const changed = recordMatchValues(
      history,
      hashesOf({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 } }),
      at(2)
    );
    expect(changed.changed).toBe(true);
    expect(changed.history.periods).toEqual([
      { from: null, ...hashesOf() },
      {
        from: at(2).toISOString(),
        ...hashesOf({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 } })
      }
    ]);
  });

  it("names the spans decided under other values, merging neighbours", () => {
    const a = hashesOf();
    const b = hashesOf({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 } });
    const periods = (...entries: Array<[number | null, MatchValueHashes]>) => ({
      periods: entries.map(([hours, hashes]) => ({
        from: hours === null ? null : at(hours).toISOString(),
        ...hashes
      }))
    });
    // A, then B from t+2, then A again from t+5: the span B was in force is the other one.
    expect(otherValueRanges(periods([null, a], [2, b], [5, a]), "note")).toEqual([
      { from: at(2), to: at(5) }
    ]);
    // B in force now: everything before t+2 was decided under A.
    expect(otherValueRanges(periods([null, a], [2, b]), "note")).toEqual([
      { from: null, to: at(2) }
    ]);
    // The pair values never moved, so no span is other for them.
    expect(otherValueRanges(periods([null, a], [2, b]), "pair")).toEqual([]);
    // A, B, C all unlike C: A and B merge into one span.
    const c = hashesOf({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 1024 } });
    expect(otherValueRanges(periods([null, a], [2, b], [4, c]), "note")).toEqual([
      { from: null, to: at(4) }
    ]);
    // Nothing is other while the values never changed.
    expect(otherValueRanges(periods([null, a]), "note")).toEqual([]);
  });

  it("keeps a bounded history: the oldest period absorbs what came before it", () => {
    let history = recordMatchValues(null, hashesOf(), t0).history;
    for (let step = 1; step <= matchValuesHistoryLimit + 4; step += 1)
      history = recordMatchValues(
        history,
        hashesOf({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 512 + step } }),
        at(step)
      ).history;
    expect(history.periods).toHaveLength(matchValuesHistoryLimit);
    expect(history.periods[0]!.from).toBeNull();
  });

  it("hashes the note value and the six request-shaping source values, and nothing else", () => {
    const calibrated = hashesOf();
    const changeOf = (changes: Record<string, unknown>) => hashesOf(changes);
    const source = (extra: Record<string, unknown>) => ({
      sourceRelationSettings: {
        ...recommendedMatchingConfiguration.sourceRelationSettings,
        ...extra
      }
    });
    expect(changeOf({ atomicNoteMatchingSettings: { maxRerankOutputTokens: 2048 } })).toEqual({
      note: expect.not.stringMatching(calibrated.note),
      pair: calibrated.pair
    });
    for (const extra of [
      { evidenceChunksPerSource: 3 },
      { evidenceMaxCharacters: 900 },
      { summaryMaxCharacters: 1100 },
      { maxOutputTokens: 2048 },
      { maxRelationsPerPair: 5 },
      { includeWeakTypes: true }
    ])
      expect(changeOf(source(extra)), JSON.stringify(extra)).toEqual({
        note: calibrated.note,
        pair: expect.not.stringMatching(calibrated.pair)
      });
    for (const extra of [{ minImportance: 0.5 }, { minConfidence: 0.5 }, { maxInputTokens: 30000 }])
      expect(changeOf(source(extra)), JSON.stringify(extra)).toEqual(calibrated);
    expect(
      changeOf({ relationTypeSimilarityThreshold: 0.5, entityIdentitySimilarityThreshold: 0.5 })
    ).toEqual(calibrated);
    expect(
      changeOf({
        canonicalMatchingSettings: {
          ...recommendedMatchingConfiguration.canonicalMatchingSettings,
          confirmationBatchSize: 6
        }
      })
    ).toEqual(calibrated);
  });
});

describe("behaviour-neutral at today's values (F4 D1, D33)", () => {
  // The judge's request part of the pair key, at the recommended values, as it was before the
  // matching controls moved to Advanced › Matching: the same keys in the same order.
  const frozenRequest = {
    evidenceChunksPerSource: 2,
    evidenceMaxCharacters: 800,
    summaryMaxCharacters: 1000,
    maxOutputTokens: 4096,
    maxRelationsPerPair: 4,
    includeWeakTypes: false,
    noteRelationsPerPair: 4,
    exactEvidencePairs: 10000,
    boundedEvidenceChunks: 16
  };
  const requestOf = (settings: Parameters<typeof sourceJudgeRequestSettings>[0]) =>
    JSON.stringify(sourceJudgeRequestSettings(settings, judge));

  it("gives byte-equal pair key inputs from the recommended set, the defaults and a stored document", () => {
    const expected = JSON.stringify(frozenRequest);
    expect(requestOf(recommendedMatchingConfiguration.sourceRelationSettings)).toBe(expected);
    expect(requestOf(defaultAppSettings.sourceRelationSettings)).toBe(expected);
    // A document stored before the move (the DEV profile's, with its retired members), read now.
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../../../../packages/domain/src/fixtures/app-settings-matching-before-v2.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { document: unknown };
    const stored = parseSavedAppSettings(fixture.document);
    expect(requestOf(stored.sourceRelationSettings)).toBe(expected);
    // The key's input as a hash recorded before the move: a change of it is a reviewed edit of this
    // test, never a side effect (a stored pair names the request it answered).
    expect(sha256(requestOf(defaultAppSettings.sourceRelationSettings))).toBe(
      "c8f61e95cb8aebdb563a0c08b47628792d9220aaf6a3d08e60c52e61ecf64fc3"
    );
  });

  it("starts a new library on exactly the calibrated set", () => {
    const configuration = MatchingConfigurationSchema.parse(defaultAppSettings);
    expect(configuration).toEqual(recommendedMatchingConfiguration);
    expect(matchingCalibrationDifferences(configuration)).toEqual([]);
    for (const id of matchingValueControlIds) expect(id).toBeTruthy();
    expect(defaultAppSettings.activeMatchingPresetId).toBe("recommended-v2");
    // And so does a stored document that has none of the matching members.
    const parsed = appSettingsSchema.parse({
      language: "en",
      themeMode: "system",
      updatedAt: new Date(0).toISOString()
    });
    expect(MatchingConfigurationSchema.parse(parsed)).toEqual(recommendedMatchingConfiguration);
  });

  it("reads the same hashes of the values for the recommended set, whatever the route to it", () => {
    const fromDefaults = matchValueHashes(
      MatchingConfigurationSchema.parse(defaultAppSettings),
      judge
    );
    expect(fromDefaults).toEqual(matchValueHashes(recommendedMatchingConfiguration, judge));
  });
});
