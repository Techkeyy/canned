import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { contentHashes } from "../src/core.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { referenceFleetIdentityFailures } from "../src/deploy/readiness.mjs";
import { REFERENCE_AGENT_SPECS, referenceAgentCandidate, referenceNamespaceCollisions, implementedReferenceAgentCandidates } from "../src/reference/constants.mjs";
import { buildAgentAdvantagePair, deriveVerifiedRunGates, termixCandidateQualification } from "../src/reference/health-evaluator.mjs";
import { yieldBenchAgentInput, yieldBenchProviderTask, yieldContainsSecretAnswer, YIELD_BENCHMARK_ID } from "../src/reference/yield-benchmark.mjs";
import { computeYieldGroundTruth, gradeYieldResponse, yieldScoutStructuredView, yieldScoutSubmissionFromOutput } from "../src/reference/yield-evaluator.mjs";
import { buildYieldScoutDeliverable } from "../src/reference/yield-scout.mjs";
import { recordYieldDecision, settleYieldDecision, summarizeYieldTrackRecord } from "../src/reference/yield-track-record.mjs";

const registry = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const yieldIdentity = `97:${registry}:2034`;
const rangeIdentity = `97:${registry}:2005`;
const healthIdentity = `97:${registry}:2003`;
const yieldProvider = "0x99E5Fee06CF247F522119314980c58B8501d5684";
const rangeProvider = "0x0eAc2F4d215A416f891C43BFFa83329Ec249AD5a";
const healthProvider = "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7";

// The real frozen benchmark, so the binding assertions test what actually shipped.
const definition = JSON.parse(fs.readFileSync(path.resolve("data/state/yieldbench-v1.json"), "utf8"));
const truth = computeYieldGroundTruth(definition);
const deliverable = buildYieldScoutDeliverable({ jobId: 810, task: yieldBenchProviderTask(definition, { jobId: 810 }) });
const agentScore = gradeYieldResponse({ truth, submission: yieldScoutSubmissionFromOutput(deliverable.output), structuredFor: yieldScoutStructuredView(deliverable.output), responder: "canned_yield_scout" });

// The sealed human answer exactly as submitted.
const humanSubmission = {
  chosenOption: "USDT",
  moveDecision: "YES",
  yieldAdvantage: "$250 yearly",
  worthItAfterCosts: "compared to where it is currently, yes",
  risksAndTradeoffs: "just not much profit for the first year, due to movement costs",
  boundedAction: "move my money to usdt",
};
const humanScore = gradeYieldResponse({ truth, submission: humanSubmission, responder: "human" });

function yieldRun(overrides = {}) {
  return {
    runId: "run_yield", runType: RUN_TYPES.BENCHMARK,
    agent: { identity: yieldIdentity, name: "Canned Yield Scout", origin: "CANNED_REFERENCE" },
    benchmark: { id: YIELD_BENCHMARK_ID, category: CATEGORIES.YIELD_OPTIMISATION },
    terminalState: "completed",
    protocolJob: { funded: true, jobId: "810", provider: yieldProvider, currentState: "COMPLETED", events: [{ event: "deliverable_observed", tx: { transactionHash: `0x${"cc".repeat(32)}` } }] },
    qualification: { hasRealPayment: true, hasActualDeliverable: true, hasPrecommit: true, hasOnchainProvenance: true, hasTerminalProtocolOutcome: true, isFixture: false, isInfrastructureSmokeTest: false, qualifiesForPublicMetrics: true, qualifiesForAgentTrackRecord: true, completedBenchmark: true, isVerifiedRun: true, verifiedRunNumber: 3 },
    evaluation: { status: "completed", metrics: { agentAdvantage: true } },
    createdAt: "2026-08-30T16:28:00.000Z",
    ...overrides,
  };
}
const siblingRun = (id, job, benchmarkId, category, identity, provider, advantage, createdAt) => ({
  runId: id, runType: RUN_TYPES.BENCHMARK,
  agent: { identity, origin: "CANNED_REFERENCE" },
  benchmark: { id: benchmarkId, category },
  terminalState: "completed",
  protocolJob: { funded: true, jobId: job, provider, currentState: "COMPLETED", events: [{ event: "deliverable_observed", tx: { transactionHash: `0x${"ab".repeat(32)}` } }] },
  qualification: { hasRealPayment: true, hasActualDeliverable: true, hasPrecommit: true, hasOnchainProvenance: true, hasTerminalProtocolOutcome: true, isFixture: false, isInfrastructureSmokeTest: false, qualifiesForPublicMetrics: true, qualifiesForAgentTrackRecord: true, completedBenchmark: true, isVerifiedRun: true },
  evaluation: { status: "completed", metrics: { agentAdvantage: advantage } },
  createdAt,
});
const healthRun = siblingRun("run_health", "695", "HealthBench_v1", CATEGORIES.HEALTH_FACTOR_MONITORING, healthIdentity, healthProvider, false, "2026-08-27T18:38:00.000Z");
const rangeRun = siblingRun("run_range", "700", "RebalanceBench_v1", CATEGORIES.REBALANCING, rangeIdentity, rangeProvider, true, "2026-08-28T04:39:00.000Z");

