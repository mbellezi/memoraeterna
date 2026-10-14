/**
 * Offline self-check for the Spike A2 client, key handling, request design and stage plan
 * (vitest does not include `scripts/`). Sends nothing to the network.
 *
 *   npx tsx scripts/spikes/decisions/selfcheck.ts
 */
import assert from "node:assert/strict";

import { loadDataset } from "../reranker/dataset.js";

import {
  bandDirectedPairs,
  bandLows,
  bandRunId,
  inBand,
  loadBandContext,
  partitionRows,
  planBand
} from "./band-plan.js";
import { costUsd } from "./budget.js";
import {
  DecisionsClient,
  DecisionsError,
  parseRetryAfter,
  type DecisionRequest
} from "./client.js";
import { buildRequest, maxCandidatesPerRequest, relationTypes } from "./design.js";
import { parseApiKey, redactSecrets } from "./env.js";
import { planStages } from "./plan.js";

// --- Key parsing and redaction ---------------------------------------------------------------
const fakeKey = "sk-proj-FAKEKEYFORSELFCHECK0123456789";
assert.equal(parseApiKey(`A=1\nOPENAPI_KEY=${fakeKey}\nB=2`), fakeKey);
assert.equal(parseApiKey(`export OPENAPI_KEY="${fakeKey}" # note`), fakeKey);
assert.equal(parseApiKey(`OPENAPI_KEY='${fakeKey}'`), fakeKey);
assert.equal(parseApiKey(`OPENAPI_KEY=${fakeKey} # comment`), fakeKey);
assert.equal(parseApiKey(`# OPENAPI_KEY=${fakeKey}`), null);
assert.equal(parseApiKey(`${String.fromCharCode(0xfeff)}OPENAPI_KEY=${fakeKey}`), fakeKey);
assert.equal(parseApiKey("OPENAPI_KEY=\n"), null);
assert.equal(parseApiKey("OTHER_OPENAPI_KEY=x"), null);
assert.ok(!redactSecrets(`bad key ${fakeKey} and Bearer abc.def`, [fakeKey]).includes("FAKEKEY"));
assert.ok(!redactSecrets("Incorrect API key provided: sk-proj-abcdef123456").includes("abcdef"));
assert.ok(!redactSecrets("Authorization: Bearer abc123token").includes("abc123token"));

// --- Client against a scripted fetch ---------------------------------------------------------
const request: DecisionRequest = {
  model: "gpt-6-luna",
  input: "text",
  questions: [{ type: "predicate", name: "q", instructions: "is it?" }]
};
const okBody = {
  model: "gpt-6-luna-test",
  answers: [{ type: "predicate", name: "q", probability: 0.75 }],
  usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 }
};
const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });

