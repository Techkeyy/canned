import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveAgentRecord, deriveTrustStates, compareAgents } from "../src/marketplace/model.mjs";
import { buildHomepageEvidence, buildMarketplace } from "../src/marketplace/public-api.mjs";
import { loadGradingArtifact } from "../src/marketplace/termix-evidence.mjs";
import { protocolCapabilities, selectHiringAdapter } from "../src/marketplace/adapters.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { assessBnbEligibility, TESTNET_CONFIRMATION_FLAG } from "../src/marketplace/eligibility.mjs";
import { baselineSealedFromDerivedEvidence } from "../src/marketplace/hireability.mjs";

const identity = "97:0xabc:2001";
const candidate = {
  identity,
  chainId: 97,
  network: "bsc-testnet",
  name: "Evidence Agent",
  description: "A bounded rebalancing agent.",
  categoryHypotheses: [{ category: "rebalancing", label: "Rebalancing", confidence: "high", signals: ["range"] }],
  supports: { a2a: true, erc8183: true, x402: true, b402: false, mcp: false },
  services: [{ type: "A2A", endpoint: "https://example.test/a2a" }],
  probes: [{ type: "A2A", reachable: true, callable: true, endpoint: "https://example.test/a2a" }],
  selectionGate: { readiness: { quoteVerified: true, protocolCompatibility: true, ready: true } },
  hiring: { price: "10000000000000000", currency: "U", mechanism: "A2A negotiation + ERC-8183 buyer job" },
};

