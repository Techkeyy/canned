import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, contentHashes } from "../src/core.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";
import { deriveQualificationFlags } from "../src/benchmark/framework.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { selectHiringAdapter } from "../src/marketplace/adapters.mjs";
import { REFERENCE_AGENT_SPECS, referenceAgentCandidate } from "../src/reference/constants.mjs";
import { buildHealthFactorDeliverable } from "../src/reference/health-factor.mjs";
import { createHealthBenchDefinition, healthBenchAgentInput, healthBenchProviderTask, validateHealthBenchAgentInput } from "../src/reference/health-benchmark.mjs";
import { buildAgentAdvantagePair, computeHealthBenchGroundTruth, deriveVerifiedRunGates, gradeHealthBenchResponse, healthGuardStructuredView, healthGuardSubmissionFromOutput, isNonAnswer, termixCandidateQualification } from "../src/reference/health-evaluator.mjs";

const account = "0xD164600c50B4F35593Cdc24F808cDA6DcFB1D645";
const vBNB = "0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c";
const vUSDT = "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A";
const comptroller = "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D";
const provider = "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7";
const registry = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const identity = `97:${registry}:2003`;

const snapshot = {
  protocol: "Venus", poolType: "core", source: "onchain", chainId: 97, account,
  asOfBlock: "127521666", blockHash: `0x${"25".repeat(32)}`, blockTimestamp: 1_787_831_197,
  readPlan: { contract: comptroller, method: "getAccountLiquidity(address)", contracts: { comptroller }, markets: [vBNB, vUSDT] },
  errorCode: "0", liquidityRaw: "2349997739537201063", shortfallRaw: "0",
  assetsIn: [vBNB, vUSDT], closeFactorMantissa: "500000000000000000", liquidationIncentiveMantissa: null,
  marketSnapshots: {
    [vBNB]: { vToken: vBNB, listed: true, collateralFactorMantissa: "700000000000000000", isComped: true, snapshotError: "0", vTokenBalanceRaw: "488808", borrowBalanceRaw: "0", exchangeRateMantissa: "10228955521805089557424780105", priceRaw: "600000000000000000000" },
    [vUSDT]: { vToken: vUSDT, listed: true, collateralFactorMantissa: "750000000000000000", isComped: true, snapshotError: "0", vTokenBalanceRaw: "0", borrowBalanceRaw: "100000", exchangeRateMantissa: "200776461931237", priceRaw: "500000000000000000000000000000" },
  },
  authoritative: true,
};

const definition = createHealthBenchDefinition({ snapshot, account });
const truth = computeHealthBenchGroundTruth(definition);
const agentDeliverable = buildHealthFactorDeliverable({ jobId: 700, task: healthBenchProviderTask(definition, { jobId: 700 }) });
const humanSubmission = { positionFacts: "i can barely understand what i'm seeing tbh", liquidationProximity: "close i think", changeExplanation: "no idea", boundedAction: "no idea", reasoningNotes: "no idea" };

function fakeRun(overrides = {}) {
  return {
    runType: RUN_TYPES.BENCHMARK,
    agent: { identity },
    benchmark: { id: "HealthBench_v1", category: CATEGORIES.HEALTH_FACTOR_MONITORING },
    terminalState: "completed",
    protocolJob: { funded: true, jobId: "700", provider, currentState: "COMPLETED", events: [{ event: "deliverable_observed", tx: { transactionHash: `0x${"aa".repeat(32)}` } }] },
    qualification: { hasRealPayment: true, hasActualDeliverable: true, hasPrecommit: true, hasOnchainProvenance: true, hasTerminalProtocolOutcome: true, isFixture: false, isInfrastructureSmokeTest: false, qualifiesForPublicMetrics: true, qualifiesForAgentTrackRecord: true, completedBenchmark: true },
    evaluation: { status: "completed" },
    createdAt: "2026-08-27T19:00:00.000Z",
    ...overrides,
  };
}

test("HealthBench ground truth is deterministic and treats getAccountLiquidity as authoritative", () => {
  const again = computeHealthBenchGroundTruth(definition);
  assert.equal(truth.hashes.keccak256, again.hashes.keccak256);
  assert.equal(truth.authoritative.shortfallRaw, "0");
  assert.equal(truth.authoritative.liquidatableAtSnapshot, false);
  assert.equal(truth.derived.debtValueRaw, "50000000000000000");
  assert.equal(truth.changeBaseline.correctChangeStatement, "not_enough_data");
  assert.equal(truth.boundedActionTruth.correctAction, "continue_monitoring_no_intervention");
});

