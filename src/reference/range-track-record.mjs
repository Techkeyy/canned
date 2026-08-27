import { contentHashes, nowIso } from "../core.mjs";
import { classifyRange } from "./pancakeswap.mjs";

export const TRACK_RECORD_VERSION = "range-keeper-track-record-v1";

/**
 * A track record is only worth publishing if it can also report that it is
 * empty. This threshold is the point below which no rate is shown at all.
 */
export const MINIMUM_OBSERVATIONS_FOR_RATE = 5;

/**
 * One timestamped decision, recorded when it is made and scored only later.
 * `outcome` stays null until a follow-up observation actually exists, so a
 * decision can never be graded by the same read that produced it.
 */
export function recordRangeDecision({ decisionId, benchmarkId = null, runId = null, snapshot, deliverable, observationHorizonSeconds = 86_400, recordedAt = nowIso() } = {}) {
  if (!snapshot?.pool?.address || !deliverable?.decision) throw new Error("A decision record requires the frozen snapshot and the agent decision.");
  const entry = {
    schemaVersion: 1,
    kind: "range_keeper_decision",
    methodologyVersion: TRACK_RECORD_VERSION,
    decisionId,
    benchmarkId,
    runId,
    recordedAt,
    venue: "PancakeSwap",
    chainId: snapshot.chainId,
    pool: snapshot.pool.address,
    pair: `${snapshot.pool.token0.symbol}/${snapshot.pool.token1.symbol}`,
    feeTier: snapshot.pool.fee,
    tickSpacing: snapshot.pool.tickSpacing,
    referenceBlock: { number: snapshot.asOfBlock, hash: snapshot.blockHash, timestamp: snapshot.blockTimestamp },
    positionAtDecision: {
      tokenId: snapshot.position.tokenId,
      tickLower: snapshot.position.tickLower,
      tickUpper: snapshot.position.tickUpper,
      liquidity: snapshot.position.liquidity,
      currentTick: snapshot.slot0.tick,
      inRange: deliverable.rangeStatus?.inRange ?? null,
      edgeProximityPct: deliverable.rangeStatus?.edgeProximityPct ?? null,
    },
    recommendedAction: deliverable.decision.action,
    recommendedRange: deliverable.proposedRange ? { tickLower: deliverable.proposedRange.tickLower, tickUpper: deliverable.proposedRange.tickUpper } : null,
    policyVersion: deliverable.decision.policyVersion,
    triggers: deliverable.decision.triggers,
    observationHorizonSeconds,
    outcome: null,
    outcomeNote: "Not yet observed. A decision is scored only after a later independent read of the same pool.",
  };
  return { ...entry, hashes: contentHashes(entry) };
}

/**
 * Score a past decision against a later authoritative read. This measures what
 * is actually measurable: whether the position, or the recommended replacement
 * range, still contained the price at the follow-up block.
 */
export function settleRangeDecision({ decision, followUpSnapshot, settledAt = nowIso() } = {}) {
  if (!decision || !followUpSnapshot?.slot0) throw new Error("Settling a decision requires the decision and a later snapshot.");
  if (String(followUpSnapshot.pool.address).toLowerCase() !== String(decision.pool).toLowerCase()) throw new Error("The follow-up snapshot is for a different pool.");
  if (Number(followUpSnapshot.asOfBlock) <= Number(decision.referenceBlock.number)) throw new Error("The follow-up snapshot must be later than the decision block.");
  const laterTick = followUpSnapshot.slot0.tick;
  const heldRange = classifyRange({ currentTick: laterTick, tickLower: decision.positionAtDecision.tickLower, tickUpper: decision.positionAtDecision.tickUpper, tickSpacing: decision.tickSpacing });
  const recommended = decision.recommendedRange
    ? classifyRange({ currentTick: laterTick, tickLower: decision.recommendedRange.tickLower, tickUpper: decision.recommendedRange.tickUpper, tickSpacing: decision.tickSpacing })
    : null;
  const followedAdviceInRange = decision.recommendedAction === "HOLD" ? heldRange.inRange : recommended?.inRange ?? null;
  const outcome = {
    settledAt,
    followUpBlock: { number: followUpSnapshot.asOfBlock, hash: followUpSnapshot.blockHash, timestamp: followUpSnapshot.blockTimestamp },
    elapsedSeconds: Number(followUpSnapshot.blockTimestamp) - Number(decision.referenceBlock.timestamp),
    tickAtDecision: decision.positionAtDecision.currentTick,
    tickAtFollowUp: laterTick,
    tickMoved: laterTick - decision.positionAtDecision.currentTick,
    originalRangeStillContainsPrice: heldRange.inRange,
    recommendedRangeContainsPrice: recommended ? recommended.inRange : null,
    followedAdviceInRange,
    verdict: followedAdviceInRange === null ? "unmeasurable" : followedAdviceInRange ? "advice_kept_position_in_range" : "advice_did_not_keep_position_in_range",
    note: "This measures range retention over the declared horizon. It is not a profit claim: fees earned, gas paid, and impermanent loss are not settled here.",
  };
  return { ...decision, outcome, outcomeNote: null, hashes: contentHashes({ ...decision, outcome, outcomeNote: null }) };
}

/**
 * Summarise a track record without inventing one. Below the minimum sample the
 * summary refuses to publish a rate and says so plainly.
 */
export function summarizeRangeTrackRecord({ decisions = [], minimumObservations = MINIMUM_OBSERVATIONS_FOR_RATE } = {}) {
  const settled = decisions.filter((entry) => entry?.outcome && entry.outcome.verdict !== "unmeasurable");
  const kept = settled.filter((entry) => entry.outcome.followedAdviceInRange === true);
  const pending = decisions.filter((entry) => !entry?.outcome);
  const enough = settled.length >= minimumObservations;
  const windows = settled.map((entry) => entry.outcome.elapsedSeconds).filter(Number.isFinite);
  return {
    methodologyVersion: TRACK_RECORD_VERSION,
    totalDecisions: decisions.length,
    settledDecisions: settled.length,
    pendingDecisions: pending.length,
    minimumObservations,
    hasEnoughObservations: enough,
    rangeRetentionRate: enough ? Number((kept.length / settled.length).toFixed(4)) : null,
    observationWindowSeconds: windows.length ? { shortest: Math.min(...windows), longest: Math.max(...windows) } : null,
    actionsRecommended: {
      hold: decisions.filter((entry) => entry?.recommendedAction === "HOLD").length,
      rebalance: decisions.filter((entry) => entry?.recommendedAction === "REBALANCE").length,
    },
    statement: enough
      ? `Range retention measured over ${settled.length} settled decisions. This is a range-retention record, not a profit record.`
      : `Not enough observations. ${settled.length} of ${minimumObservations} settled decisions recorded, so no rate is published.`,
    limitations: [
      "Range retention is not profit. Fees earned, gas paid, and impermanent loss are not settled here.",
      "A decision is scored only against a later independent read, never against the read that produced it.",
      "Recommendations are made on frozen mainnet state while all payment and execution stay on BSC testnet.",
    ],
    generatedAt: nowIso(),
  };
}
