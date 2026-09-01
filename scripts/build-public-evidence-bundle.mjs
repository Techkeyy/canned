import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadGradingArtifact } from "../src/marketplace/termix-evidence.mjs";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const stateDir = path.join(dataDir, "state");

async function loadJson(name, fallback = null) {
  try { return JSON.parse(await readFile(path.join(stateDir, name), "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function sha256File(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

function publicCost(cost = null) {
  if (!cost || typeof cost !== "object") return null;
  return {
    declaredOperatorCost: cost.declaredOperatorCost ?? null,
    serviceFeeRaw: cost.serviceFeeRaw ?? null,
    serviceFeeTokenDecimals: cost.serviceFeeTokenDecimals ?? null,
    networkGasWei: cost.networkGasWei ?? null,
  };
}

function publicScore(score = null) {
  if (!score || typeof score !== "object") return null;
  return {
    qualityScore: score.qualityScore ?? null,
    awarded: score.awarded ?? null,
    available: score.available ?? null,
    benchmarkId: score.benchmarkId ?? null,
    evaluatorVersion: score.evaluatorVersion ?? null,
    completeness: score.completeness ?? null,
    dimensions: Array.isArray(score.dimensions) ? score.dimensions.map((dimension) => ({
      dimension: dimension.dimension ?? null,
      awarded: dimension.awarded ?? null,
      available: dimension.available ?? null,
      rawValue: dimension.rawValue ?? null,
    })) : [],
  };
}

function publicEvidence(evidence = null) {
  if (!evidence || typeof evidence !== "object") return null;
  return {
    sha256: evidence.sha256 ?? null,
    keccak256: evidence.keccak256 ?? null,
    durablePublicStorage: evidence.durablePublicStorage ?? null,
    deliverableCid: evidence.deliverableCid ?? null,
    score: evidence.score ?? null,
  };
}

function publicSide(side = null, rawOutput = null, score = null) {
  if (!side || typeof side !== "object") return null;
  return {
    elapsedMs: side.elapsedMs ?? null,
    qualityScore: side.qualityScore ?? null,
    responder: side.responder ?? null,
    cost: publicCost(side.cost),
    evidence: publicEvidence(side.evidence),
    rawOutput,
    score: publicScore(score),
  };
}

function publicRun(run) {
  const cost = (entry) => publicCost(entry?.cost);
  const events = (run.protocolJob?.events || []).filter((event) => event?.tx?.transactionHash).map((event) => ({
    event: event.event ?? null,
    createdAt: event.createdAt ?? null,
    status: event.snapshot?.status ?? null,
    transactionHash: event.tx.transactionHash,
  }));
  return {
    schemaVersion: run.schemaVersion ?? 1,
    kind: run.kind ?? null,
    runId: run.runId ?? null,
    runType: run.runType ?? null,
    grading: Boolean(run.grading),
    createdAt: run.createdAt ?? null,
    terminalState: run.terminalState ?? null,
    agent: run.agent ? { identity: run.agent.identity ?? null, name: run.agent.name ?? null, category: run.agent.category ?? null, origin: run.agent.origin ?? null } : null,
    benchmark: run.benchmark ? { id: run.benchmark.id ?? null, version: run.benchmark.version ?? null, category: run.benchmark.category ?? null, task: run.benchmark.task ?? null } : null,
    agentExecution: run.agentExecution ? {
      status: run.agentExecution.status ?? null,
      elapsedMs: run.agentExecution.elapsedMs ?? null,
      timing: run.agentExecution.timing ?? null,
      cost: cost(run.agentExecution),
      deliverableUrl: run.agentExecution.deliverableUrl ?? null,
      deliverableValidation: run.agentExecution.deliverableValidation ? {
        valid: run.agentExecution.deliverableValidation.valid ?? null,
        hasActualDeliverable: run.agentExecution.deliverableValidation.hasActualDeliverable ?? null,
        reason: run.agentExecution.deliverableValidation.reason ?? null,
      } : null,
      evidence: publicEvidence(run.agentExecution.evidence),
    } : null,
    controlExecution: run.controlExecution ? { status: run.controlExecution.status ?? null, elapsedMs: run.controlExecution.elapsedMs ?? null, cost: cost(run.controlExecution) } : null,
    evaluation: run.evaluation ? { status: run.evaluation.status ?? null, evaluator: run.evaluation.evaluator ?? null, metrics: run.evaluation.metrics ?? null, reason: run.evaluation.reason ?? null } : null,
    manifest: run.manifest ? { hash: run.manifest.hash ?? null, level: run.manifest.level ?? null, offchainContentHash: run.manifest.offchainContentHash ?? null, publicPrecommitAnchor: run.manifest.publicPrecommitAnchor ?? null } : null,
    protocolJob: run.protocolJob ? {
      protocol: run.protocolJob.protocol ?? null,
      network: run.protocolJob.network ?? null,
      paymentToken: run.protocolJob.paymentToken ?? null,
      jobId: run.protocolJob.jobId ?? null,
      funded: run.protocolJob.funded ?? null,
      currentState: run.protocolJob.currentState ?? null,
      state: run.protocolJob.state ?? null,
      agentIdentity: run.protocolJob.agentIdentity ?? null,
      provider: run.protocolJob.provider ?? null,
      precommitHash: run.protocolJob.precommitHash ?? null,
      events,
    } : null,
    provenance: run.provenance ? { fixture: run.provenance.fixture ?? null, infrastructureSmokeTest: run.provenance.infrastructureSmokeTest ?? null, mode: run.provenance.mode ?? null } : null,
    qualification: run.qualification ?? null,
  };
}

const stored = await loadJson("agent-advantage-pairs.json", { pairs: [] });
const runs = await loadJson("benchmark-runs.json", []);
const pairs = [];
const sanitizedGradings = [];
for (const entry of stored.pairs || []) {
  const gradingRecord = await loadGradingArtifact({ stateDir, runId: entry.runId, benchmarkId: entry.benchmarkId });
  if (!gradingRecord) throw new Error(`No canonical grading artifact for ${entry.runId}/${entry.benchmarkId}`);
  const grading = gradingRecord.artifact;
  const run = runs.find((candidate) => candidate.runId === entry.runId) || null;
  const sourceArtifactSha256 = await sha256File(path.join(stateDir, gradingRecord.name));
  const sourcePairSha256 = grading.pairEvidence?.sha256 || grading.pair?.hashes?.sha256 || null;
  const withoutAgent = publicSide(grading.pair?.withoutAgent, grading.human?.rawSubmission ?? null, grading.human?.score);
  const withAgent = publicSide(grading.pair?.withAgent, grading.agent?.rawOutput ?? null, grading.agent?.score);
  withAgent.deliverableCid = grading.agent?.deliverableCid ?? null;
  withAgent.deliverableUrl = grading.agent?.deliverableUrl ?? null;
  const publicPair = {
    runId: grading.runId ?? entry.runId,
    jobId: grading.jobId ?? entry.jobId ?? null,
    benchmarkId: grading.benchmarkId ?? entry.benchmarkId,
    benchmarkVersion: grading.benchmarkVersion ?? grading.pair?.benchmarkVersion ?? null,
    category: entry.category ?? grading.pair?.category ?? null,
    task: grading.pair?.task ?? entry.task ?? null,
    agent: { identity: grading.identity ?? entry.identity ?? null, name: run?.agent?.name ?? null, provider: grading.provider ?? null },
    referenceBlock: grading.referenceBlock ?? run?.benchmark?.referenceBlock ?? null,
    evaluatorVersion: grading.evaluatorVersion ?? grading.pair?.evaluatorVersion ?? null,
    groundTruthHash: grading.pair?.groundTruthHash ?? null,
    withoutAgent,
    withAgent,
    comparison: grading.pair?.comparison ?? entry.pair?.comparison ?? null,
    termix: grading.termix ?? entry.termix ?? null,
    verifiedRun: grading.verifiedRun ?? entry.verifiedRun ?? null,
    protocol: { chainState: run?.protocolJob?.currentState ?? null, transactions: (run?.protocolJob?.events || []).filter((event) => event?.tx?.transactionHash).map((event) => ({ event: event.event, transactionHash: event.tx.transactionHash })) },
    reconciliation: run?.reconciliation && typeof run.reconciliation === "object" ? { status: run.reconciliation.status ?? null, reason: run.reconciliation.reason ?? null } : null,
    traceability: { sourceArtifact: gradingRecord.name, sourceArtifactSha256, sourcePairSha256, runId: grading.runId ?? entry.runId, benchmarkId: grading.benchmarkId ?? entry.benchmarkId },
    gradedAt: grading.gradedAt ?? entry.gradedAt ?? null,
  };
  pairs.push(publicPair);
  sanitizedGradings.push({
    schemaVersion: 1,
    publicProjection: true,
    source: publicPair.traceability,
    runId: publicPair.runId,
    jobId: publicPair.jobId,
    benchmarkId: publicPair.benchmarkId,
    benchmarkVersion: publicPair.benchmarkVersion,
    evaluatorVersion: publicPair.evaluatorVersion,
    policyVersion: grading.policyVersion ?? null,
    provider: grading.provider ?? null,
    identity: grading.identity ?? null,
    referenceBlock: publicPair.referenceBlock,
    agent: { rawOutput: withAgent.rawOutput, elapsedMs: grading.agent?.elapsedMs ?? null, deliverableUrl: withAgent.deliverableUrl, deliverableCid: withAgent.deliverableCid, evidence: withAgent.evidence, score: withAgent.score },
    human: { rawSubmission: withoutAgent.rawOutput, elapsedMs: grading.human?.elapsedMs ?? null, sealedAt: grading.human?.sealedAt ?? null, evidence: withoutAgent.evidence, score: withoutAgent.score },
    pair: { benchmarkId: publicPair.benchmarkId, benchmarkVersion: publicPair.benchmarkVersion, evaluatorVersion: publicPair.evaluatorVersion, groundTruthHash: publicPair.groundTruthHash, task: publicPair.task, withAgent, withoutAgent, comparison: publicPair.comparison },
    termix: publicPair.termix,
    verifiedRun: publicPair.verifiedRun,
    gradedAt: publicPair.gradedAt,
  });
}

await mkdir(stateDir, { recursive: true });
await writeFile(path.join(stateDir, "public-termix-evidence.json"), `${JSON.stringify({ schemaVersion: 1, publicProjection: true, network: "bsc-testnet", chainId: 97, pairCount: pairs.length, requiredForTermix: 3, pairs, note: "Exact meaningful human and agent outputs are preserved from canonical grading records. Private evaluator notes and raw workspace metadata are omitted. See each pair traceability object for source hashes." }, null, 2)}\n`);
await writeFile(path.join(stateDir, "agent-advantage-pairs.json"), `${JSON.stringify({ schemaVersion: 1, publicProjection: true, pairs: pairs.map((pair) => ({
  runId: pair.runId,
  jobId: pair.jobId,
  benchmarkId: pair.benchmarkId,
  identity: pair.agent.identity,
  category: pair.category,
  task: pair.task,
  pair: { comparison: pair.comparison, withAgent: { elapsedMs: pair.withAgent.elapsedMs, qualityScore: pair.withAgent.qualityScore, cost: pair.withAgent.cost, evidence: pair.withAgent.evidence }, withoutAgent: { elapsedMs: pair.withoutAgent.elapsedMs, qualityScore: pair.withoutAgent.qualityScore, cost: pair.withoutAgent.cost, evidence: pair.withoutAgent.evidence } },
  termix: pair.termix,
  verifiedRun: pair.verifiedRun,
  gradedAt: pair.gradedAt,
}))}, null, 2)}\n`);
for (const grading of sanitizedGradings) await writeFile(path.join(stateDir, `${grading.benchmarkId.toLowerCase().replaceAll("_", "")}-grading-${grading.runId}.json`), `${JSON.stringify(grading, null, 2)}\n`);
const publicRuns = runs.map(publicRun);
await writeFile(path.join(stateDir, "benchmark-runs.json"), `${JSON.stringify(publicRuns, null, 2)}\n`);
for (const run of publicRuns.filter((item) => item?.benchmark?.id && item?.runId)) {
  const prefix = { HealthBench_v1: "healthbench", RebalanceBench_v1: "rebalancebench", YieldBench_v1: "yieldbench", GridBench_v1: "gridbench" }[run.benchmark.id];
  if (prefix) await writeFile(path.join(stateDir, `${prefix}-run-${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`);
}
console.log(JSON.stringify({ status: "public_evidence_bundle_built", pairCount: pairs.length, runCount: publicRuns.length, output: "state/" }, null, 2));