test("the derived collateral reconstruction discrepancy is disclosed rather than silently reconciled", () => {
  assert.equal(truth.reconciliation.consistent, false);
  assert.deepEqual(truth.reconciliation.recordedCollateralFactorMantissa, ["700000000000000000"]);
  assert.equal(truth.reconciliation.impliedCollateralFactorMantissa, "800000000000000034");
  assert.match(truth.reconciliation.disclosure, /disclosed, not reconciled/);
});

test("the agent input is the exact frozen snapshot and carries no human answer or ground truth", () => {
  const input = healthBenchAgentInput(definition);
  assert.equal(validateHealthBenchAgentInput({ definition, input }).valid, true);
  assert.deepEqual(input.evidence.snapshot, definition.frozenEvidence.snapshot);
  const serialized = canonicalJson({ input, providerTask: healthBenchProviderTask(definition) });
  for (const value of Object.values(humanSubmission)) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes(truth.boundedActionTruth.correctAction), false);
  assert.equal(serialized.includes("groundTruth"), false);
});

test("a tampered snapshot is rejected as an agent input", () => {
  const tampered = { ...definition, frozenEvidence: { ...definition.frozenEvidence, snapshot: { ...snapshot, liquidityRaw: "1" } } };
  const result = validateHealthBenchAgentInput({ definition, input: healthBenchAgentInput(tampered) });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("agent_input_does_not_match_frozen_definition"));
});

test("declined answers are detected without punishing a real short answer", () => {
  assert.equal(isNonAnswer("no idea"), true);
  assert.equal(isNonAnswer("i don't know"), true);
  assert.equal(isNonAnswer(""), true);
  assert.equal(isNonAnswer("close i think"), false);
  assert.equal(isNonAnswer("No shortfall."), false);
});

test("human grading is deterministic, verbatim, and scores the answer exactly as submitted", () => {
  const first = gradeHealthBenchResponse({ truth, submission: humanSubmission, responder: "human" });
  const second = gradeHealthBenchResponse({ truth, submission: humanSubmission, responder: "human" });
  assert.equal(first.hashes.keccak256, second.hashes.keccak256);
  assert.deepEqual(first.declinedDimensions, ["changeExplanation", "boundedAction", "reasoningNotes"]);
  assert.equal(first.dimensions.find((item) => item.dimension === "liquidationProximity").rawValue, "close i think");
  assert.ok(first.unsupportedClaims.includes("liquidationProximity.no_unsupported_risk_claim"));
  assert.ok(first.qualityScore < 50);
});

test("agent grading uses the same rubric and the same ground truth as the human", () => {
  const submission = healthGuardSubmissionFromOutput(agentDeliverable.output);
  const score = gradeHealthBenchResponse({ truth, submission, structuredFor: healthGuardStructuredView(agentDeliverable.output), responder: "canned_health_guard" });
  const repeat = gradeHealthBenchResponse({ truth, submission, structuredFor: healthGuardStructuredView(agentDeliverable.output), responder: "canned_health_guard" });
  assert.equal(score.hashes.keccak256, repeat.hashes.keccak256);
  assert.equal(score.groundTruthHash, truth.hashes.keccak256);
  assert.deepEqual(score.declinedDimensions, []);
  assert.equal(score.unsupportedClaims.length, 0);
  assert.ok(score.qualityScore > 0);
});

test("a prose answer can earn every check that the structured deliverable earns", () => {
  const prose = {
    positionFacts: "Venus core pool: vBNB collateral, vUSDT borrow, liquidity 2349997739537201063 at block 127521666.",
    liquidationProximity: "No shortfall is reported, so the position is not liquidatable; liquidity is well above the debt.",
    changeExplanation: "There is no prior snapshot bound to this benchmark, so no change can be computed.",
    boundedAction: "Continue monitoring at the declared interval. No capital is moved and no transaction is sent.",
    reasoningNotes: "Read from Comptroller.getAccountLiquidity on a single testnet snapshot; a point in time read cannot prove future safety.",
  };
  const proseScore = gradeHealthBenchResponse({ truth, submission: prose, responder: "human" });
  assert.equal(proseScore.qualityScore, 100);
  assert.equal(proseScore.unsupportedClaims.length, 0);
});

