import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BENCHMARKS, evaluateBenchmark } from "../src/benchmark/definitions.mjs";
import { createPrecommitManifest, deriveQualificationFlags, runBenchmark } from "../src/benchmark/framework.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { CATEGORIES, publicMetrics, RUN_TYPES, terminalStateFor } from "../src/domain.mjs";

const agent = { identity: "fixture:test-agent", name: "Test Agent", services: [] };
const input = { startingCapitalUsdCents: 100_000, deadlineAtUnixSeconds: 2_000_000_000 };

test("fixture run is persisted but excluded from public metrics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canned-test-"));
  const store = await new FileStore(root).init();
  const run = await runBenchmark({ agent, benchmark: BENCHMARKS[CATEGORIES.YIELD_OPTIMISATION], input, agentOutput: { realizedYieldBps: 600, executionCostUsdCents: 2 }, controlOutput: { realizedYieldBps: 500, executionCostUsdCents: 0 }, store, runType: RUN_TYPES.FIXTURE, provenanceMode: "FIXTURE", qualification: { allGatesPassed: false } });
  assert.equal(run.terminalState, "completed");
  assert.deepEqual(publicMetrics([run]), { jobsPaidForAndGraded: 0, agentsTested: 0, winsVsControl: 0, qualifyingRuns: 0, excludedRuns: 1 });
  assert.equal((await store.loadRuns()).length, 1);
});

test("unfunded benchmark runs cannot enter public metrics", () => {
  const run = { kind: "benchmark_run", runType: RUN_TYPES.BENCHMARK, provenance: { mode: "LIVE_QUALIFYING", fixture: false, infrastructureSmokeTest: false }, qualification: { allGatesPassed: true }, terminalState: "completed", agent: { identity: "agent:unfunded" }, evaluation: { metrics: { agentAdvantage: true } }, protocolJob: null };
  assert.equal(publicMetrics([run]).qualifyingRuns, 0);
  assert.equal(publicMetrics([run]).excludedRuns, 1);
});

test("execution failures remain distinct from insufficient data", () => {
  assert.equal(terminalStateFor({ executionStatus: "rejected", evaluationStatus: "completed" }), "rejected");
  assert.equal(terminalStateFor({ executionStatus: "expired", evaluationStatus: "insufficient_data" }), "expired");
  assert.equal(terminalStateFor({ executionStatus: "timeout", evaluationStatus: "insufficient_data" }), "timeout");
  assert.equal(terminalStateFor({ executionStatus: "error", evaluationStatus: "insufficient_data" }), "error");
  assert.equal(terminalStateFor({ evaluationStatus: "insufficient_data" }), "insufficient_data");
});

test("qualification flags require payment, provenance, and an independent control", () => {
  const base = { runType: RUN_TYPES.BENCHMARK, provenanceMode: "LIVE_QUALIFYING", precommit: { manifestHash: "0xmanifest" }, protocolJob: { funded: true, jobId: "17", currentState: "COMPLETED", events: [{ tx: { transactionHash: "0xtx" } }] }, agentOutput: {}, controlOutput: { provenance: { independent: true } }, evaluation: { status: "completed" }, terminalState: "completed" };
  assert.equal(deriveQualificationFlags(base).qualifiesForPublicMetrics, true);
  assert.equal(deriveQualificationFlags({ ...base, controlOutput: {} }).qualifiesForPublicMetrics, false);
  assert.equal(deriveQualificationFlags({ ...base, protocolJob: null }).qualifiesForPublicMetrics, false);
  assert.equal(deriveQualificationFlags({ ...base, precommit: null }).qualifiesForPublicMetrics, false);
});

test("precommit binds provider, quote, evidence schema, and expiry", () => {
  const manifest = createPrecommitManifest({
    runId: "run:precommit",
    agent: { identity: "agent:test", agentWallet: "0xprovider", services: [{ type: "A2A", endpoint: "https://agent.example" }] },
    benchmark: BENCHMARKS[CATEGORIES.REBALANCING],
    input,
    limits: { maxBudget: "100" },
    deadlineAtUnixSeconds: 2_000_000_000,
    providerIdentity: "agent:test",
    providerAddress: "0xprovider",
    quoteTerms: { price: "100", currency: "0xU" },
    expectedEvidenceSchema: { agentOutput: "json", controlOutput: "json" },
  });
  assert.equal(manifest.providerAddress, "0xprovider");
  assert.equal(manifest.budget, "100");
  assert.equal(manifest.paymentToken, "0xU");
  assert.equal(manifest.expectedEvidenceSchema.agentOutput, "json");
  assert.match(manifest.manifestHash, /^0x/);
});

test("malformed output becomes insufficient data", () => {
  const result = evaluateBenchmark({ benchmark: BENCHMARKS[CATEGORIES.YIELD_OPTIMISATION], input, agentOutput: { realizedYieldBps: "not-a-number" }, controlOutput: { realizedYieldBps: 500, executionCostUsdCents: 0 } });
  assert.equal(result.status, "insufficient_data");
});
