import { resolveDecisionsLimits } from "@app/ai";
import type { Queryable } from "@app/db";
import { describe, expect, it, vi } from "vitest";

import {
  planProbe,
  probeCapUsd,
  probeRequests,
  readFixtureNotes,
  runDecisionsLedgerProbe,
  scriptedDecisionsFetch,
  type ProbeAuditRow
} from "./decisions-ledger-probe.ts";

/**
 * The Decisions ledger probe's dry run (F4 T76, Q12): the scripted provider, no key, no network and
 * no database. The audit lives in memory and the ledger statement is answered from it as the
 * database would group it, so the probe's checks run end to end at US$ 0.
 */
function memoryLedger() {
  const rows: ProbeAuditRow[] = [];
  const settings = new Map<string, unknown>();
  const pool: Queryable = {
    query: (async (text: string, values: readonly unknown[] = []) => {
      if (text.includes("from ai_task_runs")) {
        if (rows.length === 0) return { rows: [] };
        const known = rows.filter((row) => row.inputTokens !== null && row.outputTokens !== null);
        const unknown = rows.filter((row) => row.inputTokens === null || row.outputTokens === null);
        return {
          rows: [
            {
              provider: "openai-decisions",
              modelId: "gpt-6-luna",
              calls: String(rows.length),
              inputTokens: String(known.reduce((sum, row) => sum + row.inputTokens!, 0)),
              outputTokens: String(known.reduce((sum, row) => sum + row.outputTokens!, 0)),
              estimatedCalls: String(
                unknown.filter((row) => row.budgetEstimateUsd !== null).length
              ),
              // Every row's stored estimate, as the statement sums it (0061).
              estimateUsd: rows.reduce((sum, row) => sum + (row.budgetEstimateUsd ?? 0), 0),
              unestimatedCalls: "0",
              unestimatedInputTokens: "0",
              unestimatedOutputTokens: "0"
            }
          ]
        };
      }
      if (text.startsWith("select")) {
        const key = values[0] as string;
        return settings.has(key) ? { rows: [{ key, value: settings.get(key) }] } : { rows: [] };
      }
      settings.set(values[0] as string, values[1]);
      return { rows: [{ key: values[0], value: values[1], updatedAt: new Date() }] };
    }) as Queryable["query"]
  };
  return { rows, pool, audit: { record: async (row: ProbeAuditRow) => void rows.push(row) } };
}

describe("the Decisions ledger probe (dry run)", () => {
  it("plans 20 requests of the product design from the synthetic fixture only", async () => {
    const notes = await readFixtureNotes();
    expect(notes.length).toBeGreaterThan(40);
    const plan = planProbe(notes, "instruction", resolveDecisionsLimits());
    expect(plan).toHaveLength(probeRequests);
    for (const request of plan) {
      expect(request.input.candidates.length).toBeGreaterThan(0);
      expect(notes).toContain(request.input.query);
    }
  });

  it("checks the ledger against the provider's reported usage, with no key and no network", async () => {
    const { rows, pool, audit } = memoryLedger();
    const fetch = vi.fn(scriptedDecisionsFetch());
    const apiKey = vi.fn(() => "dry-run-key-not-a-secret");
    const report = await runDecisionsLedgerProbe({
      mode: "dry-run",
      fetch,
      apiKey,
      pool,
      audit,
      instruction: "Is the candidate related to the note?",
      notes: await readFixtureNotes()
    });
    expect(fetch).toHaveBeenCalledTimes(probeRequests);
    for (const [url] of fetch.mock.calls)
      expect(String(url)).toBe("https://api.openai.com/v1/decisions");
    expect(rows).toHaveLength(probeRequests);
    expect(report.stoppedBy).toBeNull();
    expect(report.checks).toEqual({
      ledgerMatchesProvider: true,
      inMemoryMatchesLedger: true,
      adapterMatchesProvider: true,
      estimatesNeverBelowUsage: true,
      withinCap: true
    });
    expect(report.passed).toBe(true);
    expect(report.totals.sent).toBe(probeRequests);
    expect(report.totals.providerUsd).toBeGreaterThan(0);
    expect(report.totals.providerUsd).toBeLessThan(probeCapUsd);
    expect(report.totals.ledgerUsd).toBeCloseTo(report.totals.providerUsd, 12);
    // The report holds no text of the requests and no key.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("dry-run-key");
    expect(serialized).not.toContain("instruction");
  });

  it("records a refusal once, never retries it and sends nothing after it", async () => {
    const { rows, pool, audit } = memoryLedger();
    let calls = 0;
    const fetch = vi.fn((async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 3)
        return new Response(
          JSON.stringify({ error: { code: "credit_balance_exhausted", message: "no credit" } }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      return scriptedDecisionsFetch()(url, init);
    }) as typeof globalThis.fetch);
    const report = await runDecisionsLedgerProbe({
      mode: "dry-run",
      fetch,
      apiKey: () => "dry-run-key-not-a-secret",
      pool,
      audit,
      instruction: "Is the candidate related to the note?",
      notes: await readFixtureNotes()
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(report.stoppedBy).toMatch(/^request 2: /u);
    expect(report.requests[2]!.status).toBe("failed");
    expect(report.requests.slice(3).every((request) => request.status === "not_sent")).toBe(true);
    expect(rows).toHaveLength(3);
    expect(report.passed).toBe(false);
    // The failed request reported no usage: its estimate stays as spend in the ledger.
    expect(report.checks.ledgerMatchesProvider).toBe(true);
  });
});
