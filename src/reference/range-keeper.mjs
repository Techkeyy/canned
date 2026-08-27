import { canonicalJson, contentHashes, nowIso } from "../core.mjs";
import { CATEGORIES } from "../domain.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ORIGIN } from "./constants.mjs";
import { alignTick, classifyRange, isTickSpacingAligned, isValidTick, PANCAKESWAP_V3, tickToPrice, validateAuthoritativePancakeSnapshot } from "./pancakeswap.mjs";

export const RANGE_KEEPER_TASK_VERSION = "1.0.0";

/**
 * Rebalance policy, declared before any run so the recommendation is a rule
 * applied to evidence rather than a judgement made after seeing the answer.
 *
 * A rebalance costs gas, realises impermanent loss, and resets fee accrual, so
 * drifting toward an edge is not on its own a reason to act. Only leaving the
 * range, or sitting close enough to an edge that exit is likely within the
 * declared horizon, justifies the cost.
 */
export const REBALANCE_POLICY = Object.freeze({
  version: "range-keeper-policy-v1",
  edgeProximityWarnPct: 25,
  edgeProximityActPct: 10,
  driftHorizonSeconds: 86_400,
  minWidthMultipleOfSpacing: 2,
  rationale: "Rebalancing is only recommended when the position has left its range, or when it sits inside the act threshold of an edge and observed drift is carrying it further that way. Otherwise holding is cheaper than acting.",
});

function driftFromObservations(observations, currentTick) {
  if (!observations?.meanTicks?.length) return { available: false, reason: "The pool oracle could not serve the requested windows.", windows: [] };
  const windows = observations.meanTicks
    .filter((entry) => entry.secondsAgo > 0 && Number.isFinite(entry.meanTick))
    .map((entry) => ({ secondsAgo: entry.secondsAgo, meanTick: entry.meanTick, tickDelta: Number(currentTick) - entry.meanTick }));
  if (!windows.length) return { available: false, reason: "No usable observation window was returned.", windows: [] };
  const shortest = windows.reduce((best, entry) => (entry.secondsAgo < best.secondsAgo ? entry : best), windows[0]);
  const longest = windows.reduce((best, entry) => (entry.secondsAgo > best.secondsAgo ? entry : best), windows[0]);
  return {
    available: true,
    windows,
    shortestWindowSeconds: shortest.secondsAgo,
    longestWindowSeconds: longest.secondsAgo,
    direction: longest.tickDelta > 0 ? "rising" : longest.tickDelta < 0 ? "falling" : "flat",
    tickDeltaOverLongestWindow: longest.tickDelta,
    note: "Drift is the current tick minus the pool's own arithmetic-mean tick over each window. Tick direction is quote-dependent: a rising tick is a rising token1-per-token0 price and a falling token0-per-token1 price. It is a description of what happened, not a forecast.",
  };
}

/**
 * Movement expressed against the position itself. Unlike raw tick direction,
 * this reads the same way in either quote convention, which is what an LP
 * actually needs to know.
 */
function movementRelativeToRange({ drift, range }) {
  if (!drift.available) return { available: false, reason: drift.reason };
  const delta = drift.tickDeltaOverLongestWindow;
  const deltaPctOfWidth = Number(((Math.abs(delta) / range.widthTicks) * 100).toFixed(2));
  const towardNearestEdge = (range.nearestEdge === "upper" && delta > 0) || (range.nearestEdge === "lower" && delta < 0);
  return {
    available: true,
    windowSeconds: drift.longestWindowSeconds,
    tickDelta: delta,
    deltaPctOfRangeWidth: deltaPctOfWidth,
    towardNearestEdge,
    directionRelativeToRange: delta === 0 ? "flat" : towardNearestEdge ? `toward the ${range.nearestEdge} edge` : `away from the ${range.nearestEdge} edge`,
    materiality: deltaPctOfWidth < 10 ? "small" : deltaPctOfWidth < 33 ? "moderate" : "large",
    note: "Movement measured against this position's own range width, so it reads the same in either price quote convention.",
  };
}

/**
 * Propose a bounded replacement range centred on the current tick, keeping the
 * original width. Both ticks are aligned to the pool's spacing, because an
 * unaligned tick is rejected by the protocol outright.
 */
