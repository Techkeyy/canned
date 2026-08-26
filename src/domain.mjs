export const CATEGORIES = Object.freeze({
  REBALANCING: "rebalancing",
  GRID_TRADING: "grid_trading",
  YIELD_OPTIMISATION: "yield_optimisation",
  HEALTH_FACTOR_MONITORING: "health_factor_monitoring",
});

export const CATEGORY_LABELS = Object.freeze({
  [CATEGORIES.REBALANCING]: "Rebalancing",
  [CATEGORIES.GRID_TRADING]: "Grid Trading",
  [CATEGORIES.YIELD_OPTIMISATION]: "Yield Optimisation",
  [CATEGORIES.HEALTH_FACTOR_MONITORING]: "Health Factor Monitoring",
});

export const RUN_TYPES = Object.freeze({
  BENCHMARK: "BENCHMARK",
  INFRASTRUCTURE_SMOKE_TEST: "INFRASTRUCTURE_SMOKE_TEST",
  INFRASTRUCTURE_PROTOCOL_CONTROL: "INFRASTRUCTURE_PROTOCOL_CONTROL",
  FIXTURE: "FIXTURE",
});

export const TERMINAL_STATES = Object.freeze([
  "completed", "rejected", "expired", "timeout", "error", "insufficient_data",
]);

export const ERC8183_STATES = Object.freeze({
  0: "OPEN",
  1: "FUNDED",
  2: "SUBMITTED",
  3: "COMPLETED",
  4: "REJECTED",
  5: "EXPIRED",
});

export function terminalStateFor({ executionStatus, evaluationStatus } = {}) {
  if (TERMINAL_STATES.includes(executionStatus)) return executionStatus;
  if (evaluationStatus === "completed") return "completed";
  return "insufficient_data";
}

export function isPublicMetricEligible(run) {
  return run?.kind === "benchmark_run" &&
    run?.runType === RUN_TYPES.BENCHMARK &&
    run?.provenance?.mode === "LIVE_QUALIFYING" &&
    run?.provenance?.fixture !== true &&
    run?.provenance?.infrastructureSmokeTest !== true &&
    Boolean(run?.manifest?.hash) &&
    run?.protocolJob?.funded === true &&
    run?.qualification?.allGatesPassed === true;
}

export function publicMetrics(runs) {
  const qualifying = runs.filter(isPublicMetricEligible);
  const completed = qualifying.filter((run) => run.terminalState === "completed");
  return {
    jobsPaidForAndGraded: qualifying.filter((run) => run.protocolJob?.funded === true && run.evaluation).length,
    agentsTested: new Set(qualifying.map((run) => run.agent?.identity)).size,
    winsVsControl: completed.filter((run) => run.evaluation?.metrics?.agentAdvantage === true).length,
    qualifyingRuns: qualifying.length,
    excludedRuns: runs.length - qualifying.length,
  };
}
