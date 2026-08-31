/**
 * GridBench v1 evaluator.
 *
 * Ground truth is recomputed here from the frozen specification using its own
 * arithmetic. It deliberately does not call the grid engine. An evaluator that
 * asked the implementation under test what the right answer was would agree
 * with it by construction, including where both are wrong.
 *
 * The rubric is frozen before any answer exists and is not retuned afterwards.
 * That precedent was set in ADR-031 and held again in ADR-043; a rubric that
 * gets adjusted once a graded answer looks unfair is not evidence of anything.
 */
import { contentHashes } from "../core.mjs";
import { GRID_BENCHMARK_ID, GRID_BENCHMARK_VERSION } from "./grid-benchmark.mjs";

export const GRID_EVALUATOR_VERSION = "gridbench-evaluator-v1";

const toMinor = (human, decimals = 18) => BigInt(Math.round(human * 1e6)) * 10n ** BigInt(decimals - 6);

/**
 * Recompute the grid from the strategy specification.
 *
 * Plain arithmetic, independent of the engine: equal steps between the bounds,
 * a level below the reference buys and a level at or above it sells.
 */
export function groundTruthLevels(strategy) {
  const lower = BigInt(strategy.lowerPriceMinor);
  const upper = BigInt(strategy.upperPriceMinor);
  const count = strategy.levelCount;
  const reference = BigInt(strategy.referencePriceMinor);
  const steps = BigInt(count - 1);
  const levels = [];
  for (let index = 0; index < count; index += 1) {
    const priceMinor = lower + ((upper - lower) * BigInt(index)) / steps;
    levels.push({
      levelId: `${strategy.strategyId}:L${String(index).padStart(2, "0")}`,
      index,
      priceMinor,
      side: priceMinor < reference ? "BUY" : "SELL",
    });
  }
  return levels;
}

function ledgerFromFills(fills = []) {
  let netQuoteSpentMinor = 0n;
  let baseInventoryMinor = 0n;
  let lastFillAt = null;
  for (const fill of fills) {
    if (fill.state !== "FILLED") continue;
    if (fill.side === "BUY") {
      netQuoteSpentMinor += BigInt(fill.quoteSpentMinor ?? 0);
      baseInventoryMinor += BigInt(fill.baseReceivedMinor ?? 0);
    } else {
      netQuoteSpentMinor -= BigInt(fill.quoteReceivedMinor ?? 0);
      baseInventoryMinor -= BigInt(fill.baseSoldMinor ?? 0);
    }
    const at = Date.parse(fill.filledAt);
    if (lastFillAt === null || at > lastFillAt) lastFillAt = at;
  }
  return { netQuoteSpentMinor, baseInventoryMinor, lastFillAt, fillCount: fills.filter((f) => f.state === "FILLED").length };
}

/**
 * The correct verdict for one scenario.
 *
 * Checks are ordered the way a careful reviewer would reason: authority first,
 * then whether the level is even eligible, then whether the market reached it,
 * then whether the budget allows it, then whether the call itself is in scope.
 */
export function groundTruthDecision(scenario, strategy, { nowMs }) {
  const merged = { ...strategy, ...(scenario.strategyOverride ?? {}) };
  const levels = groundTruthLevels(merged);
  const level = levels.find((entry) => entry.levelId === scenario.levelId);
  const fills = scenario.fills ?? [];
  const ledger = ledgerFromFills(fills);

  if (Date.parse(merged.expiresAt) <= nowMs) return { allowed: false, reason: "strategy_expired" };
  if (scenario.authority?.revoked === true) return { allowed: false, reason: "authority_revoked" };
  if (!level) return { allowed: false, reason: "level_not_in_strategy" };
  if (fills.some((fill) => fill.levelId === level.levelId && fill.state === "FILLED")) {
    return { allowed: false, reason: "level_already_filled" };
  }

  const observation = scenario.observation;
  if (!observation) return { allowed: false, reason: "no_price_observation" };
  if (observation.chainId !== merged.chainId) return { allowed: false, reason: "chain_does_not_match_the_strategy" };
  if (observation.baseToken.toLowerCase() !== merged.pair.baseToken) return { allowed: false, reason: "pair_does_not_match_the_strategy" };
  if (observation.quoteToken.toLowerCase() !== merged.pair.quoteToken) return { allowed: false, reason: "pair_does_not_match_the_strategy" };
  const age = nowMs - Date.parse(observation.observedAt);
  if (age > merged.maxPriceAgeMs || age < 0) return { allowed: false, reason: "price_observation_is_too_old" };

  const price = BigInt(observation.priceMinor);
  const reached = level.side === "BUY" ? price <= level.priceMinor : price >= level.priceMinor;
  if (!reached) return { allowed: false, reason: "price_has_not_reached_this_level" };

  if (merged.maxFills !== null && ledger.fillCount >= merged.maxFills) return { allowed: false, reason: "maximum_fill_count_reached" };
  if (merged.cooldownMs > 0 && ledger.lastFillAt !== null && nowMs - ledger.lastFillAt < merged.cooldownMs) {
    return { allowed: false, reason: "cooldown_has_not_elapsed" };
  }

  if (level.side === "BUY") {
    const buyCount = levels.filter((entry) => entry.side === "BUY").length;
    const share = BigInt(merged.totalCapitalMinor) / BigInt(buyCount);
    const cap = merged.maxPerLevelMinor === null ? share : BigInt(merged.maxPerLevelMinor);
    const allocation = share < cap ? share : cap;
    if (ledger.netQuoteSpentMinor + allocation > BigInt(merged.totalCapitalMinor)) {
      return { allowed: false, reason: "total_capital_cap_would_be_exceeded" };
    }
  } else if (ledger.baseInventoryMinor <= 0n) {
    return { allowed: false, reason: "not_enough_inventory_to_sell" };
  }

  const call = scenario.intendedCall;
  if (call) {
    if (!merged.allowedContracts.includes(String(call.to).toLowerCase())) return { allowed: false, reason: "target_contract_is_not_allowed" };
    if (call.method && !merged.allowedMethods.includes(call.method)) return { allowed: false, reason: "method_is_not_allowed" };
    if (call.quotedOutMinor !== undefined && call.minOutMinor !== undefined && BigInt(call.quotedOutMinor) < BigInt(call.minOutMinor)) {
      return { allowed: false, reason: "quoted_output_is_below_the_minimum" };
    }
  }

  return { allowed: true, reason: null, side: level.side };
}

