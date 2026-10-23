import { describe, expect, it } from "vitest";

import { formatObjectAddress } from "../../object-address.js";
import { AuditLintConfigSchema, auditLintConfigWith, defaultAuditLintConfig } from "./config.js";
import { duplicateFindings, duplicateFingerprint, pairHolds } from "./duplicates.js";
import { GardenerFindingInputSchema, orderedPair } from "./finding.js";
import {
  addressTargets,
  brokenLinkFindings,
  redirectFindings,
  redirectReport,
  resolveRedirect,
  topicAddressResolution
} from "./links.js";
import type { RedirectNode } from "./links.js";
import { staleEmbeddings } from "./stale-embeddings.js";

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const config = defaultAuditLintConfig;

describe("the lint configuration", () => {
  it("starts at the D19 values and refuses unknown keys and values out of range", () => {
    expect(config.duplicates).toMatchObject({ cosine: 0.97, neighbours: 3 });
    expect(config.replacement.share).toBe(0.01);
    expect(config.themeDrift.cosine).toBe(0.55);
    expect(() => AuditLintConfigSchema.parse({ duplicates: { cosine: 1.5 } })).toThrow();
    expect(() => AuditLintConfigSchema.parse({ themeDrift: { guess: 1 } })).toThrow();
    expect(auditLintConfigWith({ duplicates: { cosine: 0.9 } }).duplicates.cosine).toBe(0.9);
    expect(auditLintConfigWith({}).duplicates.cosine).toBe(0.97);
  });
});

describe("duplicate notes", () => {
  it("finds a pair at the cosine threshold from either side as one finding", () => {
    const result = duplicateFindings(
      {
        neighbours: [
          { noteId: id(2), otherId: id(1), cosine: 0.975 },
          { noteId: id(1), otherId: id(2), cosine: 0.9731 },
          { noteId: id(1), otherId: id(3), cosine: 0.96 }
        ],
        titleGroups: []
      },
      config
    );
    expect(result.pairs).toEqual([{ notes: [id(1), id(2)], cosine: 0.975, reason: "vector" }]);
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding).toMatchObject({
      kind: "duplicate",
      fingerprint: duplicateFingerprint(id(2), id(1)),
      risk: "low",
      objectRefs: [
        formatObjectAddress({ kind: "note", id: id(1) }),
        formatObjectAddress({ kind: "note", id: id(2) })
      ],
      params: { reason: "vector", cosine: 0.975 }
    });
    expect(GardenerFindingInputSchema.parse(finding)).toEqual(finding);
  });

  it("looks at the nearest neighbours only", () => {
    const neighbours = [
      { noteId: id(1), otherId: id(2), cosine: 0.99 },
      { noteId: id(1), otherId: id(3), cosine: 0.985 },
      { noteId: id(1), otherId: id(4), cosine: 0.98 },
      { noteId: id(1), otherId: id(5), cosine: 0.975 }
    ];
    const result = duplicateFindings({ neighbours, titleGroups: [] }, config);
    expect(result.pairs.map((pair) => pair.notes[1])).toEqual([id(2), id(3), id(4)]);
    const wide = duplicateFindings(
      { neighbours, titleGroups: [] },
      auditLintConfigWith({ duplicates: { neighbours: 4 } })
    );
    expect(wide.pairs).toHaveLength(4);
  });

  it("finds notes that share a normalized title, and says both when the vectors agree", () => {
    const result = duplicateFindings(
      {
        neighbours: [{ noteId: id(1), otherId: id(2), cosine: 0.98 }],
        titleGroups: [[id(2), id(1)], [id(7), id(8), id(9)], [id(5)]]
      },
      config
    );
    expect(result.pairs).toEqual([
      { notes: [id(1), id(2)], cosine: 0.98, reason: "both" },
      { notes: [id(7), id(8)], cosine: null, reason: "title" },
      { notes: [id(7), id(9)], cosine: null, reason: "title" },
      { notes: [id(8), id(9)], cosine: null, reason: "title" }
    ]);
    expect(result.findings.map((finding) => finding.params.reason)).toEqual([
      "both",
      "title",
      "title",
      "title"
    ]);
  });

  it("leaves out a title too many notes share, and a neighbour below the threshold", () => {
    const crowd = Array.from({ length: 7 }, (_, index) => id(100 + index));
    const result = duplicateFindings(
      {
        neighbours: [{ noteId: id(1), otherId: id(2), cosine: 0.9699 }],
        titleGroups: [crowd]
      },
      config
    );
    expect(result.pairs).toEqual([]);
    expect(result.genericTitleGroups).toBe(1);
    expect(
      duplicateFindings(
        { neighbours: [], titleGroups: [crowd] },
        auditLintConfigWith({ duplicates: { titleGroupMax: 7 } })
      ).pairs
    ).toHaveLength(21);
  });

  it("ignores a note listed as its own neighbour and is deterministic in the input order", () => {
    const neighbours = [
      { noteId: id(1), otherId: id(1), cosine: 1 },
      { noteId: id(3), otherId: id(4), cosine: 0.99 },
      { noteId: id(1), otherId: id(2), cosine: 0.98 }
    ];
    const forward = duplicateFindings({ neighbours, titleGroups: [] }, config);
    const backward = duplicateFindings(
      { neighbours: [...neighbours].reverse(), titleGroups: [] },
      config
    );
    expect(forward).toEqual(backward);
    expect(forward.pairs.map((pair) => pair.notes)).toEqual([
      [id(1), id(2)],
      [id(3), id(4)]
    ]);
  });

  it("revalidates a pair from fresh evidence", () => {
    expect(pairHolds({ cosine: 0.971, sameTitle: false }, config)).toBe(true);
    expect(pairHolds({ cosine: 0.9, sameTitle: false }, config)).toBe(false);
    expect(pairHolds({ cosine: null, sameTitle: false }, config)).toBe(false);
    expect(pairHolds({ cosine: 0.2, sameTitle: true }, config)).toBe(true);
    expect(orderedPair("B", "a")).toEqual(["a", "b"]);
  });
});