test("the Agent Advantage pair reports time, cost, and quality on both sides without cherry-picking", () => {
  const human = gradeHealthBenchResponse({ truth, submission: humanSubmission, responder: "human" });
  const agent = gradeHealthBenchResponse({ truth, submission: healthGuardSubmissionFromOutput(agentDeliverable.output), structuredFor: healthGuardStructuredView(agentDeliverable.output), responder: "canned_health_guard" });
  const pair = buildAgentAdvantagePair({
    truth, human, agent,
    humanExecution: { elapsedMs: 306_762, cost: { serviceFeeRaw: "0", gasWei: "0" }, evidence: { sha256: "sha256:human" } },
    agentExecution: { elapsedMs: 60_000, cost: { serviceFeeRaw: "1000000000000000", gasWei: "1000" }, evidence: { sha256: "sha256:agent" } },
  });
  assert.equal(pair.rows.length, 3);
  assert.equal(pair.withoutAgent.cost.serviceFeeRaw, "0");
  assert.equal(pair.withAgent.cost.serviceFeeRaw, "1000000000000000");
  assert.equal(pair.comparison.fasterResponder, "agent");
  assert.equal(pair.comparison.higherQualityResponder, "agent");
  assert.match(pair.comparison.costNote, /paid no service fee/);
});

test("a faster but worse agent is reported as a loss, not an advantage", () => {
  const strongHuman = { qualityScore: 90, hashes: { keccak256: "0xhuman" } };
  const weakAgent = { qualityScore: 40, hashes: { keccak256: "0xagent" } };
  const pair = buildAgentAdvantagePair({
    truth, human: strongHuman, agent: weakAgent,
    humanExecution: { elapsedMs: 300_000, cost: {}, evidence: { sha256: "h" } },
    agentExecution: { elapsedMs: 1_000, cost: {}, evidence: { sha256: "a" } },
  });
  assert.equal(pair.comparison.fasterResponder, "agent");
  assert.equal(pair.comparison.higherQualityResponder, "human");
  assert.equal(pair.comparison.agentAdvantage, false);
});

test("Verified Run gates fail closed when any observation is missing", () => {
  const human = gradeHealthBenchResponse({ truth, submission: humanSubmission, responder: "human" });
  const agent = gradeHealthBenchResponse({ truth, submission: healthGuardSubmissionFromOutput(agentDeliverable.output), structuredFor: healthGuardStructuredView(agentDeliverable.output), responder: "canned_health_guard" });
  const pair = buildAgentAdvantagePair({ truth, human, agent, humanExecution: { elapsedMs: 1, cost: {}, evidence: { sha256: "h" } }, agentExecution: { elapsedMs: 1, cost: {}, evidence: { sha256: "a" } } });
  const validation = { valid: true, hasActualDeliverable: true };
  const passing = deriveVerifiedRunGates({ run: fakeRun(), pair, truth, deliverableValidation: validation, agentIdentity: identity, providerAddress: provider });
  assert.equal(passing.passed, true);
  assert.equal(passing.classification, "CANNED_VERIFIED_RUN");
  const notCompleted = deriveVerifiedRunGates({ run: fakeRun({ protocolJob: { ...fakeRun().protocolJob, currentState: "SUBMITTED" } }), pair, truth, deliverableValidation: validation, agentIdentity: identity, providerAddress: provider });
  assert.equal(notCompleted.passed, false);
  assert.ok(notCompleted.failedGates.includes("realErc8183Lifecycle"));
  const wrongProvider = deriveVerifiedRunGates({ run: fakeRun(), pair, truth, deliverableValidation: validation, agentIdentity: identity, providerAddress: account });
  assert.ok(wrongProvider.failedGates.includes("correctProvider"));
  const invalidDeliverable = deriveVerifiedRunGates({ run: fakeRun(), pair, truth, deliverableValidation: { valid: false, hasActualDeliverable: false }, agentIdentity: identity, providerAddress: provider });
  assert.ok(invalidDeliverable.failedGates.includes("realDeliverable"));
});

test("TermiX candidacy is mechanical and does not claim the track is complete", () => {
  const human = gradeHealthBenchResponse({ truth, submission: humanSubmission, responder: "human" });
  const agent = gradeHealthBenchResponse({ truth, submission: healthGuardSubmissionFromOutput(agentDeliverable.output), structuredFor: healthGuardStructuredView(agentDeliverable.output), responder: "canned_health_guard" });
  const pair = buildAgentAdvantagePair({ truth, human, agent, humanExecution: { elapsedMs: 306_762, cost: {}, evidence: { sha256: "h" } }, agentExecution: { elapsedMs: 60_000, cost: {}, evidence: { sha256: "a" } } });
  const termix = termixCandidateQualification({ pair, run: fakeRun(), priorQualifyingPairs: 0, category: CATEGORIES.HEALTH_FACTOR_MONITORING });
  assert.equal(termix.termixCandidatePair, true);
  assert.equal(termix.candidateNumber, 1);
  assert.equal(termix.highValueCategorySatisfied, false);
  assert.equal(termix.trackComplete, false);
  assert.match(termix.reason, /2 more qualifying pair/);
  const unpaid = termixCandidateQualification({ pair, run: fakeRun({ qualification: { ...fakeRun().qualification, hasRealPayment: false } }), priorQualifyingPairs: 0, category: CATEGORIES.HEALTH_FACTOR_MONITORING });
  assert.equal(unpaid.termixCandidatePair, false);
});