/** Ground truth for every scenario in the frozen definition. */
export function computeGridGroundTruth(definition, { nowMs = Date.parse("2026-08-30T12:00:00.000Z") } = {}) {
  const strategy = definition.strategy;
  const levels = groundTruthLevels(strategy);
  const answers = {};
  for (const scenario of definition.scenarios) {
    if (scenario.asks === "grid_construction") {
      answers[scenario.id] = {
        asks: scenario.asks,
        levels: levels.map((level) => ({ levelId: level.levelId, priceMinor: String(level.priceMinor), side: level.side })),
      };
    } else if (scenario.asks === "ledger") {
      const ledger = ledgerFromFills(scenario.fills ?? []);
      answers[scenario.id] = {
        asks: scenario.asks,
        fillCount: ledger.fillCount,
        netQuoteSpentMinor: String(ledger.netQuoteSpentMinor),
        baseInventoryMinor: String(ledger.baseInventoryMinor),
      };
    } else {
      answers[scenario.id] = { asks: scenario.asks, ...groundTruthDecision(scenario, strategy, { nowMs }) };
    }
  }
  return {
    benchmarkId: GRID_BENCHMARK_ID,
    version: GRID_BENCHMARK_VERSION,
    evaluatorVersion: GRID_EVALUATOR_VERSION,
    computedFrom: "frozen_specification",
    answers,
    hashes: contentHashes(answers),
  };
}

/**
 * Grade a submission.
 *
 * A decision scenario needs both the verdict and the reason. Getting "no" for
 * the wrong reason means the implementation refused by accident, which is not
 * the same as a guard working, so it earns nothing. The policy said so before
 * any answer existed.
 */
export function gradeGridBenchResponse({ definition, groundTruth, submission }) {
  const scenarios = definition.scenarios;
  const perScenario = Math.round((100 / scenarios.length) * 100) / 100;
  const results = [];
  let score = 0;

  for (const scenario of scenarios) {
    const truth = groundTruth.answers[scenario.id];
    const answer = submission?.answers?.[scenario.id] ?? null;
    let passed = false;
    let detail = null;

    if (!answer) {
      detail = "no answer submitted";
    } else if (truth.asks === "grid_construction") {
      const given = Array.isArray(answer.levels) ? answer.levels : [];
      const sameLength = given.length === truth.levels.length;
      const ordered = given.every((level, index) => index === 0 || BigInt(level.priceMinor) > BigInt(given[index - 1].priceMinor));
      const matches = sameLength && truth.levels.every((expected, index) =>
        given[index] && String(given[index].priceMinor) === expected.priceMinor && given[index].side === expected.side);
      passed = Boolean(matches && ordered);
      detail = passed ? null : !sameLength ? `expected ${truth.levels.length} levels, got ${given.length}` : !ordered ? "levels are not strictly increasing" : "level price or side mismatch";
    } else if (truth.asks === "ledger") {
      passed = answer.fillCount === truth.fillCount
        && String(answer.netQuoteSpentMinor) === truth.netQuoteSpentMinor
        && String(answer.baseInventoryMinor) === truth.baseInventoryMinor;
      detail = passed ? null : "ledger figures do not match";
    } else {
      const verdictMatches = answer.allowed === truth.allowed;
      const reasonMatches = truth.allowed ? true : String(answer.reason ?? "") === String(truth.reason ?? "");
      passed = verdictMatches && reasonMatches;
      detail = passed ? null : !verdictMatches ? `expected allowed=${truth.allowed}` : `expected reason ${truth.reason}, got ${answer.reason ?? "none"}`;
    }

    if (passed) score += perScenario;
    results.push({ scenarioId: scenario.id, asks: scenario.asks, passed, detail, expected: truth, given: answer });
  }

  const rounded = Math.round(score * 100) / 100;
  return {
    benchmarkId: GRID_BENCHMARK_ID,
    evaluatorVersion: GRID_EVALUATOR_VERSION,
    policyVersion: GRID_BENCHMARK_VERSION,
    scenarioCount: scenarios.length,
    passedCount: results.filter((result) => result.passed).length,
    qualityScore: rounded > 100 ? 100 : rounded,
    results,
    gradedAt: new Date().toISOString(),
  };
}
