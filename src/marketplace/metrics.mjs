import { CATEGORIES, RUN_TYPES } from "../domain.mjs";
import { deriveAgentRecord, filterAgents } from "./model.mjs";
import { derivePublicHireability } from "./public-hire.mjs";
import { delivered } from "./model.mjs";

function realRuns(runs) {
  return runs.filter((run) => run?.runType !== RUN_TYPES.FIXTURE && run?.runType !== RUN_TYPES.INFRASTRUCTURE_SMOKE_TEST && run?.runType !== RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL);
}

function endpointUnavailable(record) {
  return record?.currentAvailability !== "reachable"
    && record?.cannedObservations?.endpointChecks?.some((probe) => probe?.observedAt) === true;
}

export function deriveMarketplaceMetrics({ candidates = [], runs = [] } = {}) {
  const records = candidates.map((candidate) => deriveAgentRecord(candidate, runs));
  const hireableByIdentity = new Map(
    candidates.map((candidate) => {
      const record = records.find((item) => item.identity === candidate.identity) || null;
      return [candidate.identity, derivePublicHireability({ candidate, record, runs }).ready];
    }),
  );
  const hireableRecord = (record) => hireableByIdentity.get(record.identity) === true;
  const actualRuns = realRuns(runs);
  const paidAttempts = actualRuns.filter((run) => run?.protocolJob?.funded === true && run?.protocolJob?.jobId !== undefined && run?.protocolJob?.jobId !== null);
  const deliveredRuns = paidAttempts.filter(delivered);
  const qualifyingRuns = actualRuns.filter((run) => run?.qualification?.qualifiesForPublicMetrics === true);
  const categories = Object.fromEntries(Object.values(CATEGORIES).map((category) => {
    const inCategory = filterAgents(records, { category });
    return [category, {
      discovered: inCategory.length,
      reachable: inCategory.filter((record) => record.currentAvailability === "reachable").length,
      callable: inCategory.filter((record) => record.callableSurface === true).length,
      // Public hireability is derived per agent; adapter readiness stays
      // visible separately as the operator preflight.
      hireable: inCategory.filter(hireableRecord).length,
      operatorReady: inCategory.filter((record) => record.activation?.selection?.status === "ready").length,
      tested: inCategory.filter((record) => record.trust.paidAttempts > 0).length,
      delivered: inCategory.filter((record) => record.trust.deliveryCount > 0).length,
      benchmarked: inCategory.filter((record) => record.trust.benchmarkCount > 0).length,
    }];
  }));
  return {
    discoveredAgents: candidates.length,
    reachableAgents: records.filter((record) => record.currentAvailability === "reachable").length,
    callableAgents: records.filter((record) => record.callableSurface === true).length,
    verifiedQuotes: records.filter((record) => record.trust.states.QUOTE_VERIFIED).length,
    hireableAgents: records.filter(hireableRecord).length,
    operatorReadyAgents: records.filter((record) => record.activation?.selection?.status === "ready").length,
    verifiedNotHireableAgents: records.filter((record) => record.trust.states.ENDPOINT_VERIFIED && !hireableRecord(record)).length,
    unavailableAgents: records.filter(endpointUnavailable).length,
    hireAttempts: actualRuns.filter((run) => run?.qualification?.hasRealPayment === true || run?.protocolJob?.funded === true).length,
    paidAttempts: paidAttempts.length,
    deliveries: deliveredRuns.length,
    completedBenchmarks: actualRuns.filter((run) => run?.qualification?.completedBenchmark === true).length,
    qualifyingBenchmarks: qualifyingRuns.length,
    wins: qualifyingRuns.filter((run) => run.evaluation?.metrics?.agentAdvantage === true).length,
    losses: qualifyingRuns.filter((run) => run.evaluation?.metrics?.agentAdvantage === false).length,
    timeouts: paidAttempts.filter((run) => run.terminalState === "timeout" || run.terminalState === "expired" || run.protocolJob?.currentState === "EXPIRED").length,
    insufficientData: actualRuns.filter((run) => run.terminalState === "insufficient_data" || run.qualification?.performanceDataSufficient === false).length,
    excludedFixtureAndControlRuns: runs.length - actualRuns.length,
    jobsPaidForAndGraded: qualifyingRuns.length,
    categories,
    publicMetricNote: "Jobs paid for and graded requires a genuine funded run plus completed deterministic grading; controls and fixtures never count.",
  };
}
