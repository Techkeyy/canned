import test from "node:test";
import assert from "node:assert/strict";
import { contentHashes } from "../src/core.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { referenceFleetIdentityFailures } from "../src/deploy/readiness.mjs";
import { REFERENCE_AGENT_SPECS, referenceAgentCandidate, implementedReferenceAgentCandidates } from "../src/reference/constants.mjs";
import { buildAgentAdvantagePair, deriveVerifiedRunGates, termixCandidateQualification } from "../src/reference/health-evaluator.mjs";
import { recordRangeDecision, settleRangeDecision, summarizeRangeTrackRecord } from "../src/reference/range-track-record.mjs";
import { createRebalanceBenchDefinition, rebalanceBenchAgentInput, rebalanceBenchProviderTask, rebalanceContainsSecretAnswer } from "../src/reference/rebalance-benchmark.mjs";
import { computeRebalanceGroundTruth, gradeRebalanceResponse, rangeKeeperStructuredView, rangeKeeperSubmissionFromOutput } from "../src/reference/rebalance-evaluator.mjs";
import { buildRangeKeeperDeliverable } from "../src/reference/range-keeper.mjs";

const registry = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const rangeIdentity = `97:${registry}:2005`;
const healthIdentity = `97:${registry}:2003`;
const rangeProvider = "0x0eAc2F4d215A416f891C43BFFa83329Ec249AD5a";
const healthProvider = "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7";
const pool = "0x172fcD41E0913e95784454622d1c3724f546f849";
const usdt = "0x55d398326f99059fF775485246999027B3197955";
const wbnb = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

function snapshot({ tick = -65654 } = {}) {
  return {
    protocol: "PancakeSwapV3", source: "onchain", chainId: 56, venue: "PancakeSwap",
    asOfBlock: "118445030", blockHash: `0x${"c5".repeat(32)}`, blockTimestamp: 1_787_861_334,
    readPlan: { chainId: 56, pool, blockTag: "118445030", authoritative: true, methods: ["slot0()"] },
    pool: { address: pool, token0: { address: usdt, symbol: "USDT", decimals: 18 }, token1: { address: wbnb, symbol: "WBNB", decimals: 18 }, fee: 100, feePercent: 0.01, tickSpacing: 1, liquidityRaw: "1", feeGrowthGlobal0X128: "1", feeGrowthGlobal1X128: "2" },
    slot0: { sqrtPriceX96: "2973775414390599107492001056", tick, observationIndex: 550, observationCardinality: 2400, unlocked: true },
    position: { tokenId: "7261944", tickLower: -65724, tickUpper: -65524, liquidity: "11964304490633407270133", feeGrowthInside0LastX128: "1", feeGrowthInside1LastX128: "2", tokensOwed0: "0", tokensOwed1: "0" },
    observations: { secondsAgos: [3600, 300, 0], tickCumulatives: ["-1", "-2", "-3"], meanTicks: [{ secondsAgo: 3600, meanTick: -65669 }, { secondsAgo: 300, meanTick: -65655 }, { secondsAgo: 0, meanTick: null, note: "reference point" }] },
    observationError: null, authoritative: true,
  };
}

const definition = createRebalanceBenchDefinition({ snapshot: snapshot() });
const truth = computeRebalanceGroundTruth(definition);
const deliverable = buildRangeKeeperDeliverable({ jobId: 700, task: rebalanceBenchProviderTask(definition, { jobId: 700 }) });
const agentScore = gradeRebalanceResponse({ truth, submission: rangeKeeperSubmissionFromOutput(deliverable.output), structuredFor: rangeKeeperStructuredView(deliverable.output), responder: "canned_range_keeper" });

// The sealed human answer as actually submitted, used verbatim.
const humanSubmission = { positionStatus: "yes it is", edgeProximity: "around 5 USDT per wbnb", marketMovement: "decently big", rebalanceDecision: "yeah i would", proposedRange: "700-720", risksAndTradeoffs: "none" };
const humanScore = gradeRebalanceResponse({ truth, submission: humanSubmission, responder: "human" });

