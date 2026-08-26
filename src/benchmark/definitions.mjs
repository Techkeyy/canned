import { asNumber } from "../core.mjs";
import { CATEGORIES } from "../domain.mjs";

export const BENCHMARKS = Object.freeze({
  [CATEGORIES.REBALANCING]: {
    id: "rebalance-bench",
    version: "1.0.0",
    category: CATEGORIES.REBALANCING,
    task: "Manage one declared LP range over a fixed observation window within slippage and gas limits.",
    control: { id: "fixed-range-v1", description: "Hold the same initial LP range unchanged for the same window." },
    expectedOutputFields: ["timeInRangePct", "realizedFeesUsdCents", "executionCostUsdCents", "priceImpactBps", "inventoryDriftBps"],
    requiredAgentFields: ["timeInRangePct", "realizedFeesUsdCents", "executionCostUsdCents", "priceImpactBps", "inventoryDriftBps"],
  },
  [CATEGORIES.GRID_TRADING]: {
    id: "grid-bench",
    version: "1.0.0",
    category: CATEGORIES.GRID_TRADING,
    task: "Operate a fixed ladder with declared rungs, inventory limits, and observation window.",
    control: { id: "static-grid-v1", description: "Use the same predeclared grid without adaptive changes." },
    expectedOutputFields: ["filledRungs", "totalRungs", "spreadCaptureBps", "executionCostUsdCents"],
    requiredAgentFields: ["filledRungs", "totalRungs", "spreadCaptureBps", "executionCostUsdCents"],
  },
  [CATEGORIES.YIELD_OPTIMISATION]: {
    id: "yield-bench",
    version: "1.0.0",
    category: CATEGORIES.YIELD_OPTIMISATION,
    task: "Compare a stablecoin yield route against a fixed baseline over a declared observation window.",
    control: { id: "fixed-yield-baseline-v1", description: "Leave capital in the declared baseline venue for the same window." },
    expectedOutputFields: ["realizedYieldBps", "executionCostUsdCents"],
    requiredAgentFields: ["realizedYieldBps", "executionCostUsdCents"],
  },
  [CATEGORIES.HEALTH_FACTOR_MONITORING]: {
    id: "health-factor-bench",
    version: "1.0.0",
    category: CATEGORIES.HEALTH_FACTOR_MONITORING,
    task: "Detect a declared health-factor threshold with a bounded alert or protective action.",
    control: { id: "no-monitor-v1", description: "Observe the same position without an agent alert or protective action." },
    expectedOutputFields: ["alertSecondsBeforeThreshold", "falseAlertCount", "missedThresholdCount", "executionCostUsdCents"],
    requiredAgentFields: ["alertSecondsBeforeThreshold", "falseAlertCount", "missedThresholdCount", "executionCostUsdCents"],
  },
});

function numericFields(output, fields) {
  return fields.map((field) => [field, asNumber(output?.[field])]).filter(([, value]) => value === null).map(([field]) => field);
}

export function evaluateBenchmark({ benchmark, input, agentOutput, controlOutput }) {
  const missing = [...new Set([...numericFields(agentOutput, benchmark.requiredAgentFields), ...numericFields(controlOutput, benchmark.requiredAgentFields)])];
  if (missing.length || asNumber(input?.startingCapitalUsdCents) === null) {
    return { status: "insufficient_data", reason: "Required numeric metric or starting capital is missing.", missingFields: missing };
  }
  const capital = Number(input.startingCapitalUsdCents);
  const costBps = (output) => (Number(output.executionCostUsdCents) / capital) * 10_000;
  let metrics;
  if (benchmark.category === CATEGORIES.YIELD_OPTIMISATION) {
    const agentNet = Number(agentOutput.realizedYieldBps) - costBps(agentOutput);
    const controlNet = Number(controlOutput.realizedYieldBps) - costBps(controlOutput);
    metrics = { agentNetYieldBps: agentNet, controlNetYieldBps: controlNet, deltaBps: agentNet - controlNet, agentAdvantage: agentNet > controlNet };
  } else if (benchmark.category === CATEGORIES.REBALANCING) {
    const agentNet = Number(agentOutput.realizedFeesUsdCents) - Number(agentOutput.executionCostUsdCents);
    const controlNet = Number(controlOutput.realizedFeesUsdCents) - Number(controlOutput.executionCostUsdCents);
    metrics = { agentTimeInRangePct: Number(agentOutput.timeInRangePct), controlTimeInRangePct: Number(controlOutput.timeInRangePct), agentNetFeesUsdCents: agentNet, controlNetFeesUsdCents: controlNet, agentAdvantage: agentNet > controlNet && Number(agentOutput.priceImpactBps) <= Number(input.maxPriceImpactBps ?? Infinity) };
  } else if (benchmark.category === CATEGORIES.GRID_TRADING) {
    const agentFillRate = Number(agentOutput.filledRungs) / Number(agentOutput.totalRungs);
    const controlFillRate = Number(controlOutput.filledRungs) / Number(controlOutput.totalRungs);
    metrics = { agentFillRate, controlFillRate, agentNetSpreadBps: Number(agentOutput.spreadCaptureBps) - costBps(agentOutput), controlNetSpreadBps: Number(controlOutput.spreadCaptureBps) - costBps(controlOutput), agentAdvantage: agentFillRate > controlFillRate };
  } else {
    const agentPenalty = Number(agentOutput.missedThresholdCount) * 100 + Number(agentOutput.falseAlertCount) + costBps(agentOutput);
    const controlPenalty = Number(controlOutput.missedThresholdCount) * 100 + Number(controlOutput.falseAlertCount) + costBps(controlOutput);
    metrics = { agentAlertSecondsBeforeThreshold: Number(agentOutput.alertSecondsBeforeThreshold), controlAlertSecondsBeforeThreshold: Number(controlOutput.alertSecondsBeforeThreshold), agentPenalty, controlPenalty, agentAdvantage: agentPenalty < controlPenalty };
  }
  return { status: "completed", evaluator: "canned-deterministic-v1", metrics };
}