function scripted(steps: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    return step();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const waits: number[] = [];
const sleep = async (ms: number): Promise<void> => {
  waits.push(ms);
};
const make = (steps: Array<() => Response | Promise<Response>>, extra = {}) => {
  const fake = scripted(steps);
  return {
    fake,
    client: new DecisionsClient({
      apiKey: fakeKey,
      fetchImpl: fake.fetchImpl,
      sleep,
      random: () => 0,
      baseDelayMs: 100,
      ...extra
    })
  };
};

{
  const { fake, client } = make([() => json(200, okBody, { "x-request-id": "req_1" })]);
  const result = await client.decide(request);
  assert.equal(result.answers.length, 1);
  assert.equal(result.requestId, "req_1");
  assert.equal(fake.calls[0]!.url, "https://api.openai.com/v1/decisions");
  assert.equal((fake.calls[0]!.init as { redirect?: string }).redirect, "error");
  assert.equal(
    (fake.calls[0]!.init.headers as Record<string, string>).Authorization,
    `Bearer ${fakeKey}`
  );
  assert.ok(!JSON.stringify(client.describeRequest(request)).includes("FAKEKEY"));
}
{
  // 429 with Retry-After is honored, then succeeds.
  waits.length = 0;
  const { fake, client } = make([
    () =>
      json(
        429,
        { error: { code: "rate_limit_exceeded", message: "slow down" } },
        { "retry-after": "3" }
      ),
    () => json(200, okBody)
  ]);
  const result = await client.decide(request);
  assert.equal(fake.calls.length, 2);
  assert.equal(result.attempts.length, 2);
  assert.ok(waits[0]! >= 3000 && waits[0]! < 3300, `waited ${waits[0]}`);
}
{
  // 5xx backs off exponentially and retries; the third attempt succeeds.
  waits.length = 0;
  const { fake, client } = make([
    () => json(500, { error: { message: "boom" } }),
    () => json(503, { error: { message: "busy" } }),
    () => json(200, okBody)
  ]);
  await client.decide(request);
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(waits, [50, 100]);
}
{
  // Auth errors are not retried and never echo the key.
  const { fake, client } = make([
    () =>
      json(401, {
        error: { code: "invalid_api_key", message: `Incorrect API key provided: ${fakeKey}` }
      })
  ]);
  await assert.rejects(client.decide(request), (error: unknown) => {
    assert.ok(error instanceof DecisionsError);
    assert.equal(error.kind, "auth");
    assert.ok(!error.message.includes("FAKEKEY"), error.message);
    return true;
  });
  assert.equal(fake.calls.length, 1);
}
{
  // Quota exhaustion and invalid requests are not retried either.
  const quota = make([
    () => json(429, { error: { code: "insufficient_quota", message: "no quota" } })
  ]);
  await assert.rejects(
    quota.client.decide(request),
    (e: unknown) => e instanceof DecisionsError && e.kind === "quota"
  );
  assert.equal(quota.fake.calls.length, 1);
  const bad = make([() => json(400, { error: { message: "bad question" } })]);
  await assert.rejects(
    bad.client.decide(request),
    (e: unknown) => e instanceof DecisionsError && e.kind === "invalid_request"
  );
  assert.equal(bad.fake.calls.length, 1);
}
{
  // A Retry-After beyond the cap is not waited for.
  const { fake, client } = make([
    () => json(429, { error: { message: "later" } }, { "retry-after": "3600" })
  ]);
  await assert.rejects(
    client.decide(request),
    (e: unknown) => e instanceof DecisionsError && e.kind === "rate_limit"
  );
  assert.equal(fake.calls.length, 1);
}
{
  // Schema failures are not retried.
  const { fake, client } = make([
    () => json(200, { model: "m", answers: [{ type: "weird" }], usage: {} })
  ]);
  await assert.rejects(
    client.decide(request),
    (e: unknown) => e instanceof DecisionsError && e.kind === "schema"
  );
  assert.equal(fake.calls.length, 1);
}
{
  // A stalled request hits the header deadline and is retried until attempts run out.
  const stalled = (): Promise<Response> => new Promise(() => undefined);
  const hang = (async (_url: string | URL | Request, init?: RequestInit) => {
    await new Promise<never>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    );
    return stalled();
  }) as typeof fetch;
  const client = new DecisionsClient({
    apiKey: fakeKey,
    fetchImpl: hang,
    sleep,
    random: () => 0,
    headersTimeoutMs: 20,
    totalTimeoutMs: 100,
    maxAttempts: 2
  });
  await assert.rejects(client.decide(request), (e: unknown) => {
    assert.ok(e instanceof DecisionsError);
    assert.equal(e.kind, "timeout");
    assert.equal(e.attempts.length, 2);
    return true;
  });
}
assert.equal(parseRetryAfter("2"), 2000);
assert.equal(parseRetryAfter(null), null);
assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 4000), 6000);

// --- Cost -------------------------------------------------------------------------------------
assert.ok(Math.abs(costUsd(1_000_000) - 0.1) < 1e-12);

// --- Request design --------------------------------------------------------------------------
const notes = Array.from({ length: 5 }, (_, index) => ({ id: `n${index}`, text: `Note ${index}` }));
const build = (config: "predicate" | "typed", key = "k") =>
  buildRequest({
    key,
    instruction: "INSTR",
    query: { id: "q", text: "Query text" },
    candidates: notes,
    config
  });
