/**
 * The public deployment intentionally does not receive mutable human-baseline
 * state. A completed, funded, verified benchmark run is immutable derived
 * evidence that its benchmark baseline gate had already been sealed before
 * the run. This helper never treats a failed, fixture, control, or unverified
 * run as a baseline.
 */
export function baselineSealedFromDerivedEvidence({ explicitBaseline = false, identity = null, runs = [] } = {}) {
  if (explicitBaseline === true) return true;
  if (!identity) return false;
  return runs.some((run) => (
    run?.runType === "BENCHMARK"
    && run?.agent?.identity === identity
    && run?.protocolJob?.funded === true
    && run?.protocolJob?.currentState === "COMPLETED"
    && run?.terminalState === "completed"
    && run?.evaluation?.status === "completed"
    && run?.qualification?.isVerifiedRun === true
  ));
}
