import test from "node:test";
import assert from "node:assert/strict";
import { buildControlQualification, deterministicControlOutput, lifecyclePhaseSummary, validateDeterministicControl } from "../src/protocol/control.mjs";
import { buildProviderHistory, buildReadinessChecklist, inferErc8183Capabilities } from "../src/discovery/readiness.mjs";
import { correlateAgentFamily } from "../src/discovery/correlation.mjs";
import { publicMetrics, RUN_TYPES } from "../src/domain.mjs";

test("deterministic control output binds input hash, job, provider, and exact result", () => {
  const output = deterministicControlOutput({ input: { numbers: [4, 7, 11] }, jobId: 42, provider: "0x0000000000000000000000000000000000000042" });
  assert.equal(output.sum, 22);
  assert.equal(output.count, 3);
  assert.equal(validateDeterministicControl({ output, expectedInput: { numbers: [4, 7, 11] }, expectedJobId: 42, expectedProvider: "0x0000000000000000000000000000000000000042" }).valid, true);
  assert.equal(validateDeterministicControl({ output: { ...output, sum: 23 }, expectedInput: { numbers: [4, 7, 11] }, expectedJobId: 42, expectedProvider: "0x0000000000000000000000000000000000000042" }).valid, false);
});

test("infrastructure protocol controls are excluded from public metrics and provider cooldown history", () => {
  const run = { kind: "infrastructure_control_run", runType: RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL, provenance: { mode: "INFRASTRUCTURE_CONTROL" }, agent: { identity: "CANNED_PROTOCOL_CONTROL" }, protocolJob: { funded: true, jobId: "42", currentState: "SUBMITTED" }, qualification: { allGatesPassed: true }, terminalState: "completed", evaluation: { status: "completed" } };
  assert.deepEqual(publicMetrics([run]), { jobsPaidForAndGraded: 0, agentsTested: 0, winsVsControl: 0, qualifyingRuns: 0, excludedRuns: 1 });
  assert.deepEqual(buildProviderHistory([run]), {});
});

test("control qualification requires a real SUBMITTED path and matching provider signer", () => {
  const base = { precommitHash: "0xpre", jobId: "42", events: [{ event: "chain_state_observed", snapshot: { status: "SUBMITTED" } }] };
  assert.equal(buildControlQualification({ protocolJob: { ...base, currentState: "SUBMITTED" }, deliverableValidation: { valid: true }, providerSignerMatches: true }).isComplete, true);
  assert.equal(buildControlQualification({ protocolJob: { ...base, currentState: "FUNDED" }, deliverableValidation: { valid: true }, providerSignerMatches: true }).isComplete, false);
  assert.equal(buildControlQualification({ protocolJob: { ...base, currentState: "SUBMITTED" }, deliverableValidation: { valid: true }, providerSignerMatches: false }).isComplete, false);
});

test("lifecycle summary distinguishes watcher detection and submission", () => {
  const summary = lifecyclePhaseSummary({ currentState: "SUBMITTED", events: [{ event: "create_job", tx: { transactionHash: "0x1" } }, { event: "provider_detected" }, { event: "provider_submit_result", result: { txHash: "0x2" } }, { event: "deliverable_observed" }] });
  assert.equal(summary.providerDetected, true);
  assert.equal(summary.submitTx, "0x2");
  assert.equal(summary.submitted, true);
  assert.equal(summary.deliverable, "validated or attempted");
});

test("capability subtypes are evidence-derived", () => {
  const result = inferErc8183Capabilities({ card: { protocolVersion: "0.3.0", skills: [{ id: "notify_funded" }], description: "funded_job_watcher submit_result with provider storage deliverable_url" } });
  assert.equal(result.capabilities.includes("ERC8183_NOTIFY_FUNDED"), true);
  assert.equal(result.capabilities.includes("ERC8183_ONCHAIN_WATCHER"), true);
  assert.equal(result.capabilities.includes("ERC8183_PROVIDER_STORAGE_DELIVERY"), true);
  assert.equal(result.capabilities.includes("ERC8183_BUYER_RELAY_DELIVERY"), false);
});

test("readiness score does not imply delivery success", () => {
  const now = 1_000;
  const provider = "0x0000000000000000000000000000000000000001";
  const readiness = buildReadinessChecklist({
    nowSeconds: now,
    candidate: { identity: "agent:control", name: "Grid", agentWallet: provider, categoryHypotheses: [{ category: "grid_trading" }] },
    probe: { reachable: true, callable: true, httpStatus: 200, card: { protocolVersion: "0.3.0", skills: [{ id: "negotiate" }, { id: "notify_funded", description: "notify_funded with job_id" }], description: "ERC-8183 grid ladder rungs" } },
    quoteProbe: { ok: true, accepted: true, quote: { terms: { price: "0", currency: "0x0000000000000000000000000000000000000002" }, quote_expires_at: now + 300 } },
    quoteVerification: { valid: true, signer: provider },
    expectedCategory: "grid_trading",
  });
  assert.equal(readiness.score, 100);
  assert.equal(readiness.discoveryConfidence, "high");
  assert.equal(readiness.deliveryHistory, "unverified");
  assert.match(readiness.scoreMeaning, /not a delivery-success prediction/);
});

test("Weigh-family correlation reports likely shared architecture from public metadata", () => {
  const card = { protocolVersion: "0.3.0", skills: [{ id: "negotiate" }, { id: "notify_funded" }] };
  const candidates = [1923, 1925, 1926].map((id) => ({ tokenId: String(id), identity: `97:0xregistry:${id}`, name: `weigh-${id}`, agentWallet: `0x${String(id).padStart(40, "0")}`, services: [{ endpoint: `https://weigh-${id}.onrender.com/.well-known/agent-card.json` }], probes: [{ endpoint: `https://weigh-${id}.onrender.com/.well-known/agent-card.json`, card, status: "reachable_callable_candidate" }], categoryHypotheses: [{ category: "grid_trading" }], hiring: { negotiationProbe: { quote: { price: "100000000000000000", currency: "0xtoken" } } } }));
  const report = correlateAgentFamily(candidates);
  assert.equal(report.classification, "SAME_IMPLEMENTATION_FAMILY_LIKELY");
  assert.equal(report.evidence.sameRenderInfrastructure, true);
  assert.equal(report.evidence.nearbyRegistrations, true);
});
