import path from "node:path";
import { contentHashes, nowIso } from "../src/core.mjs";
import { CATEGORIES } from "../src/domain.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { HEALTH_BENCHMARK_ID, humanBaselineFields } from "../src/reference/health-benchmark.mjs";
import { buildAgentAdvantagePair, computeHealthBenchGroundTruth, deriveVerifiedRunGates, gradeHealthBenchResponse, healthGuardStructuredView, healthGuardSubmissionFromOutput, termixCandidateQualification } from "../src/reference/health-evaluator.mjs";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const stop = (reason, details = {}) => { console.log(JSON.stringify({ status: "blocked", reason, ...details }, null, 2)); process.exit(2); };

const definition = await store.loadJson("state/healthbench-v1.json", null);
if (!definition) stop("HealthBench v1 has not been frozen.");
const baseline = await store.loadJson("state/health-baseline.json", null);
if (baseline?.status !== "submitted") stop("The human baseline is not sealed; nothing may be graded.");
const baselineManifest = await store.loadJson("evidence/healthbench-v1/human-baseline/manifest.json", null);
if (contentHashes(baseline.rawSubmissionJson).sha256 !== baselineManifest?.rawSubmission?.sha256) stop("The sealed human baseline no longer matches its evidence hash.");

const runs = await store.loadRuns();
const healthRuns = runs.filter((run) => run?.benchmark?.id === HEALTH_BENCHMARK_ID);
const targetRunId = process.argv[2] || null;
const run = targetRunId ? healthRuns.find((item) => item.runId === targetRunId) : [...healthRuns].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
if (!run) stop("No HealthBench agent run is recorded yet; run npm run health:hire first.");
const runRecord = await store.loadJson(`state/healthbench-run-${run.runId}.json`, null);
const agentOutput = runRecord?.deliverable?.rawOutput ?? null;
if (!agentOutput) stop("The agent deliverable was not preserved for this run; it cannot be graded.", { runId: run.runId, terminalState: run.terminalState });
if (runRecord?.deliverable?.validation?.valid !== true) stop("The agent deliverable is recorded as invalid; it is preserved but not graded as a delivery.", { runId: run.runId, errors: runRecord?.deliverable?.validation?.errors });

// Ground truth is computed from the frozen snapshot only, after both answers are sealed.
const truth = computeHealthBenchGroundTruth(definition);
const truthEvidence = await store.saveEvidence({ kind: "healthbench_ground_truth", benchmarkId: HEALTH_BENCHMARK_ID, runId: run.runId, groundTruth: truth, computedAt: nowIso() });

const humanSubmission = Object.fromEntries(humanBaselineFields().map((field) => [field, baseline.submission[field]]));
const humanScore = gradeHealthBenchResponse({ truth, submission: humanSubmission, structuredFor: null, responder: "human" });
const agentSubmission = healthGuardSubmissionFromOutput(agentOutput);
const agentScore = gradeHealthBenchResponse({ truth, submission: agentSubmission, structuredFor: healthGuardStructuredView(agentOutput), responder: "canned_health_guard" });
const [humanScoreEvidence, agentScoreEvidence] = await Promise.all([
  store.saveEvidence({ kind: "healthbench_score", responder: "human", runId: run.runId, score: humanScore }),
  store.saveEvidence({ kind: "healthbench_score", responder: "canned_health_guard", runId: run.runId, score: agentScore }),
]);

const pair = buildAgentAdvantagePair({
  truth,
  human: humanScore,
  agent: agentScore,
  humanExecution: { elapsedMs: baseline.elapsedMs, cost: { serviceFeeRaw: "0", gasWei: "0", declaredOperatorCost: baseline.submission.operatorCost ?? null }, evidence: { sha256: baselineManifest.rawSubmission.sha256, keccak256: baselineManifest.rawSubmission.keccak256, relativePath: baselineManifest.rawSubmission.relativePath, score: humanScoreEvidence.sha256 } },
  agentExecution: { elapsedMs: runRecord.agentExecution.elapsedMs, cost: { serviceFeeRaw: runRecord.economics.serviceFeeRaw, gasWei: runRecord.economics.buyerGasWei, declaredOperatorCost: null }, evidence: { deliverableUrl: runRecord.deliverable.url, sha256: runRecord.deliverable.evidence?.sha256 ?? null, jobId: runRecord.jobId, score: agentScoreEvidence.sha256 } },
});
const pairEvidence = await store.saveEvidence({ kind: "agent_advantage_pair", runId: run.runId, pair });

