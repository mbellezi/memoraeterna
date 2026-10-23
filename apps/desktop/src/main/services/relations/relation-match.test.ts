import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, PgPool } from "@app/db";
import { gardenerResultOf, relationsConfig, type RelationsConfig } from "@app/domain";

import { createTopicChangeHooks } from "../topic-tree/topic-hooks.js";
import type { TopicTriggers } from "../topic-tree/topic-triggers.js";
import { linkRunTitle, matchedNotesOf } from "./relation-run-title.js";
import {
  createNoteMatchRequests,
  enqueueRelationMatches,
  RelationMatchTask,
  relationMatchBacklogDedupeKey,
  relationMatchDedupeKey
} from "./relation-match.js";
import { matchBacklogFingerprint, RelationMatchBacklog } from "./relation-match-backlog.js";
import type { DecidedNote } from "./relation-matcher.js";

const mocks = vi.hoisted(() => ({
  notes: { findById: vi.fn() },
  link: vi.fn(),
  root: vi.fn(),
  jobs: { enqueueDeduped: vi.fn() },
  backlog: {
    countAffected: vi.fn(),
    listAffected: vi.fn(),
    offer: vi.fn(),
    find: vi.fn(),
    resolve: vi.fn(),
    resolveOpen: vi.fn()
  }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createJobRepository: () => mocks.jobs,
  createRelationMatchBacklogRepository: () => mocks.backlog
}));
vi.mock("./relation-link.js", async (original) => ({
  ...(await original<typeof import("./relation-link.js")>()),
  enqueueRematchLink: mocks.link,
  linkRootOf: mocks.root
}));

// MATCH as a Gardener task (F4 D16): the hook that queues it, its executor with the matcher and the
// link job faked, and the backlog a decider change offers. The same job on a real database, with
// the supervisor and the link job, is in `relation-match.sidecar.test.ts`.
const noteId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const rootId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";
const jobId = "55555555-5555-4555-8555-555555555555";

const noteRecord = (extra: Record<string, unknown> = {}) => ({
  id: noteId,
  title: "Spacing",
  ideaStatement: "Spaced repetition beats massed practice.",
  bodyMarkdown: "Review at growing intervals.",
  status: "active",
  supersessionStatus: "current",
  createdFromSourceItemId: sourceId,
  ...extra
});

const decidedNote = (): DecidedNote => ({
  noteId,
  sourceItemId: sourceId,
  decider: {
    kind: "ranker",
    mode: "ranker",
    deciderKey: "ranker-key",
    calibration: "frozen",
    profileId: "ranker-profile",
    modelId: "ranker"
  },
  pairs: [
    {
      noteId,
      candidateId: otherId,
      candidateSourceItemId: rootId,
      band: "suggest",
      probability: 0.8,
      score: 2.1,
      calibration: "frozen",
      relationType: null,
      subjectId: null,
      decisionSource: "model",
      vectorScore: 0.7,
      graphScore: null
    }
  ]
});

const job = (payload: Record<string, unknown> = {}): JobRecord =>
  ({ id: jobId, payload: { noteId, rootId, ...payload } }) as unknown as JobRecord;
const signal = () => new AbortController().signal;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.notes.findById.mockResolvedValue(noteRecord());
  mocks.link.mockResolvedValue({ id: "link-job" });
  mocks.root.mockResolvedValue(rootId);
  mocks.jobs.enqueueDeduped.mockImplementation(async (input: { dedupeKey: string }) => ({
    job: { id: `job:${input.dedupeKey}` },
    created: true
  }));
});