describe("redirect chains", () => {
  const nodes = (entries: Record<string, RedirectNode>): Map<string, RedirectNode> =>
    new Map(Object.entries(entries));
  const live: RedirectNode = { retired: false, redirectTo: null };
  const retired = (to: string | null): RedirectNode => ({ retired: true, redirectTo: to });

  it("follows redirects to a live topic and counts the hops", () => {
    const map = nodes({ a: retired("b"), b: retired("c"), c: live });
    expect(resolveRedirect(map, "c", 64)).toEqual({ kind: "live", end: "c", hops: 0 });
    expect(resolveRedirect(map, "b", 64)).toEqual({ kind: "live", end: "c", hops: 1 });
    expect(resolveRedirect(map, "a", 64)).toEqual({ kind: "live", end: "c", hops: 2 });
    expect(resolveRedirect(map, "zzz", 64)).toEqual({ kind: "unknown" });
  });

  it("tells a dead end, a cycle and a missing target apart", () => {
    const map = nodes({
      gone: retired(null),
      viaGone: retired("gone"),
      x: retired("y"),
      y: retired("x"),
      dangling: retired("nowhere")
    });
    expect(resolveRedirect(map, "viaGone", 64)).toEqual({ kind: "dead_end", at: "gone", hops: 1 });
    expect(resolveRedirect(map, "x", 64)).toMatchObject({ kind: "cycle" });
    expect(resolveRedirect(map, "dangling", 64)).toEqual({
      kind: "missing",
      at: "nowhere",
      hops: 1
    });
    // A chain longer than the bound is called a cycle rather than followed for ever.
    const long = nodes({ a: retired("b"), b: retired("c"), c: retired("d"), d: live });
    expect(resolveRedirect(long, "a", 2)).toMatchObject({ kind: "cycle" });
    expect(resolveRedirect(long, "a", 3)).toMatchObject({ kind: "live", end: "d" });
  });

  it("lists the chains to compress and the redirects that cannot be fixed", () => {
    const map = nodes({
      live1: live,
      a: retired("b"),
      b: retired("c"),
      c: retired("live1"),
      direct: retired("live1"),
      gone: retired(null),
      [id(24)]: retired(id(25)),
      [id(25)]: retired(id(24))
    });
    const report = redirectReport(map, 64);
    expect(report.chains).toEqual([
      { topicId: "a", from: "b", to: "live1", hops: 3 },
      { topicId: "b", from: "c", to: "live1", hops: 2 }
    ]);
    expect(report.direct).toBe(2);
    expect(report.deadEnds).toBe(1);
    expect(report.unresolved.map((entry) => entry.topicId)).toEqual([id(24), id(25)]);
    expect(redirectFindings(report)).toEqual([
      expect.objectContaining({
        kind: "redirect_chain",
        fingerprint: `redirect:${id(24)}`,
        objectRefs: [formatObjectAddress({ kind: "topic", id: id(24) })],
        params: { reason: "cycle", hops: expect.any(Number) },
        risk: "medium"
      }),
      expect.objectContaining({ fingerprint: `redirect:${id(25)}` })
    ]);
    for (const finding of redirectFindings(report)) {
      expect(GardenerFindingInputSchema.parse(finding)).toEqual(finding);
    }
  });
});