test("resolved BSC Testnet eligibility no longer emits the historical confirmation flag", () => {
  const assessment = assessBnbEligibility({ identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2001" });
  assert.equal(assessment.status, "BNB_ELIGIBLE");
  assert.equal(assessment.eligibleForPublicShelf, true);
  assert.equal(assessment.confirmationRequired, null);
  assert.equal(TESTNET_CONFIRMATION_FLAG, "FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED");
});

test("trust ladder distinguishes a verified quote from an observed delivery", () => {
  const trust = deriveTrustStates(candidate, []);
  assert.deepEqual(trust.reached, ["LISTED", "ENDPOINT_VERIFIED", "QUOTE_VERIFIED"]);
  assert.equal(trust.deliveryCount, 0);
  assert.equal(trust.sampleSize, 0);
});

test("zero is preserved while unknown comparison fields remain null", () => {
  const run = { runId: "run-1", runType: "BENCHMARK", createdAt: "2026-08-27T00:00:00Z", agent: { identity }, protocolJob: { funded: true, jobId: 701 }, qualification: { hasActualDeliverable: true, qualifiesForAgentTrackRecord: true }, evaluation: { metrics: { agentAdvantage: false } }, terminalState: "completed" };
  const record = deriveAgentRecord(candidate, [run]);
  assert.equal(record.trust.deliveryCount, 1);
  assert.equal(record.trust.benchmarkCount, 1);
  const comparison = compareAgents([record], [identity], "rebalancing");
  assert.equal(comparison.agents[0].observedDeliveries, 1);
  assert.equal(comparison.agents[0].failureRate, 0);
  assert.equal(comparison.agents[0].cost, "10000000000000000");
});

test("Weigh-family candidates remain visible but cannot be newly hired", () => {
  const weigh = { ...candidate, identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:1926" };
  const record = deriveAgentRecord(weigh, []);
  assert.equal(record.quarantine.active, true);
  assert.equal(record.quarantine.permanentBlacklist, false);
  assert.equal(selectHiringAdapter(weigh).status, "blocked");
});

test("protocol metadata separates advertised, Canned-verified, and used", () => {
  const capabilities = protocolCapabilities(candidate, []);
  assert.equal(capabilities.find((item) => item.protocol === "ERC-8183").advertised, true);
  assert.equal(capabilities.find((item) => item.protocol === "ERC-8183").cannedVerified, true);
  assert.equal(capabilities.find((item) => item.protocol === "ERC-8183").successfullyUsed, false);
});

test("fixture and infrastructure control runs do not enter marketplace metrics", () => {
  const runs = [
    { runType: "FIXTURE", agent: { identity: "fixture:1" } },
    { runType: "INFRASTRUCTURE_PROTOCOL_CONTROL", agent: { identity: "CANNED_PROTOCOL_CONTROL" }, protocolJob: { funded: true, jobId: 675 } },
    { runType: "BENCHMARK", agent: { identity }, protocolJob: { funded: true, jobId: 702 }, qualification: { qualifiesForPublicMetrics: false }, terminalState: "timeout" },
  ];
  const metrics = deriveMarketplaceMetrics({ candidates: [candidate], runs });
  assert.equal(metrics.paidAttempts, 1);
  assert.equal(metrics.jobsPaidForAndGraded, 0);
  assert.equal(metrics.excludedFixtureAndControlRuns, 2);
  assert.equal(metrics.categories.rebalancing.tested, 1);
});

test("the default marketplace shelf separates endpoint-verified agents from discovery", () => {
  const verified = { ...candidate, identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2001" };
  const discovered = { ...candidate, identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2002", probes: [] };
  const market = buildMarketplace({ candidates: [verified, discovered], runs: [] });
  assert.equal(market.verifiedAgents.length, 1);
  assert.equal(market.discoveredAgents.length, 1);
  assert.equal(market.agents[0].identity, verified.identity);
  assert.equal(market.discoveredAgents[0].availability.reachable, false);
  assert.equal(market.discoveredAgents[0].availability.lastCheckedAt, null);
  assert.equal(market.categories.find((item) => item.category === "rebalancing").listed, 1);
});

test("hireability counts remain separate from verification counts", () => {
  const verified = { ...candidate, identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2001" };
  const discovered = { ...candidate, identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2002", probes: [] };
  const market = buildMarketplace({ candidates: [verified, discovered], runs: [] });
  assert.deepEqual(market.counts, { listed: 1, verified: 1, discovered: 1, pendingEligibility: 0, hireable: 0, verifiedNotHireable: 1, unavailable: 0 });
});

test("public homepage exposes derived hireable-agent count", () => {
  const homepage = buildHomepageEvidence({
    agents: [{ hire: { ready: false, publicReady: true }, category: { claimedCategory: null }, trust: { states: { BENCHMARKED: false } } }],
    discoveredCount: 2,
  });
  assert.equal(homepage.totals.agentsListed, 1);
  assert.equal(homepage.totals.discoveredAgents, 2);
  assert.equal(homepage.totals.hireableAgents, 1);
});

test("public hire is derived from checks, not asserted", () => {
  const qualified = {
    ...candidate,
    identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2001",
    agentWallet: "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7",
    ownerAddress: "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7",
    reference: true,
    services: [{ type: "HTTP task API", endpoint: "https://example.test/erc8183" }],
    hiring: { price: "1000000000000000", currency: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" },
  };
  const deliveredRun = {
    runId: "run-1",
    runType: "BENCHMARK",
    createdAt: "2026-08-27T00:00:00Z",
    agent: { identity: qualified.identity },
    protocolJob: { funded: true, jobId: 701 },
    terminalState: "completed",
  };
  const agent = buildMarketplace({ candidates: [qualified], runs: [deliveredRun] }).agents[0];
  assert.equal(agent.hire.ready, true);
  assert.equal(agent.hire.publicReady, true);
  assert.equal(agent.hire.status, "ready");
  assert.equal(agent.hire.statusLabel, "HIREABLE");
  assert.equal(agent.hire.operatorReady, true);
  assert.ok(Array.isArray(agent.hire.checks) && agent.hire.checks.every((item) => item.pass));

  const unqualified = { ...candidate, identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2001" };
  const blocked = buildMarketplace({ candidates: [unqualified], runs: [] }).agents[0];
  assert.equal(blocked.hire.ready, false);
  assert.equal(blocked.hire.publicReady, false);
  assert.equal(blocked.hire.status, "unavailable");
  assert.equal(blocked.hire.statusLabel, "VERIFIED — NOT CURRENTLY HIREABLE");
  assert.match(blocked.hire.reason, /provider_resolved/i);
});

test("only a completed funded verified benchmark can reconstruct an omitted baseline gate", () => {
  const identity = "97:0xabc:2003";
  const verifiedRun = { runType: "BENCHMARK", agent: { identity }, protocolJob: { funded: true, currentState: "COMPLETED" }, terminalState: "completed", evaluation: { status: "completed" }, qualification: { isVerifiedRun: true } };
  assert.equal(baselineSealedFromDerivedEvidence({ identity, runs: [verifiedRun] }), true);
  assert.equal(baselineSealedFromDerivedEvidence({ identity, runs: [{ ...verifiedRun, qualification: { isVerifiedRun: false } }] }), false);
  assert.equal(baselineSealedFromDerivedEvidence({ identity, runs: [{ ...verifiedRun, runType: "FIXTURE" }] }), false);
  assert.equal(baselineSealedFromDerivedEvidence({ explicitBaseline: true, identity: "unknown", runs: [] }), true);
});

test("TermiX grading loader resolves the legitimate artifact by run and benchmark", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "canned-termix-"));
  try {
    await writeFile(path.join(stateDir, "rebalancebench-grading-run_range-1.json"), JSON.stringify({
      runId: "run_range-1",
      benchmarkId: "RebalanceBench_v1",
      human: { rawSubmission: "human answer" },
      agent: { rawOutput: { answer: "agent answer" } },
    }));
    await writeFile(path.join(stateDir, "healthbench-grading-run_range-1.json"), JSON.stringify({
      runId: "run_range-1",
      benchmarkId: "HealthBench_v1",
    }));
    const resolved = await loadGradingArtifact({ stateDir, runId: "run_range-1", benchmarkId: "RebalanceBench_v1" });
    assert.equal(resolved.name, "rebalancebench-grading-run_range-1.json");
    assert.equal(resolved.artifact.agent.rawOutput.answer, "agent answer");
    assert.equal((await loadGradingArtifact({ stateDir, runId: "run_missing", benchmarkId: "YieldBench_v1" })), null);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