describe("queueing MATCH for a note a person edited or accepted", () => {
  const pool = {} as PgPool;

  it("queues one debounced job per current note, in the light lane, scoped by its root", async () => {
    const jobs = await enqueueRelationMatches(pool as never, [noteId, noteId.toUpperCase()]);
    expect(jobs).toHaveLength(1);
    expect(mocks.jobs.enqueueDeduped).toHaveBeenCalledOnce();
    expect(mocks.jobs.enqueueDeduped).toHaveBeenCalledWith({
      type: "relation-match",
      lane: "light",
      dedupeKey: relationMatchDedupeKey(noteId),
      payload: { noteId, rootId },
      priority: 0,
      maxAttempts: 3,
      // 60 s for the next edit, at most 5 minutes in all (typed configuration).
      debounce: { delayMs: 60_000, maxDelayMs: 300_000 }
    });
    expect(mocks.root).toHaveBeenCalledWith(pool, sourceId);
  });

  it("follows the typed wait", async () => {
    await enqueueRelationMatches(pool as never, [noteId], {
      debounceMs: 5_000,
      maxDebounceMs: 9_000,
      backlogPageSize: 10
    });
    expect(mocks.jobs.enqueueDeduped.mock.calls[0]![0].debounce).toEqual({
      delayMs: 5_000,
      maxDelayMs: 9_000
    });
  });

  it.each([
    ["rejected", { status: "rejected" }],
    ["archived", { status: "archived" }],
    ["superseded", { supersessionStatus: "superseded" }]
  ])("leaves out a %s note", async (_name, extra) => {
    mocks.notes.findById.mockResolvedValue(noteRecord(extra));
    expect(await enqueueRelationMatches(pool as never, [noteId])).toEqual([]);
    mocks.notes.findById.mockResolvedValue(null);
    expect(await enqueueRelationMatches(pool as never, [noteId])).toEqual([]);
    expect(mocks.jobs.enqueueDeduped).not.toHaveBeenCalled();
  });

  it("is the topic hook's collaborator: queued only when the job type has an executor", async () => {
    let registered = false;
    const requests = createNoteMatchRequests({
      getPool: () => pool,
      isRegistered: (type) => registered && type === "relation-match"
    });
    expect(await requests.request([noteId], {})).toEqual([]);
    registered = true;
    expect(await requests.request([noteId], {})).toHaveLength(1);
    // In the caller's transaction when it has one; with no database, nothing.
    const client = { query: vi.fn() };
    await requests.request([noteId], { client: client as never });
    expect(mocks.root.mock.calls.at(-1)![0]).toBe(client);
    expect(
      await createNoteMatchRequests({ getPool: () => null, isRegistered: () => true }).request(
        [noteId],
        {}
      )
    ).toEqual([]);
  });

  it("is a hook that never fails its caller, and does nothing without a MATCH task", async () => {
    const triggers = {} as TopicTriggers;
    const warn = vi.fn();
    const failing = createTopicChangeHooks(
      triggers,
      { warn },
      {
        request: async () => {
          throw new Error("database down");
        }
      }
    );
    await expect(failing.notesToMatch!([noteId])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    const request = vi.fn(async () => []);
    const hooks = createTopicChangeHooks(triggers, undefined, { request });
    await hooks.notesToMatch!([]);
    expect(request).not.toHaveBeenCalled();
    await hooks.notesToMatch!([noteId]);
    expect(request).toHaveBeenCalledWith([noteId], {});
    // In a caller's transaction the request runs inside a savepoint.
    const queries: string[] = [];
    const client = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [] };
      }
    };
    await hooks.notesToMatch!([noteId], { client: client as never });
    expect(queries).toEqual(["savepoint topic_hook", "release savepoint topic_hook"]);
    // Without the collaborator: nothing happens and nothing throws.
    await expect(createTopicChangeHooks(triggers).notesToMatch!([noteId])).resolves.toBeUndefined();
  });
});