function rangeRun(overrides = {}) {
  return {
    runId: "run_range", runType: RUN_TYPES.BENCHMARK,
    agent: { identity: rangeIdentity, name: "Canned Range Keeper", origin: "CANNED_REFERENCE" },
    benchmark: { id: "RebalanceBench_v1", category: CATEGORIES.REBALANCING },
    terminalState: "completed",
    protocolJob: { funded: true, jobId: "700", provider: rangeProvider, currentState: "COMPLETED", events: [{ event: "deliverable_observed", tx: { transactionHash: `0x${"bb".repeat(32)}` } }] },
    qualification: { hasRealPayment: true, hasActualDeliverable: true, hasPrecommit: true, hasOnchainProvenance: true, hasTerminalProtocolOutcome: true, isFixture: false, isInfrastructureSmokeTest: false, qualifiesForPublicMetrics: true, qualifiesForAgentTrackRecord: true, completedBenchmark: true, isVerifiedRun: true, verifiedRunNumber: 2 },
    evaluation: { status: "completed", metrics: { agentAdvantage: true } },
    createdAt: "2026-08-28T04:39:00.000Z",
    ...overrides,
  };
}
function healthRun(overrides = {}) {
  return {
    runId: "run_health", runType: RUN_TYPES.BENCHMARK,
    agent: { identity: healthIdentity, name: "Canned Health Guard", origin: "CANNED_REFERENCE" },
    benchmark: { id: "HealthBench_v1", category: CATEGORIES.HEALTH_FACTOR_MONITORING },
    terminalState: "completed",
    protocolJob: { funded: true, jobId: "695", provider: healthProvider, currentState: "COMPLETED", events: [{ event: "deliverable_observed", tx: { transactionHash: `0x${"aa".repeat(32)}` } }] },
    qualification: { hasRealPayment: true, hasActualDeliverable: true, hasPrecommit: true, hasOnchainProvenance: true, hasTerminalProtocolOutcome: true, isFixture: false, isInfrastructureSmokeTest: false, qualifiesForPublicMetrics: true, qualifiesForAgentTrackRecord: true, completedBenchmark: true, isVerifiedRun: true, verifiedRunNumber: 1 },
    evaluation: { status: "completed", metrics: { agentAdvantage: false } },
    createdAt: "2026-08-27T18:38:29.000Z",
    ...overrides,
  };
}

const pair = buildAgentAdvantagePair({
  truth, human: humanScore, agent: agentScore,
  humanExecution: { elapsedMs: 152_528, cost: { serviceFeeRaw: "0", gasWei: "0" }, evidence: { sha256: "sha256:human" } },
  agentExecution: { elapsedMs: 69_923, cost: { serviceFeeRaw: "1000000000000000", gasWei: "60257000000000" }, evidence: { sha256: "sha256:agent", deliverableCid: "QmQZku" } },
  taskLabel: "RebalanceBench v1 - PancakeSwap V3 USDT/WBNB range assessment",
});