export function proposeRange({ currentTick, tickLower, tickUpper, tickSpacing }) {
  const width = Number(tickUpper) - Number(tickLower);
  const halfWidth = Math.round(width / 2);
  const proposedLower = alignTick(Number(currentTick) - halfWidth, tickSpacing, "down");
  const proposedUpper = alignTick(Number(currentTick) + halfWidth, tickSpacing, "up");
  return {
    tickLower: proposedLower,
    tickUpper: proposedUpper,
    widthTicks: proposedUpper - proposedLower,
    preservesOriginalWidth: Math.abs((proposedUpper - proposedLower) - width) <= Number(tickSpacing) * 2,
    centredOnCurrentTick: Number(currentTick) >= proposedLower && Number(currentTick) < proposedUpper,
    alignedToSpacing: isTickSpacingAligned(proposedLower, tickSpacing) && isTickSpacingAligned(proposedUpper, tickSpacing),
    method: "Keep the LP's chosen width and recentre it on the live tick, then align both bounds outward to the pool tick spacing.",
  };
}

export function validateRangeKeeperTask(task = {}) {
  const errors = [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(task.pool || ""))) errors.push("pool_address_required");
  if (String(task.venue || "").toLowerCase() !== "pancakeswap") errors.push("venue_must_be_pancakeswap");
  if (!task.authoritativeSnapshot) errors.push("authoritative_snapshot_required");
  if (task.authoritativeSnapshot && !validateAuthoritativePancakeSnapshot(task.authoritativeSnapshot).valid) errors.push("authoritative_snapshot_invalid");
  return { valid: errors.length === 0, errors };
}

/**
 * The Range Keeper deliverable. It observes and recommends; it never moves
 * capital. The action plan is shaped so a future Altana session can execute it
 * under an explicit allowlist, but nothing here signs or sends anything.
 */
export function buildRangeKeeperDeliverable({ jobId = null, task = {}, snapshot = task.authoritativeSnapshot, observedAt = nowIso(), policy = REBALANCE_POLICY } = {}) {
  const validation = validateRangeKeeperTask({ ...task, authoritativeSnapshot: snapshot });
  if (!validation.valid) {
    return {
      ok: false,
      status: "insufficient_authoritative_data",
      errors: validation.errors,
      output: {
        schemaVersion: RANGE_KEEPER_TASK_VERSION,
        origin: REFERENCE_ORIGIN,
        category: CATEGORIES.REBALANCING,
        jobId: jobId === null ? null : Number(jobId),
        status: "INSUFFICIENT_AUTHORITATIVE_DATA",
        recommendation: "Do not act. Supply a fresh authoritative PancakeSwap V3 pool and position snapshot before assessing this range.",
      },
    };
  }

  const { pool, slot0, position } = snapshot;
  const range = classifyRange({
    currentTick: slot0.tick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    tickSpacing: pool.tickSpacing,
    decimals0: pool.token0.decimals,
    decimals1: pool.token1.decimals,
  });
  const drift = driftFromObservations(snapshot.observations, slot0.tick);
  const movement = movementRelativeToRange({ drift, range });

  const outOfRange = range.inRange === false;
  const insideActThreshold = range.inRange && range.edgeProximityPct !== null && range.edgeProximityPct <= policy.edgeProximityActPct;
  const insideWarnThreshold = range.inRange && range.edgeProximityPct !== null && range.edgeProximityPct <= policy.edgeProximityWarnPct;
  const driftingTowardNearestEdge = drift.available
    ? (range.nearestEdge === "upper" && drift.tickDeltaOverLongestWindow > 0) || (range.nearestEdge === "lower" && drift.tickDeltaOverLongestWindow < 0)
    : false;
  const rebalanceJustified = outOfRange || (insideActThreshold && driftingTowardNearestEdge);

  const triggers = [];
  if (outOfRange) triggers.push("position_out_of_range");
  if (insideActThreshold) triggers.push("within_act_threshold_of_edge");
  else if (insideWarnThreshold) triggers.push("within_warn_threshold_of_edge");
  if (driftingTowardNearestEdge) triggers.push("drift_toward_nearest_edge");

  const proposed = rebalanceJustified ? proposeRange({ currentTick: slot0.tick, tickLower: position.tickLower, tickUpper: position.tickUpper, tickSpacing: pool.tickSpacing }) : null;

  const output = {
    schemaVersion: RANGE_KEEPER_TASK_VERSION,
    origin: REFERENCE_ORIGIN,
    category: CATEGORIES.REBALANCING,
    jobId: jobId === null ? null : Number(jobId),
    observedAt,
    venue: "PancakeSwap",
    position: {
      protocol: "PancakeSwapV3",
      chainId: snapshot.chainId,
      pool: pool.address,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      feeTier: pool.fee,
      feePercent: pool.feePercent,
      tickSpacing: pool.tickSpacing,
      tokenId: position.tokenId,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
      liquidity: position.liquidity,
      asOfBlock: snapshot.asOfBlock,
      source: snapshot.source,
    },
    rangeStatus: {
      status: range.status,
      inRange: range.inRange,
      currentTick: range.currentTick,
      widthTicks: range.widthTicks,
      ticksToLower: range.ticksToLower,
      ticksToUpper: range.ticksToUpper,
      nearestEdge: range.nearestEdge,
      ticksToNearestEdge: range.ticksToNearestEdge,
      edgeProximityPct: range.edgeProximityPct,
      positionInRange: range.positionInRange,
      priceCurrent: range.price.current,
      priceLower: range.price.lower,
      priceUpper: range.price.upper,
      priceQuote: `${pool.token1.symbol} per ${pool.token0.symbol}`,
      composition: range.composition,
    },
    marketContext: { ...drift, relativeToRange: movement },
    decision: {
      rebalanceRecommended: rebalanceJustified,
      action: rebalanceJustified ? "REBALANCE" : "HOLD",
      triggers,
      policyVersion: policy.version,
      thresholds: { edgeProximityWarnPct: policy.edgeProximityWarnPct, edgeProximityActPct: policy.edgeProximityActPct },
      reason: rebalanceJustified
        ? outOfRange
          ? "The position is outside its range, so it has stopped earning fees and is fully converted into one asset."
          : "The position sits inside the act threshold of an edge and observed drift is carrying it further that way."
        : range.inRange
          ? "The position is still in range and drift does not justify paying gas, realising impermanent loss, and resetting fee accrual."
          : "No rebalance is proposed from this snapshot.",
    },
    proposedRange: proposed,
    tradeoffs: {
      costOfActing: ["gas for decrease, collect, and mint", "realised impermanent loss at the current price", "fee accrual resets", "slippage if the position is rebalanced through a swap"],
      costOfNotActing: outOfRange
        ? ["the position earns no fees while out of range", "the LP is fully exposed to one side of the pair"]
        : ["the position may leave the range and stop earning fees", "a later rebalance may happen at a worse price"],
      note: "Constant rebalancing is not automatically better. Holding is the correct answer whenever expected fees do not cover the cost of acting.",
    },
    execution: {
      mode: "recommendation_only",
      automaticActionTaken: false,
      capitalMoved: false,
      reason: "Canned Range Keeper v1 observes and recommends. It never removes liquidity, mints liquidity, swaps, or approves spending.",
      futureBoundedPlan: rebalanceJustified ? altanaExecutionPlan({ snapshot, proposed }) : null,
    },
    evidence: {
      authoritativeProtocol: "PancakeSwapV3",
      readSource: snapshot.readPlan || null,
      snapshotHash: contentHashes(snapshot).keccak256,
      oracleWindowsUsed: drift.available ? drift.windows.map((entry) => entry.secondsAgo) : [],
      limitations: [
        "A single frozen block describes one moment and does not predict the next one.",
        "Oracle mean ticks describe what happened, not what will happen.",
        drift.available ? null : "The pool oracle could not serve the requested observation windows, so no drift was computed.",
      ].filter(Boolean),
    },
  };
  return { ok: true, status: "delivered", output, canonicalOutput: canonicalJson(output) };
}

