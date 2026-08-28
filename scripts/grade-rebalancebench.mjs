import path from "node:path";
import { contentHashes, nowIso } from "../src/core.mjs";
import { CATEGORIES, terminalStateFor } from "../src/domain.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { deriveQualificationFlags } from "../src/benchmark/framework.mjs";
import { buildAgentAdvantagePair, deriveVerifiedRunGates, termixCandidateQualification } from "../src/reference/health-evaluator.mjs";
import { rebalanceBaselineFields, REBALANCE_BENCHMARK_ID } from "../src/reference/rebalance-benchmark.mjs";
import { computeRebalanceGroundTruth, gradeRebalanceResponse, rangeKeeperStructuredView, rangeKeeperSubmissionFromOutput } from "../src/reference/rebalance-evaluator.mjs";
import { recordRangeDecision, summarizeRangeTrackRecord } from "../src/reference/range-track-record.mjs";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const stop = (reason, details = {}) => { console.log(JSON.stringify({ status: "blocked", reason, ...details }, null, 2)); process.exit(2); };

const definition = await store.loadJson("state/rebalancebench-v1.json", null);
if (!definition) stop("RebalanceBench v1 has not been frozen.");
const baseline = await store.loadJson("state/rebalance-baseline.json", null);
if (baseline?.status !== "submitted") stop("The human baseline is not sealed; nothing may be graded.");
if (contentHashes(baseline.rawSubmissionJson).sha256 !== baseline.evidence?.sha256) stop("The sealed human baseline no longer matches its evidence hash.");

const runs = await store.loadRuns();
const benchRuns = runs.filter((run) => run?.benchmark?.id === REBALANCE_BENCHMARK_ID);
const targetRunId = process.argv[2] || null;
const run = targetRunId ? benchRuns.find((item) => item.runId === targetRunId) : [...benchRuns].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
if (!run) stop("No RebalanceBench agent run is recorded yet; run npm run range:hire first.");
const runRecord = await store.loadJson(`state/rebalancebench-run-${run.runId}.json`, null);
const agentOutput = runRecord?.deliverable?.rawOutput ?? null;
if (!agentOutput) stop("The agent deliverable was not preserved for this run; it cannot be graded.", { runId: run.runId, terminalState: run.terminalState });
if (runRecord?.deliverable?.validation?.valid !== true) stop("The agent deliverable is recorded as invalid; it is preserved but not graded as a delivery.", { runId: run.runId, errors: runRecord?.deliverable?.validation?.errors });

// Both answers are sealed, so ground truth may now be computed. It derives from
// the frozen snapshot and the precommitted policy, never from either answer.
const truth = computeRebalanceGroundTruth(definition);
const truthEvidence = await store.saveEvidence({ kind: "rebalancebench_ground_truth", benchmarkId: REBALANCE_BENCHMARK_ID, runId: run.runId, groundTruth: truth, computedAt: nowIso() });

const humanSubmission = Object.fromEntries(rebalanceBaselineFields().map((field) => [field, baseline.submission[field]]));
const humanScore = gradeRebalanceResponse({ truth, submission: humanSubmission, structuredFor: null, responder: "human" });
const agentScore = gradeRebalanceResponse({ truth, submission: rangeKeeperSubmissionFromOutput(agentOutput), structuredFor: rangeKeeperStructuredView(agentOutput), responder: "canned_range_keeper" });
const [humanScoreEvidence, agentScoreEvidence] = await Promise.all([
  store.saveEvidence({ kind: "rebalancebench_score", responder: "human", runId: run.runId, score: humanScore }),
  store.saveEvidence({ kind: "rebalancebench_score", responder: "canned_range_keeper", runId: run.runId, score: agentScore }),
]);

const pair = buildAgentAdvantagePair({
  truth,
  human: humanScore,
  agent: agentScore,
  humanExecution: { elapsedMs: baseline.elapsedMs, cost: { serviceFeeRaw: "0", gasWei: "0", declaredOperatorCost: baseline.submission.operatorCost ?? null }, evidence: { sha256: baseline.evidence.sha256, keccak256: baseline.evidence.keccak256, attemptId: baseline.attemptId, score: humanScoreEvidence.sha256 } },
  agentExecution: { elapsedMs: runRecord.agentExecution.elapsedMs, cost: { serviceFeeRaw: runRecord.economics.serviceFeeRaw, gasWei: runRecord.economics.buyerGasWei, declaredOperatorCost: null }, evidence: { deliverableCid: runRecord.deliverable.cid, reference: runRecord.deliverable.reference, sha256: runRecord.deliverable.evidence?.sha256 ?? null, jobId: runRecord.jobId, score: agentScoreEvidence.sha256 } },
  taskLabel: `RebalanceBench v1 - PancakeSwap V3 ${definition.pool.token0.symbol}/${definition.pool.token1.symbol} range assessment`,
});
const pairEvidence = await store.saveEvidence({ kind: "agent_advantage_pair", runId: run.runId, pair });