describe("broken links", () => {
  it("keeps the distinct well-formed addresses in canonical form", () => {
    const upper = formatObjectAddress({ kind: "note", id: id(1) }).toUpperCase();
    const targets = addressTargets([
      { address: formatObjectAddress({ kind: "topic", id: id(2) }), role: "entry" },
      { address: formatObjectAddress({ kind: "note", id: id(1) }), role: "entry" },
      { address: formatObjectAddress({ kind: "note", id: id(1) }), role: "parent" },
      { address: "memora://note/not-an-id", role: "entry" },
      { address: "https://example.com", role: "entry" }
    ]);
    expect(targets.map((target) => target.address)).toEqual([
      formatObjectAddress({ kind: "note", id: id(1) }),
      formatObjectAddress({ kind: "topic", id: id(2) })
    ]);
    expect(upper).not.toBe(targets[0]?.address);
  });

  it("resolves a topic address through its redirects", () => {
    const map = new Map<string, RedirectNode>([
      ["live", { retired: false, redirectTo: null }],
      ["old", { retired: true, redirectTo: "live" }],
      ["end", { retired: true, redirectTo: null }]
    ]);
    expect(topicAddressResolution(map, "live", 64)).toBe("ok");
    expect(topicAddressResolution(map, "old", 64)).toBe("ok");
    expect(topicAddressResolution(map, "end", 64)).toBe("no_successor");
    expect(topicAddressResolution(map, "nope", 64)).toBe("missing");
  });

  it("makes a finding for each address that no longer resolves", () => {
    const targets = addressTargets([
      { address: formatObjectAddress({ kind: "note", id: id(1) }), role: "entry" },
      { address: formatObjectAddress({ kind: "topic", id: id(2) }), role: "entry" },
      { address: formatObjectAddress({ kind: "question", id: id(3) }), role: "entry" }
    ]);
    const note = formatObjectAddress({ kind: "note", id: id(1) });
    const topic = formatObjectAddress({ kind: "topic", id: id(2) });
    const findings = brokenLinkFindings(
      targets,
      new Map([
        [note, "missing"],
        [topic, "no_successor"]
      ])
    );
    expect(findings).toEqual([
      {
        kind: "broken_link",
        fingerprint: `link:${note}`,
        objectRefs: [note],
        params: { kind: "note", reason: "missing" },
        risk: "low"
      },
      {
        kind: "broken_link",
        fingerprint: `link:${topic}`,
        objectRefs: [topic],
        params: { kind: "topic", reason: "no_successor" },
        risk: "low"
      }
    ]);
    for (const finding of findings)
      expect(GardenerFindingInputSchema.parse(finding)).toEqual(finding);
  });
});

describe("stale embeddings", () => {
  it("separates a missing vector from one built on other text, and ignores a current one", () => {
    const result = staleEmbeddings(
      [
        { noteId: id(3), expectedHash: "h3", storedHash: "h3" },
        { noteId: id(2), expectedHash: "h2", storedHash: "old" },
        { noteId: id(1), expectedHash: "h1", storedHash: null }
      ],
      config
    );
    expect(result.stale).toEqual([
      { noteId: id(1), reason: "missing" },
      { noteId: id(2), reason: "content" }
    ]);
    expect(result).toMatchObject({ missing: 1, content: 1, deferred: 0 });
  });

  it("caps one audit's re-embeddings and counts what waits", () => {
    const facts = Array.from({ length: 5 }, (_, index) => ({
      noteId: id(index + 1),
      expectedHash: "new",
      storedHash: "old"
    }));
    const result = staleEmbeddings(facts, auditLintConfigWith({ staleEmbeddings: { perRun: 2 } }));
    expect(result.stale.map((entry) => entry.noteId)).toEqual([id(1), id(2)]);
    expect(result.deferred).toBe(3);
    expect(
      staleEmbeddings(facts, auditLintConfigWith({ staleEmbeddings: { perRun: 0 } })).stale
    ).toEqual([]);
  });
});
