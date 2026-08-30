import path from "node:path";
import { contentHashes, nowIso } from "../src/core.mjs";
import { CATEGORIES, terminalStateFor } from "../src/domain.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { deriveQualificationFlags } from "../src/benchmark/framework.mjs";
import { buildAgentAdvantagePair, deriveVerifiedRunGates, termixCandidateQualification } from "../src/reference/health-evaluator.mjs";
import { yieldBaselineFields, YIELD_BENCHMARK_ID } from "../src/reference/yield-benchmark.mjs";
import { computeYieldGroundTruth, gradeYieldResponse, yieldScoutStructuredView, yieldScoutSubmissionFromOutput } from "../src/reference/yield-evaluator.mjs";
import { recordYieldDecision, summarizeYieldTrackRecord } from "../src/reference/yield-track-record.mjs";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const stop = (reason, details = {}) => { console.log(JSON.stringify({ status: "blocked", reason, ...details }, null, 2)); process.exit(2); };

const definition = await store.loadJson("state/yieldbench-v1.json", null);
if (!definition) stop("YieldBench v1 has not been frozen.");
const baseline = await store.loadJson("state/yield-baseline.json", null);
if (baseline?.status !== "submitted") stop("The human baseline is not sealed; nothing may be graded.");
if (contentHashes(baseline.rawSubmissionJson).sha256 !== baseline.evidence?.sha256) stop("The sealed human baseline no longer matches its evidence hash.");

const runs = await store.loadRuns();
const benchRuns = runs.filter((run) => run?.benchmark?.id === YIELD_BENCHMARK_ID);
const targetRunId = process.argv[2] || null;
const run = targetRunId ? benchRuns.find((item) => item.runId === targetRunId) : [...benchRuns].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
if (!run) stop("No YieldBench agent run is recorded yet; run npm run yield:hire first.");
const runRecord = await store.loadJson(`state/yieldbench-run-${run.runId}.json`, null);
const agentOutput = runRecord?.deliverable?.rawOutput ?? null;
if (!agentOutput) stop("The agent deliverable was not preserved for this run; it cannot be graded.", { runId: run.runId, terminalState: run.terminalState });
if (runRecord?.deliverable?.validation?.valid !== true) stop("The agent deliverable is recorded as invalid; it is preserved but not graded as a delivery.", { runId: run.runId, errors: runRecord?.deliverable?.validation?.errors });

// Both answers are sealed, so ground truth may now be computed. It derives from
// the frozen snapshot and the precommitted policy, never from either answer.
const truth = computeYieldGroundTruth(definition);
const truthEvidence = await store.saveEvidence({ kind: "yieldbench_ground_truth", benchmarkId: YIELD_BENCHMARK_ID, runId: run.runId, groundTruth: truth, computedAt: nowIso() });

const humanSubmission = Object.fromEntries(yieldBaselineFields().map((field) => [field, baseline.submission[field]]));
const humanScore = gradeYieldResponse({ truth, submission: humanSubmission, structuredFor: null, responder: "human" });
const agentScore = gradeYieldResponse({ truth, submission: yieldScoutSubmissionFromOutput(agentOutput), structuredFor: yieldScoutStructuredView(agentOutput), responder: "canned_yield_scout" });
const [humanScoreEvidence, agentScoreEvidence] = await Promise.all([
  store.saveEvidence({ kind: "yieldbench_score", responder: "human", runId: run.runId, score: humanScore }),
  store.saveEvidence({ kind: "yieldbench_score", responder: "canned_yield_scout", runId: run.runId, score: agentScore }),
]);

const pair = buildAgentAdvantagePair({
  truth,
  human: humanScore,
  agent: agentScore,
  humanExecution: { elapsedMs: baseline.elapsedMs, cost: { serviceFeeRaw: "0", gasWei: "0", declaredOperatorCost: baseline.submission.operatorCost ?? null }, evidence: { sha256: baseline.evidence.sha256, keccak256: baseline.evidence.keccak256, attemptId: baseline.attemptId, score: humanScoreEvidence.sha256 } },
  agentExecution: { elapsedMs: runRecord.agentExecution.elapsedMs, cost: { serviceFeeRaw: runRecord.economics.serviceFeeRaw, gasWei: runRecord.economics.buyerGasWei, declaredOperatorCost: null }, evidence: { deliverableCid: runRecord.deliverable.cid, reference: runRecord.deliverable.reference, sha256: runRecord.deliverable.evidence?.sha256 ?? null, jobId: runRecord.jobId, score: agentScoreEvidence.sha256 } },
  taskLabel: `YieldBench v1 - Venus stablecoin reallocation for ${definition.position.amount} ${definition.position.assetSymbol} over ${definition.horizonDays} days`,
});
const pairEvidence = await store.saveEvidence({ kind: "agent_advantage_pair", runId: run.runId, pair });

const storedPairs = await store.loadJson("state/agent-advantage-pairs.json", { pairs: [] });
const priorQualifyingPairs = storedPairs.pairs.filter((item) => item.runId !== run.runId && item.termix?.termixCandidatePair === true && Date.parse(item.runCreatedAt || item.gradedAt || 0) < Date.parse(run.createdAt)).length;
// Yield Optimisation is not itself the trading/stock/security category; the
// Range Keeper PancakeSwap pair already carries that requirement.
const termix = termixCandidateQualification({ pair, run, priorQualifyingPairs, category: CATEGORIES.YIELD_OPTIMISATION });
const verified = deriveVerifiedRunGates({ run, pair, truth, deliverableValidation: runRecord.deliverable.validation, agentIdentity: run.agent.identity, providerAddress: runRecord.provider });

