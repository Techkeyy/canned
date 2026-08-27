import { id, canonicalJson, contentHashes, nowIso } from "../core.mjs";
import { publicMetrics, RUN_TYPES, terminalStateFor } from "../domain.mjs";
import { evaluateBenchmark } from "./definitions.mjs";

export function createPrecommitManifest({ runId = id("run"), agent, benchmark, input, limits, startAt = nowIso(), deadlineAtUnixSeconds, deadlinePlan = null, runType = RUN_TYPES.BENCHMARK, provenanceMode = "LIVE_CANDIDATE", providerIdentity, providerAddress, quoteTerms, expectedEvidenceSchema, validityCriteria, costAccounting }) {
  const inputHash = contentHashes(input);
  const controlHash = contentHashes(benchmark.control);
  const body = {
    schemaVersion: 1,
    runId,
    runType,
    provenanceMode,
    benchmarkId: benchmark.id,
    benchmarkVersion: benchmark.version,
    category: benchmark.category,
    agentIdentity: agent.identity,
    providerIdentity: providerIdentity || agent.identity,
    providerAddress: providerAddress || agent.agentWallet || agent.ownerAddress || null,
    agentEndpoint: agent.services?.find((service) => service.type.toLowerCase().includes("a2a"))?.endpoint || agent.services?.[0]?.endpoint || null,
    task: benchmark.task,
    taskInput: input,
    taskInputHash: inputHash.keccak256,
    control: benchmark.control,
    controlHash: controlHash.keccak256,
    limits,
    startAt,
    deadlineAtUnixSeconds,
    deadlines: deadlinePlan || {
      providerDeliveryDeadlineAtUnixSeconds: deadlineAtUnixSeconds,
      benchmarkObservationWindowSeconds: input?.observationWindowSeconds || null,
    },
    evaluatorVersion: "canned-deterministic-v1",
    quoteTerms: quoteTerms || null,
    budget: quoteTerms?.price || null,
    paymentToken: quoteTerms?.currency || null,
    expectedEvidenceSchema: expectedEvidenceSchema || { agentOutput: "JSON object or raw deliverable reference", controlOutput: "independent JSON object", protocol: "ERC-8183 job and transaction events" },
    validityCriteria: validityCriteria || ["identity and provider match", "fresh accepted quote", "funded ERC-8183 job", "independent control", "deterministic evaluation"],
    costAccounting: costAccounting || { agentFee: "quoted payment token budget", networkGas: "actual transaction receipts", control: "recorded separately" },
  };
  const hashes = contentHashes(body);
  return {
    ...body,
    manifestHash: hashes.keccak256,
    offchainContentHash: hashes.sha256,
    evidenceLevel: "offchain_content_addressed",
    publicPrecommitAnchor: "none_until_associated_with_an_onchain_job_transaction",
  };
}

export function deriveQualificationFlags({ runType, provenanceMode, precommit, protocolJob, agentOutput, agentDeliverableValidation = null, controlOutput, evaluation, terminalState, termixEligiblePair = false, termixReason = "Not enough real paired evidence yet." }) {
  const isFixture = runType === RUN_TYPES.FIXTURE;
  const isInfrastructureSmokeTest = runType === RUN_TYPES.INFRASTRUCTURE_SMOKE_TEST;
  const hasRealPayment = protocolJob?.funded === true && protocolJob?.jobId !== undefined && protocolJob?.jobId !== null;
  const hasOnchainProvenance = Boolean(protocolJob?.events?.some((event) => event.tx?.transactionHash || event.snapshot?.status));
  const hasTerminalProtocolOutcome = protocolJob?.currentState === "COMPLETED" || protocolJob?.currentState === "REJECTED" || protocolJob?.currentState === "EXPIRED";
  const hasPrecommit = Boolean(precommit?.manifestHash);
  const hasRealControl = controlOutput?.provenance?.independent === true;
  const hasActualDeliverable = agentDeliverableValidation ? agentDeliverableValidation.valid === true && agentDeliverableValidation.hasActualDeliverable === true : protocolJob?.funded !== true && agentOutput !== undefined && agentOutput !== null;
  const protocolCompleted = protocolJob?.currentState === "COMPLETED";
  const performanceDataSufficient = evaluation?.status === "completed";
  const isComplete = hasActualDeliverable && protocolCompleted && hasRealControl && ["completed", "insufficient_data"].includes(evaluation?.status);
  const qualifiesForPublicMetrics = runType === RUN_TYPES.BENCHMARK && provenanceMode === "LIVE_QUALIFYING" && hasPrecommit && hasRealPayment && hasOnchainProvenance && hasTerminalProtocolOutcome && hasRealControl && isComplete && performanceDataSufficient;
  const qualifiesForAgentTrackRecord = runType === RUN_TYPES.BENCHMARK && provenanceMode === "LIVE_QUALIFYING" && hasPrecommit && hasRealPayment && hasTerminalProtocolOutcome && hasRealControl && isComplete;
  const qualifiesForTermixEvidence = termixEligiblePair === true && hasPrecommit && hasRealPayment && hasRealControl && hasActualDeliverable && performanceDataSufficient;
  return {
    isFixture,
    isInfrastructureSmokeTest,
    isComplete,
    hasRealControl,
    hasRealPayment,
    hasActualDeliverable,
    protocolCompleted,
    performanceDataSufficient,
    completedBenchmark: isComplete,
    hasOnchainProvenance,
    hasTerminalProtocolOutcome,
    hasPrecommit,
    qualifiesForPublicMetrics,
    qualifiesForAgentTrackRecord,
    qualifiesForTermixEvidence,
    termixEligiblePair: qualifiesForTermixEvidence,
    termixReason: qualifiesForTermixEvidence ? "Real paid agent/control pair captured." : termixReason,
    allGatesPassed: qualifiesForPublicMetrics,
  };
}

