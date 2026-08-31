import { CATEGORIES, RUN_TYPES } from "../domain.mjs";
import { deriveAgentRecord, filterAgents } from "./model.mjs";
import { selectHiringAdapter } from "./adapters.mjs";
import { delivered } from "./model.mjs";

function realRuns(runs) {
  return runs.filter((run) => run?.runType !== RUN_TYPES.FIXTURE && run?.runType !== RUN_TYPES.INFRASTRUCTURE_SMOKE_TEST && run?.runType !== RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL);
}

export function deriveMarketplaceMetrics({ candidates = [], runs = [] } = {}) {
  const records = candidates.map((candidate) => deriveAgentRecord(candidate, runs));
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
      hireable: inCategory.filter((record) => selectHiringAdapter(candidates.find((item) => item.identity === record.identity), { chainId: 97 }).status === "ready").length,
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