const storedPairs = await store.loadJson("state/agent-advantage-pairs.json", { pairs: [] });
const priorQualifyingPairs = storedPairs.pairs.filter((item) => item.runId !== run.runId && item.termix?.termixCandidatePair === true && Date.parse(item.runCreatedAt || item.gradedAt || 0) < Date.parse(run.createdAt)).length;
// Rebalancing on PancakeSwap is a trading task, which is the category TermiX
// requires and Health Factor Monitoring cannot satisfy.
const termix = termixCandidateQualification({ pair, run, priorQualifyingPairs, category: "trading" });
const verified = deriveVerifiedRunGates({ run, pair, truth, deliverableValidation: runRecord.deliverable.validation, agentIdentity: run.agent.identity, providerAddress: runRecord.provider });

// Seed the track record. The outcome stays pending: scoring it now would use
// the same read that produced the decision.
const decision = recordRangeDecision({
  decisionId: `decision_${run.runId}`,
  benchmarkId: REBALANCE_BENCHMARK_ID,
  runId: run.runId,
  snapshot: definition.frozenEvidence.snapshot,
  deliverable: agentOutput,
});
const existingDecisions = await store.loadJson("state/range-decisions.json", { decisions: [] });
const decisions = [...existingDecisions.decisions.filter((item) => item.decisionId !== decision.decisionId), decision];
await store.saveJson("state/range-decisions.json", { schemaVersion: 1, kind: "range_keeper_decisions", updatedAt: nowIso(), decisions });
const trackRecord = summarizeRangeTrackRecord({ decisions });

const graded = {
  kind: "rebalancebench_grading",
  schemaVersion: 1,
  benchmarkId: REBALANCE_BENCHMARK_ID,
  benchmarkVersion: definition.version,
  venue: "PancakeSwap",
  pool: definition.pool.address,
  positionTokenId: definition.position.tokenId,
  referenceBlock: definition.referenceBlock,
  runId: run.runId,
  jobId: runRecord.jobId,
  identity: run.agent.identity,
  provider: runRecord.provider,
  evaluatorVersion: truth.evaluatorVersion,
  policyVersion: truth.policyVersion,
  groundTruth: { hash: truth.hashes.keccak256, evidence: truthEvidence },
  human: { score: humanScore, evidence: humanScoreEvidence, rawSubmission: baseline.rawSubmissionJson, elapsedMs: baseline.elapsedMs, sealedAt: baseline.submittedAt, attemptId: baseline.attemptId },
  agent: { score: agentScore, evidence: agentScoreEvidence, rawOutput: agentOutput, elapsedMs: runRecord.agentExecution.elapsedMs, deliverableCid: runRecord.deliverable.cid },
  pair,
  pairEvidence,
  termix,
  verifiedRun: verified,
  trackRecord,
  gradedAt: nowIso(),
};
// Feed the observed outcome back so public win/loss counts derive from the pair.
// Qualification is recomputed rather than edited: a run's evaluation status is
// only knowable once deterministic grading has actually happened, so the flags
// written at hire time were necessarily provisional.
const allRuns = await store.loadRuns();
const index = allRuns.findIndex((item) => item.runId === run.runId);
if (index >= 0) {
  const evaluation = {
    ...allRuns[index].evaluation,
    status: "completed",
    evaluator: truth.evaluatorVersion,
    metrics: { humanQualityScore: humanScore.qualityScore, agentQualityScore: agentScore.qualityScore, humanElapsedMs: baseline.elapsedMs, agentElapsedMs: runRecord.agentExecution.elapsedMs, qualityDelta: pair.comparison.qualityDelta, timeDeltaMs: pair.comparison.timeDeltaMs, fasterResponder: pair.comparison.fasterResponder, higherQualityResponder: pair.comparison.higherQualityResponder, agentAdvantage: pair.comparison.agentAdvantage },
  };
  const terminalState = terminalStateFor({ executionStatus: allRuns[index].agentExecution?.status, evaluationStatus: evaluation.status });
  const qualification = deriveQualificationFlags({
    runType: allRuns[index].runType,
    provenanceMode: allRuns[index].provenance?.mode || "LIVE_QUALIFYING",
    precommit: { manifestHash: allRuns[index].manifest?.hash },
    protocolJob: allRuns[index].protocolJob,
    agentOutput,
    agentDeliverableValidation: runRecord.deliverable.validation,
    controlOutput: { provenance: allRuns[index].controlExecution?.methodology || { independent: true } },
    evaluation,
    terminalState,
    termixEligiblePair: termix.termixCandidatePair,
    termixReason: termix.reason,
  });
  const priorVerified = allRuns.some((item) => item.runId !== run.runId && item.qualification?.isVerifiedRun === true);
  const verifiedRunNumber = qualification.completedBenchmark === true && verified.passed
    ? allRuns.filter((item) => item.runId !== run.runId && item.qualification?.isVerifiedRun === true).length + 1
    : null;
  allRuns[index] = {
    ...allRuns[index],
    evaluation,
    terminalState,
    qualification: { ...qualification, isVerifiedRun: verifiedRunNumber !== null, verifiedRunNumber, priorVerifiedRunsExist: priorVerified },
    grading: { evaluatorVersion: truth.evaluatorVersion, groundTruthHash: truth.hashes.keccak256, pairHash: pair.hashes.keccak256, humanScoreEvidence: humanScoreEvidence.sha256, agentScoreEvidence: agentScoreEvidence.sha256, verifiedRun: verified, termix, gradedAt: graded.gradedAt },
  };
  await store.saveJson("state/benchmark-runs.json", allRuns);
  graded.qualification = allRuns[index].qualification;
}
await store.saveJson(`state/rebalancebench-grading-${run.runId}.json`, graded);
const pairs = [...storedPairs.pairs.filter((item) => item.runId !== run.runId), { runId: run.runId, jobId: runRecord.jobId, benchmarkId: REBALANCE_BENCHMARK_ID, category: CATEGORIES.REBALANCING, venue: "PancakeSwap", taskCategory: "trading", task: pair.task, identity: run.agent.identity, pair, termix, verifiedRun: verified, runCreatedAt: run.createdAt, gradedAt: graded.gradedAt }];
await store.saveJson("state/agent-advantage-pairs.json", { schemaVersion: 1, kind: "canned_agent_advantage_pairs", updatedAt: nowIso(), pairs });