// Seed the track record. The outcome stays pending: scoring it now would use
// the same read that produced the recommendation.
const decision = recordYieldDecision({
  decisionId: `decision_${run.runId}`,
  benchmarkId: YIELD_BENCHMARK_ID,
  runId: run.runId,
  snapshot: definition.frozenEvidence.snapshot,
  deliverable: agentOutput,
  observationHorizonDays: definition.horizonDays,
});
const existingDecisions = await store.loadJson("state/yield-decisions.json", { decisions: [] });
const decisions = [...existingDecisions.decisions.filter((item) => item.decisionId !== decision.decisionId), decision];
await store.saveJson("state/yield-decisions.json", { schemaVersion: 1, kind: "yield_scout_decisions", updatedAt: nowIso(), decisions });
const trackRecord = summarizeYieldTrackRecord({ decisions });

const graded = {
  kind: "yieldbench_grading",
  schemaVersion: 1,
  benchmarkId: YIELD_BENCHMARK_ID,
  benchmarkVersion: definition.version,
  venue: "Venus",
  position: definition.position,
  horizonDays: definition.horizonDays,
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

// Qualification is recomputed rather than edited: a run's evaluation status is
// only knowable once deterministic grading has actually happened.
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
  const verifiedRunNumber = qualification.completedBenchmark === true && verified.passed
    ? allRuns.filter((item) => item.runId !== run.runId && item.qualification?.isVerifiedRun === true).length + 1
    : null;
  allRuns[index] = {
    ...allRuns[index],
    evaluation,
    terminalState,
    qualification: { ...qualification, isVerifiedRun: verifiedRunNumber !== null, verifiedRunNumber },
    grading: { evaluatorVersion: truth.evaluatorVersion, groundTruthHash: truth.hashes.keccak256, pairHash: pair.hashes.keccak256, humanScoreEvidence: humanScoreEvidence.sha256, agentScoreEvidence: agentScoreEvidence.sha256, verifiedRun: verified, termix, gradedAt: graded.gradedAt },
  };
  await store.saveJson("state/benchmark-runs.json", allRuns);
  graded.qualification = allRuns[index].qualification;
}
await store.saveJson(`state/yieldbench-grading-${run.runId}.json`, graded);
const pairs = [...storedPairs.pairs.filter((item) => item.runId !== run.runId), { runId: run.runId, jobId: runRecord.jobId, benchmarkId: YIELD_BENCHMARK_ID, category: CATEGORIES.YIELD_OPTIMISATION, venue: "Venus", taskCategory: "yield", task: pair.task, identity: run.agent.identity, pair, termix, verifiedRun: verified, runCreatedAt: run.createdAt, gradedAt: graded.gradedAt }];
await store.saveJson("state/agent-advantage-pairs.json", { schemaVersion: 1, kind: "canned_agent_advantage_pairs", updatedAt: nowIso(), pairs });

// Portfolio view across every qualifying pair, so the TermiX minimum is derived
// rather than asserted by any single run.
const qualifying = pairs.filter((item) => item.termix?.termixCandidatePair === true);
const highValue = qualifying.filter((item) => ["trading", "stock", "security"].includes(String(item.taskCategory || "").toLowerCase()));
const portfolio = {
  qualifyingPairCount: qualifying.length,
  requiredPairCount: 3,
  highValueCategoryPairs: highValue.map((item) => ({ benchmarkId: item.benchmarkId, taskCategory: item.taskCategory })),
  highValueCategorySatisfied: highValue.length > 0,
  minimumPairedTaskRequirementSatisfied: qualifying.length >= 3 && highValue.length > 0,
  note: "Meeting the published minimum is not the same as winning the track.",
};

console.log(JSON.stringify({
  status: "yieldbench_graded",
  runId: run.runId,
  jobId: runRecord.jobId,
  venue: "Venus",
  position: `${definition.position.amount} ${definition.position.assetSymbol}`,
  horizonDays: definition.horizonDays,
  referenceBlock: definition.referenceBlock.number,
  evaluatorVersion: truth.evaluatorVersion,
  groundTruthHash: truth.hashes.keccak256,
  correctAction: truth.decisionTruth.correctAction,
  correctDestination: truth.decisionTruth.recommendedAssetSymbol ?? null,
  withoutAgent: { elapsedMs: baseline.elapsedMs, qualityScore: humanScore.qualityScore, declined: humanScore.declinedDimensions, serviceFeeRaw: "0" },
  withAgent: { elapsedMs: runRecord.agentExecution.elapsedMs, qualityScore: agentScore.qualityScore, declined: agentScore.declinedDimensions, serviceFeeRaw: runRecord.economics.serviceFeeRaw, gasWei: runRecord.economics.buyerGasWei },
  comparison: pair.comparison,
  termix: { termixCandidatePair: termix.termixCandidatePair, candidateNumber: termix.candidateNumber, highValueCategorySatisfied: termix.highValueCategorySatisfied, reason: termix.reason },
  termixPortfolio: portfolio,
  verifiedRun: { classification: verified.classification, passed: verified.passed, failedGates: verified.failedGates },
  qualification: graded.qualification ? { qualifiesForPublicMetrics: graded.qualification.qualifiesForPublicMetrics, completedBenchmark: graded.qualification.completedBenchmark, isVerifiedRun: graded.qualification.isVerifiedRun, verifiedRunNumber: graded.qualification.verifiedRunNumber } : null,
  trackRecord: { totalDecisions: trackRecord.totalDecisions, settledDecisions: trackRecord.settledDecisions, hasEnoughObservations: trackRecord.hasEnoughObservations, statement: trackRecord.statement },
  artifacts: { grading: `state/yieldbench-grading-${run.runId}.json`, pair: pairEvidence.sha256 },
}, null, 2));