const pair = buildAgentAdvantagePair({
  truth, human: humanScore, agent: agentScore,
  humanExecution: { elapsedMs: 197_312, cost: { serviceFeeRaw: "0", gasWei: "0" }, evidence: { sha256: "sha256:human" } },
  agentExecution: { elapsedMs: 57_146, cost: { serviceFeeRaw: "1000000000000000", gasWei: "60257000000000" }, evidence: { sha256: "sha256:agent", deliverableCid: "QmcGiEn" } },
  taskLabel: "YieldBench v1 - Venus stablecoin reallocation",
});

test("all three reference agents hold distinct identities, providers, and namespaces", () => {
  assert.equal(new Set([yieldIdentity, rangeIdentity, healthIdentity]).size, 3);
  assert.equal(new Set([yieldProvider.toLowerCase(), rangeProvider.toLowerCase(), healthProvider.toLowerCase()]).size, 3);
  assert.deepEqual(referenceNamespaceCollisions(), []);
  assert.deepEqual(referenceFleetIdentityFailures({
    "health-factor": { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", provider: healthProvider, origin: "CANNED_REFERENCE" },
    rebalancing: { agentId: 2005, registry, endpoint: "https://range-keeper.example/erc8183", provider: rangeProvider, origin: "CANNED_REFERENCE" },
    yield: { agentId: 2034, registry, endpoint: "https://yield-scout.example/erc8183", provider: yieldProvider, origin: "CANNED_REFERENCE" },
  }), []);
});

test("the frozen YieldBench still reproduces its own precommit", () => {
  const { precommit, ...rest } = definition;
  const recomputed = contentHashes(rest);
  assert.equal(recomputed.sha256, precommit.canonicalSha256);
  assert.equal(recomputed.keccak256, precommit.manifestKeccak256);
  assert.equal(precommit.canonicalSha256, "sha256:7384209581ecb332f87d863400da07154c70acf69a441bef49fb8f9f3943895b");
  assert.equal(precommit.manifestKeccak256, "0x2f5d2f3b45fb9c1169774acb89a29cb716e82613341371e6ceb284affa891783");
  assert.equal(definition.referenceBlock.number, "118529435");
  assert.equal(definition.executionBoundary.mainnetWriteAuthorized, false);
  assert.equal(definition.executionBoundary.marketDataAccess, "read_only");
});

test("the provider payload carries the frozen task and no distinctive human content", () => {
  const payload = JSON.stringify({ agentInput: yieldBenchAgentInput(definition), providerTask: yieldBenchProviderTask(definition) });
  const frozenText = JSON.stringify(definition);
  // Values that already appear in the frozen benchmark pre-date the answer and
  // are not leakage; the venue tickers are the obvious case.
  const distinctive = Object.values(humanSubmission).filter((value) => value.length > 3 && !frozenText.includes(value));
  assert.ok(distinctive.length > 0, "the human answer must contain something distinctive to test against");
  for (const value of distinctive) assert.equal(payload.includes(value), false, `${value} leaked`);
  assert.equal(yieldContainsSecretAnswer(yieldBenchAgentInput(definition)), false);
  // The winning ticker is a candidate the agent must be shown; the secret is
  // which option wins, not that the option exists. What must be absent is the
  // verdict itself and anything derived from it.
  assert.ok(payload.includes(truth.decisionTruth.correctAssetSymbol), "candidate options must be visible to the agent");
  for (const secret of [truth.hashes.keccak256, truth.decisionTruth.reason]) {
    assert.equal(payload.includes(String(secret)), false, `${String(secret).slice(0, 24)} leaked`);
  }
  for (const key of ["correctAction", "correctMarketKey", "moveRecommended", "recommendedAsset"]) {
    assert.equal(payload.includes(`"${key}"`), false, `${key} leaked`);
  }
  assert.deepEqual(yieldBenchAgentInput(definition).evidence.snapshot, definition.frozenEvidence.snapshot);
});

test("Yield Scout answered the frozen task and did not simply take the highest advertised rate on faith", () => {
  assert.equal(deliverable.output.position.asOfBlock, "118529435");
  assert.equal(deliverable.output.position.marketKey, definition.position.marketKey);
  assert.equal(deliverable.output.horizon.days, definition.horizonDays);
  assert.equal(deliverable.output.execution.capitalMoved, false);
  assert.equal(deliverable.output.execution.mode, "recommendation_only");
  assert.equal(deliverable.output.decision.action, truth.decisionTruth.correctAction);
  assert.equal(deliverable.output.decision.recommendedAsset, truth.decisionTruth.correctAssetSymbol);
  // Every candidate was scored against the policy, and rejections carry reasons.
  assert.equal(deliverable.output.comparison.length, definition.frozenEvidence.snapshot.markets.length);
  const rejected = deliverable.output.decision.rejectedCandidates;
  assert.ok(rejected.length > 0);
  for (const entry of rejected) assert.ok(entry.disqualifiers.length > 0);
  assert.equal(agentScore.qualityScore, 100);
});

test("grading is deterministic and the human answer is scored exactly as submitted", () => {
  const repeat = gradeYieldResponse({ truth, submission: humanSubmission, responder: "human" });
  assert.equal(repeat.hashes.keccak256, humanScore.hashes.keccak256);
  assert.equal(humanScore.dimensions.find((item) => item.dimension === "chosenOption").rawValue, "USDT");
  // The human picked a venue the frozen policy disqualified.
  assert.ok(humanScore.missedItems.includes("chosenOption.names_the_correct_option"));
  // Their move/no-move call was right and is credited in full.
  assert.equal(humanScore.dimensions.find((item) => item.dimension === "moveDecision").awarded, 18);
  assert.ok(humanScore.qualityScore > 0 && humanScore.qualityScore < agentScore.qualityScore);
});

test("the pair reports a genuine win on both time and quality", () => {
  assert.equal(pair.comparison.fasterResponder, "agent");
  assert.equal(pair.comparison.higherQualityResponder, "agent");
  assert.equal(pair.comparison.agentAdvantage, true);
  assert.equal(pair.withoutAgent.cost.serviceFeeRaw, "0");
  assert.equal(pair.withAgent.cost.serviceFeeRaw, "1000000000000000");
  // A slower agent would not win even at a perfect score.
  const slow = buildAgentAdvantagePair({ truth, human: humanScore, agent: agentScore, humanExecution: { elapsedMs: 1_000, cost: {}, evidence: { sha256: "h" } }, agentExecution: { elapsedMs: 900_000, cost: {}, evidence: { sha256: "a" } } });
  assert.equal(slow.comparison.agentAdvantage, false);
});

test("TermiX classifies this as candidate three without claiming the category itself", () => {
  const termix = termixCandidateQualification({ pair, run: yieldRun(), priorQualifyingPairs: 2, category: CATEGORIES.YIELD_OPTIMISATION });
  assert.equal(termix.termixCandidatePair, true);
  assert.equal(termix.candidateNumber, 3);
  assert.equal(termix.qualifyingPairCount, 3);
  // Yield optimisation is not trading, stock, or security.
  assert.equal(termix.highValueCategorySatisfied, false);
  assert.match(termix.reason, /three-pair minimum is met/);
  assert.match(termix.reason, /does not satisfy the trading, stock, or security category requirement/);
  // The portfolio requirement is met by the Rebalancing pair, not by this one.
  const trading = termixCandidateQualification({ pair, run: rangeRun, priorQualifyingPairs: 1, category: "trading" });
  assert.equal(trading.highValueCategorySatisfied, true);
});

test("Verified Run #3 gates pass only on a completed, bound, non-fixture run", () => {
  const validation = { valid: true, hasActualDeliverable: true };
  const passing = deriveVerifiedRunGates({ run: yieldRun(), pair, truth, deliverableValidation: validation, agentIdentity: yieldIdentity, providerAddress: yieldProvider });
  assert.equal(passing.passed, true);
  assert.equal(passing.classification, "CANNED_VERIFIED_RUN");
  assert.ok(deriveVerifiedRunGates({ run: yieldRun(), pair, truth, deliverableValidation: validation, agentIdentity: yieldIdentity, providerAddress: rangeProvider }).failedGates.includes("correctProvider"));
  assert.ok(deriveVerifiedRunGates({ run: yieldRun({ protocolJob: { ...yieldRun().protocolJob, currentState: "SUBMITTED" } }), pair, truth, deliverableValidation: validation, agentIdentity: yieldIdentity, providerAddress: yieldProvider }).failedGates.includes("realErc8183Lifecycle"));
  assert.ok(deriveVerifiedRunGates({ run: yieldRun(), pair, truth, deliverableValidation: { valid: false, hasActualDeliverable: false }, agentIdentity: yieldIdentity, providerAddress: yieldProvider }).failedGates.includes("realDeliverable"));
});

test("public metrics derive from two to three graded jobs with two wins and one loss", () => {
  const identityRecords = {
    "health-factor": { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", provider: healthProvider, quoteVerified: true, publicReadinessVerified: true },
    rebalancing: { agentId: 2005, registry, endpoint: "https://range-keeper.example/erc8183", provider: rangeProvider, quoteVerified: true, publicReadinessVerified: true },
    yield: { agentId: 2034, registry, endpoint: "https://yield-scout.example/erc8183", provider: yieldProvider, quoteVerified: true, publicReadinessVerified: true },
  };
  const candidates = implementedReferenceAgentCandidates({ allowLocalProbe: false, identityRecords, baselineSealedByKey: { "health-factor": true, rebalancing: true, yield: true } });
  const control = { runType: RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL, agent: { identity: "control" }, protocolJob: { funded: true, jobId: "675", currentState: "COMPLETED" }, qualification: { qualifiesForPublicMetrics: true, hasRealPayment: true } };
  const fixture = { runType: RUN_TYPES.FIXTURE, agent: { identity: yieldIdentity }, qualification: { qualifiesForPublicMetrics: true } };

  const afterTwo = deriveMarketplaceMetrics({ candidates, runs: [control, fixture, healthRun, rangeRun] });
  assert.equal(afterTwo.jobsPaidForAndGraded, 2);
  assert.equal(afterTwo.wins, 1);
  assert.equal(afterTwo.losses, 1);

  const afterThree = deriveMarketplaceMetrics({ candidates, runs: [control, fixture, healthRun, rangeRun, yieldRun()] });
  assert.equal(afterThree.jobsPaidForAndGraded, 3);
  assert.equal(afterThree.deliveries, 3);
  assert.equal(afterThree.qualifyingBenchmarks, 3);
  assert.equal(afterThree.wins, 2);
  assert.equal(afterThree.losses, 1);
  assert.equal(afterThree.categories.yield_optimisation.benchmarked, 1);
  assert.equal(afterThree.excludedFixtureAndControlRuns, 2);
});

test("Yield Scout reaches BENCHMARKED but never REPEATEDLY OBSERVED, and stays first-party", () => {
  const spec = REFERENCE_AGENT_SPECS.find((item) => item.key === "yield");
  const candidate = referenceAgentCandidate(spec, { providerAddress: yieldProvider, identityRecord: { agentId: 2034, registry, endpoint: "https://yield-scout.example/erc8183", quoteVerified: true }, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: true });
  const record = deriveAgentRecord(candidate, [yieldRun()]);
  assert.equal(record.status.label, "BENCHMARKED");
  assert.equal(record.trust.states.REPEATEDLY_OBSERVED, false);
  assert.equal(record.trust.deliveryCount, 1);
  assert.equal(record.trust.benchmarkCount, 1);
  assert.equal(record.origin, "CANNED_REFERENCE");
  assert.equal(record.reference, true);
  assert.equal([record].filter((item) => item.origin !== "CANNED_REFERENCE").length, 0);
});

test("the first yield recommendation is recorded pending and publishes no rate", () => {
  const decision = recordYieldDecision({ decisionId: "decision_run_yield", benchmarkId: YIELD_BENCHMARK_ID, runId: "run_yield", snapshot: definition.frozenEvidence.snapshot, deliverable: deliverable.output, observationHorizonDays: definition.horizonDays });
  assert.equal(decision.outcome, null);
  assert.equal(decision.recommendedAction, "MOVE");
  assert.equal(decision.referenceBlock.number, "118529435");
  assert.match(decision.outcomeNote, /Not yet observed/);
  const summary = summarizeYieldTrackRecord({ decisions: [decision] });
  assert.equal(summary.totalDecisions, 1);
  assert.equal(summary.settledDecisions, 0);
  assert.equal(summary.pendingDecisions, 1);
  assert.equal(summary.hasEnoughObservations, false);
  assert.equal(summary.advantagePersistenceRate, null);
  assert.match(summary.statement, /Not enough observations/);
  // It may only be settled against a strictly later read.
  assert.throws(() => settleYieldDecision({ decision, followUpSnapshot: definition.frozenEvidence.snapshot }), /later/);
});

test("no residual Commerce allowance is left behind by a completed hire", () => {
  const runRecordPath = path.resolve("data/state");
  const files = fs.readdirSync(runRecordPath).filter((name) => /^yieldbench-run-.*\.json$/.test(name));
  assert.ok(files.length > 0, "a YieldBench run record must exist");
  for (const file of files) {
    const record = JSON.parse(fs.readFileSync(path.join(runRecordPath, file), "utf8"));
    assert.equal(record.economics.allowanceAfterRaw, "0");
    assert.equal(record.deliverable.validation.valid, true);
    assert.equal(record.chainState, "COMPLETED");
  }
});