console.log(JSON.stringify({
  status: "rebalancebench_graded",
  runId: run.runId,
  jobId: runRecord.jobId,
  venue: "PancakeSwap",
  pool: definition.pool.address,
  positionTokenId: definition.position.tokenId,
  referenceBlock: definition.referenceBlock.number,
  evaluatorVersion: truth.evaluatorVersion,
  groundTruthHash: truth.hashes.keccak256,
  correctAction: truth.decisionTruth.correctAction,
  withoutAgent: { elapsedMs: baseline.elapsedMs, qualityScore: humanScore.qualityScore, declined: humanScore.declinedDimensions, serviceFeeRaw: "0" },
  withAgent: { elapsedMs: runRecord.agentExecution.elapsedMs, qualityScore: agentScore.qualityScore, declined: agentScore.declinedDimensions, serviceFeeRaw: runRecord.economics.serviceFeeRaw, gasWei: runRecord.economics.buyerGasWei },
  comparison: pair.comparison,
  termix: { termixCandidatePair: termix.termixCandidatePair, candidateNumber: termix.candidateNumber, qualifyingPairCount: termix.qualifyingPairCount, highValueCategorySatisfied: termix.highValueCategorySatisfied, trackComplete: termix.trackComplete, reason: termix.reason },
  verifiedRun: { classification: verified.classification, passed: verified.passed, failedGates: verified.failedGates },
  qualification: graded.qualification ? { qualifiesForPublicMetrics: graded.qualification.qualifiesForPublicMetrics, completedBenchmark: graded.qualification.completedBenchmark, isVerifiedRun: graded.qualification.isVerifiedRun, verifiedRunNumber: graded.qualification.verifiedRunNumber } : null,
  trackRecord: { totalDecisions: trackRecord.totalDecisions, settledDecisions: trackRecord.settledDecisions, hasEnoughObservations: trackRecord.hasEnoughObservations, rangeRetentionRate: trackRecord.rangeRetentionRate, statement: trackRecord.statement },
  artifacts: { grading: `state/rebalancebench-grading-${run.runId}.json`, pair: pairEvidence.sha256 },
}, null, 2));