const storedPairs = await store.loadJson("state/agent-advantage-pairs.json", { pairs: [] });
const priorQualifyingPairs = storedPairs.pairs.filter((item) => item.runId !== run.runId && item.termix?.termixCandidatePair === true && Date.parse(item.runCreatedAt || item.gradedAt || 0) < Date.parse(run.createdAt)).length;
const termix = termixCandidateQualification({ pair, run, priorQualifyingPairs, category: CATEGORIES.HEALTH_FACTOR_MONITORING });
const verified = deriveVerifiedRunGates({ run, pair, truth, deliverableValidation: runRecord.deliverable.validation, agentIdentity: run.agent.identity, providerAddress: runRecord.provider });

const graded = {
  kind: "healthbench_grading",
  schemaVersion: 1,
  benchmarkId: HEALTH_BENCHMARK_ID,
  benchmarkVersion: definition.version,
  runId: run.runId,
  jobId: runRecord.jobId,
  referenceBlock: runRecord.referenceBlock,
  identity: run.agent.identity,
  provider: runRecord.provider,
  evaluatorVersion: truth.evaluatorVersion,
  groundTruth: { hash: truth.hashes.keccak256, evidence: truthEvidence },
  human: { score: humanScore, evidence: humanScoreEvidence, rawSubmission: baseline.rawSubmissionJson, elapsedMs: baseline.elapsedMs, sealedAt: baseline.submittedAt },
  agent: { score: agentScore, evidence: agentScoreEvidence, rawOutput: agentOutput, elapsedMs: runRecord.agentExecution.elapsedMs, deliverableUrl: runRecord.deliverable.url },
  pair,
  pairEvidence,
  termix,
  verifiedRun: verified,
  gradedAt: nowIso(),
};
await store.saveJson(`state/healthbench-grading-${run.runId}.json`, graded);

// Feed the observed outcome back into the run so public win/loss counts derive
// from the deterministic pair rather than being asserted anywhere.
const allRuns = await store.loadRuns();
const runIndex = allRuns.findIndex((item) => item.runId === run.runId);
if (runIndex >= 0) {
  allRuns[runIndex] = {
    ...allRuns[runIndex],
    evaluation: {
      ...allRuns[runIndex].evaluation,
      status: "completed",
      evaluator: truth.evaluatorVersion,
      metrics: { humanQualityScore: humanScore.qualityScore, agentQualityScore: agentScore.qualityScore, humanElapsedMs: baseline.elapsedMs, agentElapsedMs: runRecord.agentExecution.elapsedMs, qualityDelta: pair.comparison.qualityDelta, timeDeltaMs: pair.comparison.timeDeltaMs, fasterResponder: pair.comparison.fasterResponder, higherQualityResponder: pair.comparison.higherQualityResponder, agentAdvantage: pair.comparison.agentAdvantage },
    },
    grading: { evaluatorVersion: truth.evaluatorVersion, groundTruthHash: truth.hashes.keccak256, pairHash: pair.hashes.keccak256, humanScoreEvidence: humanScoreEvidence.sha256, agentScoreEvidence: agentScoreEvidence.sha256, verifiedRun: verified, termix, gradedAt: graded.gradedAt },
  };
  await store.saveJson("state/benchmark-runs.json", allRuns);
}
const pairs = [...storedPairs.pairs.filter((item) => item.runId !== run.runId), { runId: run.runId, jobId: runRecord.jobId, benchmarkId: HEALTH_BENCHMARK_ID, category: CATEGORIES.HEALTH_FACTOR_MONITORING, task: pair.task, identity: run.agent.identity, pair, termix, verifiedRun: verified, runCreatedAt: run.createdAt, gradedAt: graded.gradedAt }];
await store.saveJson("state/agent-advantage-pairs.json", { schemaVersion: 1, kind: "canned_agent_advantage_pairs", updatedAt: nowIso(), pairs });

console.log(JSON.stringify({
  status: "healthbench_graded",
  runId: run.runId,
  jobId: runRecord.jobId,
  evaluatorVersion: truth.evaluatorVersion,
  groundTruthHash: truth.hashes.keccak256,
  withoutAgent: { elapsedMs: baseline.elapsedMs, qualityScore: humanScore.qualityScore, declined: humanScore.declinedDimensions, serviceFeeRaw: "0" },
  withAgent: { elapsedMs: runRecord.agentExecution.elapsedMs, qualityScore: agentScore.qualityScore, declined: agentScore.declinedDimensions, serviceFeeRaw: runRecord.economics.serviceFeeRaw, gasWei: runRecord.economics.buyerGasWei },
  comparison: pair.comparison,
  termix: { termixCandidatePair: termix.termixCandidatePair, candidateNumber: termix.candidateNumber, highValueCategorySatisfied: termix.highValueCategorySatisfied, trackComplete: termix.trackComplete, reason: termix.reason },
  verifiedRun: { classification: verified.classification, passed: verified.passed, failedGates: verified.failedGates },
  artifacts: { grading: `state/healthbench-grading-${run.runId}.json`, pair: pairEvidence.sha256 },
}, null, 2));