test("the two reference agents hold distinct ERC-8004 identities and providers", () => {
  assert.notEqual(rangeIdentity, healthIdentity);
  assert.notEqual(rangeProvider.toLowerCase(), healthProvider.toLowerCase());
  assert.deepEqual(referenceFleetIdentityFailures({
    "health-factor": { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", provider: healthProvider, origin: "CANNED_REFERENCE" },
    rebalancing: { agentId: 2005, registry, endpoint: "https://range-keeper.example/erc8183", provider: rangeProvider, origin: "CANNED_REFERENCE" },
  }), []);
  const reused = referenceFleetIdentityFailures({
    "health-factor": { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183" },
    rebalancing: { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183" },
  });
  assert.ok(reused.some((entry) => entry.startsWith("shared_erc8004_identity")));
});

test("the provider payload carries the frozen task and no trace of the human answer", () => {
  const payload = JSON.stringify({ agentInput: rebalanceBenchAgentInput(definition), providerTask: rebalanceBenchProviderTask(definition) });
  for (const value of Object.values(humanSubmission)) assert.equal(payload.includes(value), false, `${value} leaked`);
  assert.equal(rebalanceContainsSecretAnswer(rebalanceBenchAgentInput(definition)), false);
  for (const secret of [truth.decisionTruth.correctAction, truth.rangeTruth.status, truth.hashes.keccak256]) {
    assert.equal(payload.includes(secret), false);
  }
  // The frozen snapshot must be the exact bytes the benchmark committed to.
  assert.deepEqual(rebalanceBenchAgentInput(definition).evidence.snapshot, definition.frozenEvidence.snapshot);
  const { precommit, ...rest } = definition;
  assert.equal(contentHashes(rest).keccak256, precommit.manifestKeccak256);
});

test("Range Keeper answered the frozen PancakeSwap task and held rather than rebalanced", () => {
  assert.equal(truth.decisionTruth.correctAction, "HOLD");
  assert.equal(deliverable.output.decision.action, "HOLD");
  assert.equal(deliverable.output.proposedRange, null);
  assert.equal(deliverable.output.position.asOfBlock, "118445030");
  assert.equal(deliverable.output.position.tokenId, "7261944");
  assert.equal(String(deliverable.output.position.pool).toLowerCase(), pool.toLowerCase());
  assert.equal(deliverable.output.execution.capitalMoved, false);
  assert.equal(agentScore.qualityScore, 100);
});

test("paired grading is deterministic and the human answer is graded as submitted", () => {
  const repeat = gradeRebalanceResponse({ truth, submission: humanSubmission, responder: "human" });
  assert.equal(repeat.hashes.keccak256, humanScore.hashes.keccak256);
  assert.equal(humanScore.dimensions.find((item) => item.dimension === "positionStatus").rawValue, "yes it is");
  // The human recommended rebalancing where the frozen policy says hold.
  assert.ok(humanScore.missedItems.includes("rebalanceDecision.decision_matches_policy"));
  // Proposing a legal-looking range while holding is correct is not penalised.
  assert.equal(humanScore.dimensions.find((item) => item.dimension === "proposedRange").awarded, 20);
  assert.ok(humanScore.qualityScore < agentScore.qualityScore);
});

test("the Agent Advantage pair reports a genuine agent win on both time and quality", () => {
  assert.equal(pair.comparison.fasterResponder, "agent");
  assert.equal(pair.comparison.higherQualityResponder, "agent");
  assert.equal(pair.comparison.agentAdvantage, true);
  assert.equal(pair.withoutAgent.cost.serviceFeeRaw, "0");
  assert.equal(pair.withAgent.cost.serviceFeeRaw, "1000000000000000");
  assert.ok(pair.comparison.timeDeltaMs < 0);
  // A slower agent would not win even with a perfect score.
  const slow = buildAgentAdvantagePair({ truth, human: humanScore, agent: agentScore, humanExecution: { elapsedMs: 1_000, cost: {}, evidence: { sha256: "h" } }, agentExecution: { elapsedMs: 900_000, cost: {}, evidence: { sha256: "a" } } });
  assert.equal(slow.comparison.agentAdvantage, false);
});

test("TermiX classifies this as candidate two and as the trading-category task", () => {
  const termix = termixCandidateQualification({ pair, run: rangeRun(), priorQualifyingPairs: 1, category: "trading" });
  assert.equal(termix.termixCandidatePair, true);
  assert.equal(termix.candidateNumber, 2);
  assert.equal(termix.qualifyingPairCount, 2);
  assert.equal(termix.highValueCategorySatisfied, true);
  assert.equal(termix.trackComplete, false);
  assert.match(termix.reason, /1 more qualifying pair/);
  assert.match(termix.reason, /satisfies the trading, stock, or security category requirement/);
  // Health Factor Monitoring must still report that it does not satisfy it.
  const health = termixCandidateQualification({ pair, run: healthRun(), priorQualifyingPairs: 0, category: CATEGORIES.HEALTH_FACTOR_MONITORING });
  assert.equal(health.highValueCategorySatisfied, false);
  assert.match(health.reason, /does not satisfy/);
  // Three pairs plus the category requirement is what completes the track.
  assert.equal(termixCandidateQualification({ pair, run: rangeRun(), priorQualifyingPairs: 2, category: "trading" }).trackComplete, true);
});

test("Verified Run #2 gates pass only on a completed, bound, non-fixture run", () => {
  const validation = { valid: true, hasActualDeliverable: true };
  const passing = deriveVerifiedRunGates({ run: rangeRun(), pair, truth, deliverableValidation: validation, agentIdentity: rangeIdentity, providerAddress: rangeProvider });
  assert.equal(passing.passed, true);
  assert.equal(passing.classification, "CANNED_VERIFIED_RUN");
  const wrongProvider = deriveVerifiedRunGates({ run: rangeRun(), pair, truth, deliverableValidation: validation, agentIdentity: rangeIdentity, providerAddress: healthProvider });
  assert.ok(wrongProvider.failedGates.includes("correctProvider"));
  const notSettled = deriveVerifiedRunGates({ run: rangeRun({ protocolJob: { ...rangeRun().protocolJob, currentState: "SUBMITTED" } }), pair, truth, deliverableValidation: validation, agentIdentity: rangeIdentity, providerAddress: rangeProvider });
  assert.ok(notSettled.failedGates.includes("realErc8183Lifecycle"));
  const invalid = deriveVerifiedRunGates({ run: rangeRun(), pair, truth, deliverableValidation: { valid: false, hasActualDeliverable: false }, agentIdentity: rangeIdentity, providerAddress: rangeProvider });
  assert.ok(invalid.failedGates.includes("realDeliverable"));
});

test("public metrics derive from one to two graded jobs with one win and one loss", () => {
  const identityRecords = {
    "health-factor": { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", provider: healthProvider, quoteVerified: true, publicReadinessVerified: true },
    rebalancing: { agentId: 2005, registry, endpoint: "https://range-keeper.example/erc8183", provider: rangeProvider, quoteVerified: true, publicReadinessVerified: true },
  };
  const candidates = implementedReferenceAgentCandidates({ allowLocalProbe: false, identityRecords, baselineSealedByKey: { "health-factor": true, rebalancing: true } });
  const control = { runType: RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL, agent: { identity: "control" }, protocolJob: { funded: true, jobId: "675", currentState: "COMPLETED" }, qualification: { qualifiesForPublicMetrics: true, hasRealPayment: true } };
  const fixture = { runType: RUN_TYPES.FIXTURE, agent: { identity: rangeIdentity }, qualification: { qualifiesForPublicMetrics: true } };

  const afterOne = deriveMarketplaceMetrics({ candidates, runs: [control, fixture, healthRun()] });
  assert.equal(afterOne.jobsPaidForAndGraded, 1);
  assert.equal(afterOne.wins, 0);
  assert.equal(afterOne.losses, 1);

  const afterTwo = deriveMarketplaceMetrics({ candidates, runs: [control, fixture, healthRun(), rangeRun()] });
  assert.equal(afterTwo.jobsPaidForAndGraded, 2);
  assert.equal(afterTwo.deliveries, 2);
  assert.equal(afterTwo.qualifyingBenchmarks, 2);
  assert.equal(afterTwo.wins, 1);
  assert.equal(afterTwo.losses, 1);
  assert.equal(afterTwo.categories.rebalancing.benchmarked, 1);
  assert.equal(afterTwo.categories.health_factor_monitoring.benchmarked, 1);
  // Controls and fixtures never contribute.
  assert.equal(afterTwo.excludedFixtureAndControlRuns, 2);
});

test("one benchmark reaches BENCHMARKED but never REPEATEDLY OBSERVED", () => {
  const spec = REFERENCE_AGENT_SPECS.find((item) => item.key === "rebalancing");
  const candidate = referenceAgentCandidate(spec, { providerAddress: rangeProvider, identityRecord: { agentId: 2005, registry, endpoint: "https://range-keeper.example/erc8183", quoteVerified: true }, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: true });
  const record = deriveAgentRecord(candidate, [rangeRun()]);
  assert.equal(record.status.label, "BENCHMARKED");
  assert.equal(record.trust.states.REPEATEDLY_OBSERVED, false);
  assert.equal(record.trust.deliveryCount, 1);
  assert.equal(record.trust.benchmarkCount, 1);
  assert.equal(record.origin, "CANNED_REFERENCE");
  assert.equal(record.reference, true);
  // Both reference agents stay outside third-party diversity.
  assert.equal([record].filter((item) => item.origin !== "CANNED_REFERENCE").length, 0);
});

test("the first track-record decision is recorded pending and publishes no rate", () => {
  const decision = recordRangeDecision({ decisionId: "decision_run_range", benchmarkId: "RebalanceBench_v1", runId: "run_range", snapshot: definition.frozenEvidence.snapshot, deliverable: deliverable.output });
  assert.equal(decision.outcome, null);
  assert.equal(decision.recommendedAction, "HOLD");
  assert.equal(decision.recommendedRange, null);
  assert.equal(decision.referenceBlock.number, "118445030");
  assert.match(decision.outcomeNote, /Not yet observed/);
  const summary = summarizeRangeTrackRecord({ decisions: [decision] });
  assert.equal(summary.totalDecisions, 1);
  assert.equal(summary.settledDecisions, 0);
  assert.equal(summary.pendingDecisions, 1);
  assert.equal(summary.hasEnoughObservations, false);
  assert.equal(summary.rangeRetentionRate, null);
  assert.match(summary.statement, /Not enough observations/);
  // It may only be settled against a strictly later read.
  assert.throws(() => settleRangeDecision({ decision, followUpSnapshot: definition.frozenEvidence.snapshot }), /must be later/);
});
