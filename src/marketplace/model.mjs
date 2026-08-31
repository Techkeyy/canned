import { CATEGORY_LABELS, CATEGORIES, RUN_TYPES } from "../domain.mjs";
import { activationReview, isWeighFamily, protocolCapabilities } from "./adapters.mjs";

export const TRUST_STATES = Object.freeze([
  "LISTED",
  "ENDPOINT_VERIFIED",
  "QUOTE_VERIFIED",
  "HIRE_ATTEMPTED",
  "DELIVERY_OBSERVED",
  "BENCHMARKED",
  "REPEATEDLY_OBSERVED",
]);

export const QUARANTINED_IDENTITIES = Object.freeze([
  "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:1923",
  "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:1925",
  "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:1926",
]);

function candidateRuns(runs, identity) {
  return runs.filter((run) => run?.agent?.identity === identity && run?.runType !== RUN_TYPES.FIXTURE && run?.runType !== RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL);
}

function paid(run) {
  return run?.protocolJob?.funded === true && run?.protocolJob?.jobId !== undefined && run?.protocolJob?.jobId !== null;
}

/**
 * Whether the agent actually delivered work.
 *
 * A validated deliverable is the answer whenever one exists. The chain-state
 * fallback below is only for runs that carry no validation verdict at all: if
 * validation ran and rejected the deliverable, the chain having seen a
 * submission does not make it a delivery. Grid Keeper's paid job 835 settled
 * as COMPLETED while submitting an empty deliverable, and reading that as
 * DELIVERY OBSERVED would have flattered the record.
 */
export function delivered(run) {
  const validated = run?.qualification?.hasActualDeliverable ?? run?.agentExecution?.deliverableValidation?.hasActualDeliverable ?? null;
  if (validated !== null && validated !== undefined) return validated === true;
  return run?.protocolJob?.events?.some((event) => event.event === "deliverable_observed" || ["SUBMITTED", "COMPLETED"].includes(event.snapshot?.status)) === true;
}

function benchmarked(run) {
  return run?.qualification?.qualifiesForAgentTrackRecord === true || run?.qualification?.qualifiesForPublicMetrics === true;
}