export async function runBenchmark({ agent, benchmark, input, agentOutput, controlOutput, store, runType = RUN_TYPES.BENCHMARK, provenanceMode = "LIVE_CANDIDATE", qualification = {}, executionStatus, precommit, precommitEvidence, protocolJob = null, termixEligiblePair = false, termixReason, agentExecution = null, controlExecution = null, agentDeliverableValidation = null, deadlinePlan = null }) {
  const runId = precommit?.runId || id("run");
  const manifest = precommit || createPrecommitManifest({ runId, agent, benchmark, input, limits: input.limits || {}, deadlineAtUnixSeconds: input.deadlineAtUnixSeconds || Math.floor(Date.now() / 1000) + 900, deadlinePlan, runType, provenanceMode });
  const manifestEvidence = precommitEvidence || await store.saveEvidence(manifest);
  const agentEvidence = await store.saveEvidence({ kind: "agent_output", runId, output: agentOutput });
  const controlEvidence = await store.saveEvidence({ kind: "control_output", runId, output: controlOutput });
  const evaluation = evaluateBenchmark({ benchmark, input, agentOutput, controlOutput });
  const terminalState = terminalStateFor({ executionStatus, evaluationStatus: evaluation.status });
  const derivedQualification = deriveQualificationFlags({ runType, provenanceMode, precommit: manifest, protocolJob, agentOutput, agentDeliverableValidation, controlOutput, evaluation, terminalState, termixEligiblePair, termixReason });
  const priorRuns = await store.loadRuns();
  const isVerifiedRun = derivedQualification.completedBenchmark === true && !priorRuns.some((item) => item.qualification?.isVerifiedRun === true);
  const run = {
    kind: "benchmark_run",
    runId,
    runType,
    provenance: {
      mode: provenanceMode,
      fixture: runType === RUN_TYPES.FIXTURE,
      infrastructureSmokeTest: runType === RUN_TYPES.INFRASTRUCTURE_SMOKE_TEST,
    },
    agent: { identity: agent.identity, name: agent.name, category: benchmark.category, origin: agent.origin || "THIRD_PARTY_DISCOVERY" },
    benchmark: { id: benchmark.id, version: benchmark.version, category: benchmark.category, task: benchmark.task, control: benchmark.control },
    manifest: { hash: manifest.manifestHash, offchainContentHash: manifest.offchainContentHash, evidence: manifestEvidence, level: protocolJob?.precommitBinding?.level || manifest.evidenceLevel, publicPrecommitAnchor: protocolJob?.precommitBinding?.method || manifest.publicPrecommitAnchor },
    artifacts: { agentOutput: agentEvidence, controlOutput: controlEvidence },
    agentExecution: agentExecution ? { ...agentExecution, deliverableValidation: agentDeliverableValidation || agentExecution.deliverableValidation || null } : null,
    controlExecution,
    evaluation,
    terminalState,
    protocolJob,
    qualification: { ...derivedQualification, isVerifiedRun, verifiedRunNumber: isVerifiedRun ? 1 : null, reason: qualification.reason || null, notes: qualification.notes || null },
    createdAt: nowIso(),
  };
  await store.saveRun(run);
  return run;
}

export async function metricsFromStore(store) {
  return publicMetrics(await store.loadRuns());
}
