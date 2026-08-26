import test from "node:test";
import assert from "node:assert/strict";
import { buildCandidateMatrix, buildProviderHistory, buildReadinessChecklist, deriveDeadlinePlan, detectSystemicFailure, rankCandidateMatrix } from "../src/discovery/readiness.mjs";

const quote = (provider, nowSeconds) => ({
  ok: true,
  accepted: true,
  quote: { terms: { price: "100", currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", quote_expires_at: nowSeconds + 600 }, estimated_completion_seconds: 60 },
  providerSignature: "0xsig",
  provider,
});

function card() {
  return { protocolVersion: "0.3.0", version: "1.0.0", skills: [
    { id: "negotiate", description: "grid trading negotiation with ERC-8183" },
    { id: "notify_funded", description: "notify_funded with job_id after funding" },
  ] };
}

test("paid timeout creates a deterministic provider cooldown", () => {
  const runs = [{ runId: "run-timeout", createdAt: "2026-01-01T00:00:00.000Z", agent: { identity: "agent:timeout" }, terminalState: "timeout", protocolJob: { funded: true, jobId: "1", currentState: "EXPIRED", events: [{ event: "notify_funded", accepted: true }] } }];
  const history = buildProviderHistory(runs, { cooldownSeconds: 3600 });
  const status = history["agent:timeout"];
  assert.equal(status.lastTimeout.jobId, "1");
  assert.equal(status.consecutiveFailures, 1);
  assert.equal(status.cooldownUntil, Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000) + 3600);
});

test("readiness ranking excludes a cooled-down provider", () => {
  const nowSeconds = 1_800_000_000;
  const providerA = "0x0000000000000000000000000000000000000001";
  const providerB = "0x0000000000000000000000000000000000000002";
  const candidate = (identity, provider, name) => ({ identity, tokenId: identity, name, chainId: 97, network: "bsc-testnet", agentWallet: provider, description: "grid trading ladder agent", categoryHypotheses: [{ category: "grid_trading", score: 3 }], services: [{ type: "A2A", endpoint: "https://agent.example" }] });
  const observation = (candidateValue) => ({ probe: { endpoint: "https://agent.example", reachable: true, callable: true, status: "reachable_callable_candidate", card: card() }, quoteProbe: quote(candidateValue.agentWallet, nowSeconds), quoteVerification: { valid: true, signer: candidateValue.agentWallet } });
  const failedRun = { runId: "run-old", createdAt: new Date((nowSeconds - 60) * 1000).toISOString(), agent: { identity: "agent:a" }, terminalState: "timeout", protocolJob: { funded: true, jobId: "2", currentState: "EXPIRED", events: [{ event: "notify_funded", accepted: true }] } };
  const candidates = [candidate("agent:a", providerA, "cooled"), candidate("agent:b", providerB, "ready")];
  const observations = { "agent:a": { ...observation(candidates[0]) }, "agent:b": { ...observation(candidates[1]) } };
  for (const item of candidates) observations[item.identity].readiness = buildReadinessChecklist({ candidate: item, ...observations[item.identity], expectedCategory: "grid_trading", nowSeconds });
  const matrix = rankCandidateMatrix(buildCandidateMatrix({ candidates, observations, providerHistory: buildProviderHistory([failedRun]), runs: [failedRun], nowSeconds }));
  assert.equal(matrix.find((item) => item.identity === "agent:a").eligible, false);
  assert.equal(matrix.find((item) => item.identity === "agent:b").eligible, true);
});

test("provider delivery deadline is separate from the benchmark observation window", () => {
  const plan = deriveDeadlinePlan({ nowSeconds: 1000, estimatedCompletionSeconds: 60, observationWindowSeconds: 300, disputeWindowSeconds: 120 });
  assert.equal(plan.providerDeliveryDeadlineSeconds, 720);
  assert.equal(plan.providerDeliveryDeadlineAtUnixSeconds, 1720);
  assert.equal(plan.benchmarkObservationWindowAtUnixSeconds, 1300);
});

test("two independent accepted-notification failures trigger the systemic guard", () => {
  const makeRun = (runId, identity) => ({ runId, agent: { identity }, terminalState: "timeout", protocolJob: { funded: true, jobId: runId, currentState: "EXPIRED", events: [{ event: "notify_funded", accepted: true }] } });
  const guard = detectSystemicFailure([makeRun("1", "agent:a"), makeRun("2", "agent:b")]);
  assert.equal(guard.triggered, true);
  assert.deepEqual(guard.independentProviders.sort(), ["agent:a", "agent:b"]);
});