describe("the MATCH job", () => {
  function task(
    match: (
      options: Record<string, unknown>,
      context: Record<string, unknown>
    ) => Promise<Record<string, unknown>>,
    extra: { spaceKey?: string | null; config?: RelationsConfig } = {}
  ) {
    const matchAtomicNotes = vi.fn(
      async (
        _ids: string[],
        _signal: AbortSignal,
        _progress: undefined,
        context: Record<string, unknown>,
        options: Record<string, unknown>
      ) => match(options, context)
    );
    const wake = vi.fn();
    const instance = new RelationMatchTask({
      getPool: () => ({}) as PgPool,
      knowledge: { matchAtomicNotes } as never,
      spaceKey: async () => extra.spaceKey ?? "space-1",
      wake,
      ...(extra.config ? { config: extra.config } : {})
    });
    return { instance, matchAtomicNotes, wake };
  }
  const decidedWith = (decided: DecidedNote | null) => async (options: Record<string, unknown>) => {
    if (decided) await (options.onNoteDecided as (note: DecidedNote) => void)(decided);
    return {
      decided: 1,
      accepted: decided?.pairs.length ?? 0,
      persistedCount: 0,
      decider: "ranker"
    };
  };

  it("is one job type on the relations worker, with a fingerprint", () => {
    const registry = task(decidedWith(null)).instance.jobs();
    expect(Object.keys(registry)).toEqual(["relation-match"]);
    expect(registry["relation-match"]).toMatchObject({ needsModel: true, worker: "relations" });
    expect(registry["relation-match"]!.fingerprint).toBeTypeOf("function");
  });

  it("leaves a note whose text and space are unchanged: no decision, no link job", async () => {
    const { instance, matchAtomicNotes } = task(async () => ({
      decided: 0,
      accepted: 0,
      persistedCount: 0,
      unchanged: 1,
      decider: "ranker"
    }));
    const result = await instance.match(job(), signal());
    expect(result).toEqual({ status: "skipped", reason: "same_input", noteId });
    // The matcher is asked to leave an unchanged note alone, as background work at P2.
    expect(matchAtomicNotes).toHaveBeenCalledWith(
      [noteId],
      expect.anything(),
      undefined,
      {
        jobId,
        sourceItemId: sourceId,
        stage: "atomic_note_matching",
        origin: "job",
        priority: "P2",
        budgetClass: "background"
      },
      expect.objectContaining({ skipUnchanged: true })
    );
    expect(mocks.link).not.toHaveBeenCalled();
    // `skipped` is a producer's own skip: no change, never a failure or a blocker.
    expect(gardenerResultOf("relation-match", result)).toMatchObject({
      state: "outcome",
      outcome: "no_change"
    });
  });

  it("hands the accepted pairs to its root's link job as suggestions, with no relation of its own", async () => {
    const decided = decidedNote();
    const { instance, wake } = task(decidedWith(decided));
    const result = await instance.match(job(), signal());
    expect(result).toEqual({
      status: "completed",
      noteId,
      decided: 1,
      accepted: 1,
      linkJobId: "link-job"
    });
    expect(gardenerResultOf("relation-match", result)).toMatchObject({
      state: "outcome",
      outcome: "done"
    });
    expect(mocks.link).toHaveBeenCalledOnce();
    const [, handed] = mocks.link.mock.calls[0]!;
    expect(handed.rootId).toBe(rootId);
    expect(handed.matched).toEqual([{ noteId, title: "Spacing" }]);
    // The carried pair keeps the decider's band: a suggestion, and no direction of its own (31b).
    expect(handed.decided).toHaveLength(1);
    expect(handed.decided[0].pairs[0]).toMatchObject({ band: "suggest", relationType: null });
    expect(handed.decided[0].pairs[0].directionSubjectId).toBeUndefined();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("decides a note that accepts nothing without queuing a link job", async () => {
    const { instance } = task(decidedWith(null));
    const result = await instance.match(job(), signal());
    expect(result).toEqual({ status: "no_change", noteId, decided: 1, accepted: 0 });
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("waits for a decider or a route instead of failing, burning no attempt (D7)", async () => {
    const waiting = task(async () => ({
      decided: 0,
      accepted: 0,
      persistedCount: 0,
      skipped: "waiting_for_decider",
      decider: null
    }));
    const noDecider = await waiting.instance.match(job(), signal());
    expect(noDecider).toEqual({ status: "no_decider", noteId });
    expect(gardenerResultOf("relation-match", noDecider)).toMatchObject({
      state: "blocked",
      blocker: { class: "no_model", reason: "no_decider" }
    });
    const missing = task(async () => {
      throw new Error("errors.ai.noCompatibleModel");
    });
    const noRoute = await missing.instance.match(job(), signal());
    expect(gardenerResultOf("relation-match", noRoute)).toMatchObject({
      state: "blocked",
      blocker: { class: "no_model", reason: "no_route" }
    });
    // Any other error is the job's failure, retried like one.
    const broken = task(async () => {
      throw new Error("database_down");
    });
    await expect(broken.instance.match(job(), signal())).rejects.toThrow("database_down");
  });

  it("does nothing for a note that is gone or no longer current", async () => {
    const { instance, matchAtomicNotes } = task(decidedWith(null));
    mocks.notes.findById.mockResolvedValue(noteRecord({ status: "rejected" }));
    expect(await instance.match(job(), signal())).toMatchObject({
      status: "no_change",
      reason: "note_not_current"
    });
    mocks.notes.findById.mockResolvedValue(null);
    expect(await instance.match(job(), signal())).toMatchObject({ status: "no_change" });
    expect(matchAtomicNotes).not.toHaveBeenCalled();
  });

  it("decides an unchanged note again for a backlog, behind everything else", async () => {
    const { instance, matchAtomicNotes } = task(decidedWith(null));
    await instance.match(job({ backlog: true }), signal());
    expect(matchAtomicNotes.mock.calls[0]![3]).toMatchObject({ priority: "P3" });
    expect(matchAtomicNotes.mock.calls[0]![4]).toMatchObject({ skipUnchanged: false });
  });

  it("states a content-only fingerprint: the rendered text and the space, never the decider", async () => {
    const { instance } = task(decidedWith(null));
    const first = await instance.fingerprint(job());
    expect(first).toMatch(/^gf1:[0-9a-f]{64}$/u);
    expect(await instance.fingerprint(job())).toBe(first);
    // An edit of what the decider is shown, or a new space, changes it.
    mocks.notes.findById.mockResolvedValue(noteRecord({ title: "Spacing effect" }));
    expect(await instance.fingerprint(job())).not.toBe(first);
    mocks.notes.findById.mockResolvedValue(noteRecord());
    expect(
      await task(decidedWith(null), { spaceKey: "space-2" }).instance.fingerprint(job())
    ).not.toBe(first);
    // Text the decider cannot see (the body past the rendered characters) leaves it alone.
    const long = (tail: string) =>
      noteRecord({ bodyMarkdown: `${"x".repeat(relationsConfig.decide.bodyCharacters)}${tail}` });
    mocks.notes.findById.mockResolvedValue(long(" one"));
    const one = await instance.fingerprint(job());
    mocks.notes.findById.mockResolvedValue(long(" two"));
    expect(await instance.fingerprint(job())).toBe(one);
    // A backlog's job states none: it exists to decide an unchanged note again.
    expect(await instance.fingerprint(job({ backlog: true }))).toBeNull();
    mocks.notes.findById.mockResolvedValue(null);
    expect(await instance.fingerprint(job())).toBeNull();
  });
});

describe("the titles of the relation passes", () => {
  const counts = (applied: number, suggested: number) => ({ applied, suggested });
  const noRoot = async () => null;

  it("names the run of one matched note after the note", async () => {
    expect(
      await linkRunTitle({
        matched: [{ noteId, title: "Spacing" }],
        counts: counts(0, 2),
        rootTitle: noRoot
      })
    ).toEqual({ titleKey: "changes.titles.relationMatched", titleParams: { note: "Spacing" } });
  });

  it("names a run that only suggested after its source, and leaves any other to its kind", async () => {
    const rootTitle = vi.fn(async () => "Learning Book");
    expect(await linkRunTitle({ matched: [], counts: counts(0, 3), rootTitle })).toEqual({
      titleKey: "changes.titles.relationSuggested",
      titleParams: { n: 3, source: "Learning Book" }
    });
    // Two matched notes (merged into one job) are a source's run, not a note's.
    expect(
      await linkRunTitle({
        matched: [
          { noteId, title: "Spacing" },
          { noteId: otherId, title: "Interleaving" }
        ],
        counts: counts(0, 2),
        rootTitle
      })
    ).toMatchObject({ titleKey: "changes.titles.relationSuggested" });
    // Anything applied, or nothing suggested, or a source with no title: the kind's own title.
    rootTitle.mockClear();
    expect(await linkRunTitle({ matched: [], counts: counts(1, 3), rootTitle })).toBeNull();
    expect(await linkRunTitle({ matched: [], counts: counts(0, 0), rootTitle })).toBeNull();
    expect(rootTitle).not.toHaveBeenCalled();
    expect(await linkRunTitle({ matched: [], counts: counts(0, 3), rootTitle: noRoot })).toBeNull();
  });

  it("reads the matched notes of a payload and clips a long title", () => {
    expect(
      matchedNotesOf({
        matched: [
          { noteId, title: "a".repeat(200) },
          { noteId: "", title: "no id" },
          { noteId: otherId },
          "text"
        ]
      })
    ).toEqual([{ noteId, title: "a".repeat(120) }]);
    expect(matchedNotesOf({})).toEqual([]);
    expect(matchedNotesOf({ matched: "no" })).toEqual([]);
  });
});

describe("the MATCH backlog", () => {
  const findingId = "66666666-6666-4666-8666-666666666666";
  const finding = (fingerprint: string, status = "open") => ({
    id: findingId,
    fingerprint,
    status,
    params: { task: "match" },
    createdAt: new Date(),
    updatedAt: new Date()
  });

  function backlog(key: string | null, config?: RelationsConfig) {
    const wake = vi.fn();
    return {
      instance: new RelationMatchBacklog({
        getPool: () => ({}) as PgPool,
        deciderKey: async () => key,
        spaceKey: async () => "space-1",
        wake,
        ...(config ? { config } : {})
      }),
      wake
    };
  }

  it("keys one offer to one decider", () => {
    expect(matchBacklogFingerprint("decider-a")).toMatch(/^match:[0-9a-f]{40}$/u);
    expect(matchBacklogFingerprint("decider-a")).toBe(matchBacklogFingerprint("decider-a"));
    expect(matchBacklogFingerprint("decider-a")).not.toBe(matchBacklogFingerprint("decider-b"));
  });

  it("offers the notes a decider change would match again, once per decider", async () => {
    mocks.backlog.countAffected.mockResolvedValue(12);
    mocks.backlog.offer.mockResolvedValue({
      finding: finding(matchBacklogFingerprint("new")),
      created: true
    });
    const { instance } = backlog("new");
    expect(await instance.offer()).toEqual({ status: "offered", notes: 12, findingId });
    expect(mocks.backlog.countAffected).toHaveBeenCalledWith({
      deciderKey: "new",
      spaceKey: "space-1"
    });
    expect(mocks.backlog.resolveOpen).toHaveBeenCalledWith(matchBacklogFingerprint("new"));
    expect(mocks.backlog.offer).toHaveBeenCalledWith({
      fingerprint: matchBacklogFingerprint("new"),
      params: { task: "match", reason: "decider_changed", notes: 12 }
    });
    // Offered again, the open finding only has its count updated.
    mocks.backlog.offer.mockResolvedValue({
      finding: finding(matchBacklogFingerprint("new")),
      created: false
    });
    expect(await instance.offer()).toMatchObject({ status: "updated", notes: 12 });
    // Nothing is queued by an offer.
    expect(mocks.jobs.enqueueDeduped).not.toHaveBeenCalled();
  });

  it("keeps a dismissed offer closed, and closes the offer of an older decider", async () => {
    mocks.backlog.countAffected.mockResolvedValue(3);
    mocks.backlog.offer.mockResolvedValue(null);
    expect(await backlog("new").instance.offer()).toEqual({ status: "closed", notes: 3 });
    mocks.backlog.countAffected.mockResolvedValue(0);
    expect(await backlog("new").instance.offer()).toEqual({ status: "none", notes: 0 });
    // No note is left to match again: every open offer is moot.
    expect(mocks.backlog.resolveOpen).toHaveBeenLastCalledWith(null);
  });

  it("treats a decider that cannot run (a missing route) as no decider", async () => {
    const failing = new RelationMatchBacklog({
      getPool: () => ({}) as PgPool,
      deciderKey: async () => {
        throw new Error("errors.ai.noCompatibleModel");
      }
    });
    expect(await failing.offer()).toEqual({ status: "waiting" });
    mocks.backlog.find.mockResolvedValue(finding(matchBacklogFingerprint("new")));
    expect(await failing.accept(findingId)).toEqual({ status: "waiting" });
    expect(mocks.backlog.countAffected).not.toHaveBeenCalled();
    expect(mocks.backlog.resolve).not.toHaveBeenCalled();
  });

  it("offers nothing while no decider can decide", async () => {
    expect(await backlog(null).instance.offer()).toEqual({ status: "waiting" });
    expect(mocks.backlog.countAffected).not.toHaveBeenCalled();
    expect(await backlog(null).instance.accept(findingId)).toEqual({ status: "closed" });
  });

  it("queues the affected notes at the lowest priority a page at a time, then resolves the offer", async () => {
    const fingerprint = matchBacklogFingerprint("new");
    mocks.backlog.find.mockResolvedValue(finding(fingerprint));
    const notes = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, index) => ({
        noteId: `n${from + index}`,
        rootId: `r${from + index}`
      }));
    mocks.backlog.listAffected
      .mockResolvedValueOnce(notes(0, 2))
      .mockResolvedValueOnce(notes(2, 4))
      .mockResolvedValueOnce(notes(4, 5));
    const { instance, wake } = backlog("new", {
      ...relationsConfig,
      match: { ...relationsConfig.match, backlogPageSize: 2 }
    });
    expect(await instance.accept(findingId)).toEqual({ status: "queued", queued: 5 });
    expect(mocks.backlog.listAffected.mock.calls.map(([page]) => page.afterNoteId)).toEqual([
      null,
      "n1",
      "n3"
    ]);
    expect(mocks.jobs.enqueueDeduped).toHaveBeenCalledTimes(5);
    expect(mocks.jobs.enqueueDeduped.mock.calls[0]![0]).toEqual({
      type: "relation-match",
      lane: "light",
      dedupeKey: relationMatchBacklogDedupeKey("n0"),
      payload: { noteId: "n0", rootId: "r0", backlog: true },
      priority: -1,
      maxAttempts: 3,
      debounce: { delayMs: 0, maxDelayMs: 0 }
    });
    expect(mocks.backlog.resolve).toHaveBeenCalledWith(findingId);
    expect(wake).toHaveBeenCalledOnce();
  });

  it("resolves a stale offer, and refuses one that is not open", async () => {
    mocks.backlog.find.mockResolvedValue(finding(matchBacklogFingerprint("old")));
    expect(await backlog("new").instance.accept(findingId)).toEqual({ status: "stale" });
    expect(mocks.backlog.resolve).toHaveBeenCalledWith(findingId);
    expect(mocks.backlog.listAffected).not.toHaveBeenCalled();
    mocks.backlog.find.mockResolvedValue(finding(matchBacklogFingerprint("new"), "dismissed"));
    expect(await backlog("new").instance.accept(findingId)).toEqual({ status: "closed" });
    mocks.backlog.find.mockResolvedValue(null);
    expect(await backlog("new").instance.accept(findingId)).toEqual({ status: "closed" });
  });
});