test("the public jobs-paid-for-and-graded metric derives from 0 to 1 and never counts controls or fixtures", () => {
  const candidate = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { providerAddress: provider, identityRecord: { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", quoteVerified: true }, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: true });
  const control = { runType: RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL, agent: { identity: "control" }, protocolJob: { funded: true, jobId: "675", currentState: "COMPLETED" }, qualification: { qualifiesForPublicMetrics: true, hasRealPayment: true } };
  const fixture = { runType: RUN_TYPES.FIXTURE, agent: { identity }, qualification: { qualifiesForPublicMetrics: true } };
  assert.equal(deriveMarketplaceMetrics({ candidates: [candidate], runs: [control, fixture] }).jobsPaidForAndGraded, 0);
  assert.equal(deriveMarketplaceMetrics({ candidates: [candidate], runs: [control, fixture, fakeRun()] }).jobsPaidForAndGraded, 1);
});

test("one qualifying benchmark reaches BENCHMARKED but never REPEATEDLY OBSERVED", () => {
  const candidate = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { providerAddress: provider, identityRecord: { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", quoteVerified: true }, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: true });
  const record = deriveAgentRecord(candidate, [fakeRun()]);
  assert.equal(record.status.label, "BENCHMARKED");
  assert.equal(record.trust.states.REPEATEDLY_OBSERVED, false);
  assert.equal(record.trust.benchmarkCount, 1);
  const twice = deriveAgentRecord(candidate, [fakeRun(), fakeRun({ createdAt: "2026-08-28T19:00:00.000Z" })]);
  assert.equal(twice.status.label, "REPEATEDLY OBSERVED");
});

test("reference hire readiness stays fail-closed until every condition is observed", () => {
  const identityRecord = { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", quoteVerified: true };
  const blocked = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { providerAddress: provider, identityRecord, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: false });
  assert.equal(blocked.selectionGate.readiness.ready, false);
  assert.equal(selectHiringAdapter(blocked, { chainId: 97 }).status, "blocked");
  assert.match(blocked.selectionGate.readiness.reason, /humanBaselineSealed/);
  const noQuote = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { providerAddress: provider, identityRecord: { ...identityRecord, quoteVerified: false }, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: true });
  assert.equal(selectHiringAdapter(noQuote, { chainId: 97 }).status, "blocked");
  const ready = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { providerAddress: provider, identityRecord, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: true });
  assert.equal(selectHiringAdapter(ready, { chainId: 97 }).status, "ready");
});

test("the reference agent is marked first-party and stays outside third-party diversity", () => {
  const candidate = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { providerAddress: provider, identityRecord: { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", quoteVerified: true }, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: true });
  const record = deriveAgentRecord(candidate, [fakeRun()]);
  assert.equal(record.origin, "CANNED_REFERENCE");
  assert.equal(record.reference, true);
  const thirdParty = [record].filter((item) => item.origin !== "CANNED_REFERENCE");
  assert.equal(thirdParty.length, 0);
});

test("an invalid or unbound deliverable cannot become a completed benchmark", () => {
  const flags = deriveQualificationFlags({
    runType: RUN_TYPES.BENCHMARK, provenanceMode: "LIVE_QUALIFYING",
    precommit: { manifestHash: "0xabc" },
    protocolJob: { funded: true, jobId: "700", currentState: "COMPLETED", events: [{ tx: { transactionHash: "0xdef" } }] },
    agentOutput: {}, agentDeliverableValidation: { valid: false, hasActualDeliverable: false, errors: ["deliverable_reference_block_mismatch"] },
    controlOutput: { provenance: { independent: true } }, evaluation: { status: "completed" }, terminalState: "completed",
  });
  assert.equal(flags.hasActualDeliverable, false);
  assert.equal(flags.qualifiesForPublicMetrics, false);
  assert.equal(flags.completedBenchmark, false);
});

test("deliverable evidence keeps a stable content hash for the exact submitted bytes", () => {
  const first = contentHashes(agentDeliverable.canonicalOutput);
  const second = contentHashes(agentDeliverable.canonicalOutput);
  assert.equal(first.sha256, second.sha256);
  assert.notEqual(contentHashes(`${agentDeliverable.canonicalOutput} `).sha256, first.sha256);
});