/**
 * The exact shape a later Altana session would be scoped to. Declared now so
 * the execution boundary is designed rather than retrofitted; nothing in this
 * milestone signs, sends, or grants anything.
 */
export function altanaExecutionPlan({ snapshot, proposed }) {
  if (!proposed) return null;
  return {
    status: "PLANNED_NOT_AUTHORIZED",
    network: "bsc-testnet",
    chainId: REFERENCE_CHAIN_ID,
    contractAllowlist: [PANCAKESWAP_V3.positionManager],
    methodAllowlist: ["decreaseLiquidity", "collect", "mint"],
    forbidden: ["approve", "setApprovalForAll", "transferFrom", "unlimited allowance", "arbitrary calldata"],
    positionTokenId: snapshot.position.tokenId,
    proposedTickLower: proposed.tickLower,
    proposedTickUpper: proposed.tickUpper,
    slippageBpsCap: 50,
    expirySeconds: 900,
    revocable: true,
    requiresOperatorConfirmation: true,
    note: "No Altana session exists for this plan. It is a declared boundary, not an authorization.",
  };
}

/** Independent deterministic control: the same evidence, no agent, no action. */
export function buildIndependentRangeControl({ task = {}, snapshot = task.authoritativeSnapshot } = {}) {
  const built = buildRangeKeeperDeliverable({ jobId: null, task, snapshot });
  return {
    ...built,
    output: built.output ? { ...built.output, origin: "CANNED_INDEPENDENT_CONTROL", control: true, execution: { ...built.output.execution, mode: "control_only" } } : built.output,
    provenance: { independent: true, kind: "deterministic_protocol_read_control", humanBaseline: false, termixEligible: false },
  };
}

export { classifyRange, proposeRange as proposeBoundedRange, tickToPrice, isValidTick };