const predicate = build("predicate");
assert.equal(predicate.request.questions.length, 5);
assert.deepEqual(build("predicate").candidateIds, predicate.candidateIds, "deterministic order");
assert.notDeepEqual(build("predicate", "other-key").candidateIds, predicate.candidateIds);
assert.ok(predicate.request.input.includes("[c5]"));
assert.ok(predicate.request.input.startsWith("INSTR"));
const typed = build("typed");
assert.equal(typed.request.questions.length, 10);
const names = typed.request.questions.map((question) => question.name);
assert.equal(new Set(names).size, names.length, "question names are unique");
for (const question of typed.request.questions.slice(5)) {
  assert.equal(question.type, "choice");
  if (question.type === "choice") {
    assert.deepEqual(
      question.choices.map((choice) => choice.value).sort(),
      [...relationTypes].sort()
    );
  }
}
const orders = new Set(
  typed.request.questions
    .slice(5)
    .map((q) => (q.type === "choice" ? q.choices.map((c) => c.value).join(",") : ""))
);
assert.ok(orders.size > 1, "option order is shuffled per question");

// --- Stage plan over the real dataset --------------------------------------------------------
const dataset = await loadDataset();
const stages = planStages(dataset);
const seen = new Set<string>();
for (const jobs of Object.values(stages)) {
  for (const job of jobs) {
    assert.ok(job.candidateIds.length <= maxCandidatesPerRequest);
    for (const doc of job.candidateIds) {
      const id = `${job.queryId}|${doc}`;
      assert.ok(!seen.has(id), `pair scored twice: ${id}`);
      seen.add(id);
    }
  }
}
for (const [query, doc] of dataset.sets.all) {
  assert.ok(seen.has(`${query}|${doc}`), "every directed pair of Spike A is planned");
}

// --- Band-only plan (the tiebreaker shape) ---------------------------------------------------
const bandContext = await loadBandContext();
const heldOutNotes = new Set(
  dataset.notes.filter((note) => note.partition === "holdout").map((note) => note.id)
);
assert.equal(bandRunId("tuning", 1.5), "band-tuning-lo1.5__predicate");
assert.equal(bandRunId("holdout", 0, "B"), "band-holdout-lo0__predicate__orderB");
for (const partition of ["tuning", "holdout"] as const) {
  let wider: Set<string> | null = null;
  for (const lo of [...bandLows].sort((a, b) => a - b)) {
    const pairs = bandDirectedPairs(bandContext, partition, lo);
    const ids = pairs.map(([query, doc]) => `${query}|${doc}`);
    assert.equal(new Set(ids).size, ids.length, "band pairs are unique");
    const jobs = planBand(bandContext, partition, lo);
    const planned = jobs.flatMap((job) => job.candidateIds.map((doc) => `${job.queryId}|${doc}`));
    assert.equal(new Set(planned).size, planned.length, "band pair planned twice");
    assert.deepEqual([...planned].sort(), [...ids].sort(), "plan covers exactly the band pairs");
    for (const job of jobs) assert.ok(job.candidateIds.length <= maxCandidatesPerRequest);
    const plannedSet = new Set(planned);
    for (const row of partitionRows(bandContext, partition)) {
      if (!inBand(bandContext, row, lo)) continue;
      assert.ok(plannedSet.has(`${row.query}|${row.doc}`), "band row planned forward");
      assert.ok(plannedSet.has(`${row.doc}|${row.query}`), "band row planned in reverse");
    }
    if (partition === "tuning") {
      for (const job of jobs) {
        assert.ok(!heldOutNotes.has(job.queryId), "tuning band request carries a held-out note");
        for (const doc of job.candidateIds) assert.ok(!heldOutNotes.has(doc));
      }
    }
    // Edges ascend, so each band must sit inside the previous (wider) one.
    if (wider)
      assert.ok(
        ids.every((id) => wider!.has(id)),
        "a higher band edge is a subset"
      );
    wider = new Set(ids);
  }
}

console.info(
  `selfcheck ok: ${seen.size} directed pairs planned over ${Object.values(stages).flat().length} requests`
);