function runTime(run) {
  const value = Date.parse(run?.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

function failureStatus(run) {
  if (delivered(run)) return null;
  if (run?.terminalState === "timeout" || run?.executionStatus === "timeout") return "timeout";
  if (run?.terminalState === "expired" || run?.protocolJob?.currentState === "EXPIRED") return "expired";
  if (run?.terminalState === "rejected" || run?.protocolJob?.currentState === "REJECTED") return "rejected";
  if (run?.terminalState === "error") return "error";
  return null;
}

export function deriveTrustStates(candidate, runs = []) {
  const history = candidateRuns(runs, candidate?.identity);
  const paidRuns = history.filter(paid);
  const deliveries = history.filter(delivered);
  const benchmarkRuns = history.filter(benchmarked);
  const endpointVerified = candidate?.probes?.some((probe) => probe.reachable === true) === true;
  const quoteVerified = candidate?.selectionGate?.readiness?.quoteVerified === true;
  const states = {
    LISTED: Boolean(candidate),
    ENDPOINT_VERIFIED: endpointVerified,
    QUOTE_VERIFIED: quoteVerified,
    HIRE_ATTEMPTED: paidRuns.length > 0,
    DELIVERY_OBSERVED: deliveries.length > 0,
    BENCHMARKED: benchmarkRuns.length > 0,
    REPEATEDLY_OBSERVED: benchmarkRuns.length >= 2,
  };
  return {
    states,
    reached: TRUST_STATES.filter((state) => states[state]),
    sampleSize: benchmarkRuns.length,
    paidAttempts: paidRuns.length,
    deliveryCount: deliveries.length,
    benchmarkCount: benchmarkRuns.length,
    failures: history.map(failureStatus).filter(Boolean),
  };
}

export function deriveAgentStatus(candidate, runs = []) {
  const trust = deriveTrustStates(candidate, runs);
  const history = candidateRuns(runs, candidate?.identity).sort((left, right) => runTime(right) - runTime(left));
  const lastFailure = history.map(failureStatus).find(Boolean);
  let label = "LISTED - NOT YET TESTED";
  if (trust.states.REPEATEDLY_OBSERVED) label = "REPEATEDLY OBSERVED";
  else if (trust.states.BENCHMARKED) label = "BENCHMARKED";
  else if (trust.states.DELIVERY_OBSERVED) label = "DELIVERY OBSERVED";
  else if (lastFailure === "timeout" || lastFailure === "expired") label = "LAST CANNED HIRE TIMED OUT";
  else if (trust.states.HIRE_ATTEMPTED) label = "HIRE ATTEMPTED - DELIVERY NOT OBSERVED";
  else if (trust.states.QUOTE_VERIFIED) label = "LIVE + QUOTE VERIFIED";
  else if (trust.states.ENDPOINT_VERIFIED) label = "ENDPOINT VERIFIED";
  return { label, live: trust.states.ENDPOINT_VERIFIED, lastTested: history[0]?.createdAt || null, lastFailure };
}

function categoryRecords(candidate) {
  return (candidate?.categoryHypotheses || []).map((item) => ({ category: item.category, label: CATEGORY_LABELS[item.category] || item.category, confidence: item.confidence, signals: item.signals }));
}

export function deriveAgentRecord(candidate, runs = []) {
  const trust = deriveTrustStates(candidate, runs);
  const status = deriveAgentStatus(candidate, runs);
  const quarantine = isWeighFamily(candidate?.identity) ? {
    active: true,
    wording: "DELIVERY NOT YET OBSERVED",
    reason: "Historical attempts across a likely shared implementation family have not produced an observed provider submission.",
    blockedForPaidHire: true,
    permanentBlacklist: false,
  } : { active: false, blockedForPaidHire: false, permanentBlacklist: false };
  const activation = activationReview(candidate, { runs, chainId: 97 });
  return {
    entity: "Agent",
    identity: candidate?.identity || null,
    name: candidate?.name || "Unnamed agent",
    description: candidate?.description || null,
    origin: candidate?.origin || "THIRD_PARTY_DISCOVERY",
    reference: candidate?.reference === true,
    referenceFleet: candidate?.referenceFleet || null,
    venue: candidate?.venue || null,
    erc8004: candidate?.erc8004 || { status: "unknown", tokenId: null },
    network: candidate?.network || "unknown",
    chainId: candidate?.chainId ?? null,
    ownerAddress: candidate?.ownerAddress || null,
    agentWallet: candidate?.agentWallet || null,
    categoryHypotheses: categoryRecords(candidate),
    services: candidate?.services || [],
    currentAvailability: candidate?.probes?.some((probe) => probe.reachable === true) ? "reachable" : "not_observed",
    callableSurface: candidate?.probes?.some((probe) => probe.callable === true) === true,
    status,
    trust,
    quarantine,
    protocolCapabilities: protocolCapabilities(candidate, runs),
    activation,
    advertised: { price: candidate?.hiring?.price || null, currency: candidate?.hiring?.currency || null, mechanisms: candidate?.hiring?.mechanism || "undetermined" },
    agentStatus: status,
    trackRecord: {
      deliveriesObserved: trust.deliveryCount,
      qualifyingBenchmarks: trust.benchmarkCount,
      wins: trust.benchmarkCount ? candidateRuns(runs, candidate?.identity).filter((run) => benchmarked(run) && run.evaluation?.metrics?.agentAdvantage === true).length : 0,
      losses: trust.benchmarkCount ? candidateRuns(runs, candidate?.identity).filter((run) => benchmarked(run) && run.evaluation?.metrics?.agentAdvantage === false).length : 0,
      sampleSize: trust.sampleSize,
      status: trust.sampleSize > 0 ? "observed" : "not_enough_data",
    },
    hireAttempts: candidateRuns(runs, candidate?.identity).filter(paid).map((run) => ({
      entity: "HireAttempt",
      runId: run.runId || null,
      protocol: run.protocolJob?.protocol || "ERC-8183",
      price: run.protocolJob?.price || null,
      startAt: run.createdAt || null,
      endAt: run.completedAt || run.endedAt || null,
      status: delivered(run) ? "delivered" : failureStatus(run) || "insufficient_data",
      paymentProvenance: { jobId: run.protocolJob?.jobId ?? null, fundingTx: run.protocolJob?.fundingTxHash || run.protocolJob?.transactions?.funding || null },
      failureReason: failureStatus(run),
    })),
    benchmarkRuns: candidateRuns(runs, candidate?.identity).filter((run) => run.runType === RUN_TYPES.BENCHMARK).map((run) => ({ entity: "BenchmarkRun", runId: run.runId || null, benchmarkId: run.benchmark?.id || null, status: run.terminalState || null, evaluation: run.evaluation || null })),
    controlRuns: candidateRuns(runs, candidate?.identity).filter((run) => run.controlExecution || run.artifacts?.controlOutput).map((run) => ({ entity: "ControlRun", runId: run.runId || null, benchmarkId: run.benchmark?.id || null, outputEvidence: run.artifacts?.controlOutput || null, execution: run.controlExecution || null })),
    evidence: { entity: "Evidence", source: candidate?.source || null },
    cannedObservations: {
      endpointChecks: candidate?.probes || [],
      quote: candidate?.hiring?.negotiationProbe || null,
      lastReadiness: candidate?.selectionGate?.readiness || null,
    },
    runHistory: candidateRuns(runs, candidate?.identity).sort((left, right) => runTime(right) - runTime(left)).map((run) => ({
      runId: run.runId || null,
      kind: run.runType || null,
      createdAt: run.createdAt || null,
      protocolJobId: run.protocolJob?.jobId ?? null,
      protocolState: run.protocolJob?.currentState || null,
      terminalState: run.terminalState || null,
      outcome: delivered(run) ? "delivered" : failureStatus(run) || (benchmarked(run) ? "benchmarked" : "insufficient_data"),
      deliveryObserved: delivered(run),
      benchmarked: benchmarked(run),
      evaluation: run.evaluation || null,
      evidence: { manifest: run.manifest || null, artifacts: run.artifacts || null },
    })),
  };
}

export function filterAgents(records, { category = null, includeQuarantined = true } = {}) {
  return records.filter((record) => (!category || record.categoryHypotheses.some((item) => item.category === category)) && (includeQuarantined || !record.quarantine.active));
}

export function compareAgents(records, identities = [], category = null) {
  const selected = records.filter((record) => identities.includes(record.identity) && (!category || record.categoryHypotheses.some((item) => item.category === category))).slice(0, 3);
  const valueOrUnknown = (value) => value === null || value === undefined ? null : value;
  return {
    category,
    agents: selected.map((record) => ({
      identity: record.identity,
      name: record.name,
      status: record.status.label,
      protocol: record.activation.selection.protocol || record.advertised.mechanisms,
      observedDeliveries: record.trust.deliveryCount,
      completedBenchmarks: record.trust.benchmarkCount,
      failures: record.trust.failures.length,
      failureRate: record.trust.paidAttempts ? record.trust.failures.length / record.trust.paidAttempts : null,
      cost: valueOrUnknown(record.advertised.price),
      currency: record.advertised.currency,
      observedAdvantage: record.runHistory.filter((run) => run.evaluation?.metrics?.agentAdvantage !== undefined).map((run) => run.evaluation.metrics.agentAdvantage),
      sampleSize: record.trust.sampleSize,
      lastObserved: record.status.lastTested,
      notEnoughData: record.trust.sampleSize === 0,
    })),
  };
}

export function buildMarketplaceSnapshot({ report = {}, runs = [], now = new Date().toISOString() } = {}) {
  const records = (report.candidates || []).map((candidate) => deriveAgentRecord(candidate, runs));
  return {
    schemaVersion: 1,
    generatedAt: now,
    network: "bsc-testnet",
    chainId: 97,
    categories: Object.values(CATEGORIES).map((category) => ({ category, label: CATEGORY_LABELS[category], agents: filterAgents(records, { category }) })),
    agents: records,
    notes: [
      "Trust states are an evidence ladder, not a composite score.",
      "Unknown evidence is represented as null or Not enough data; it is not treated as zero.",
      "Infrastructure controls and fixtures are excluded from marketplace records.",
    ],
  };
}
