import { contentHashes, nowIso } from "../core.mjs";
import { returnOverHorizon } from "./venus-yield.mjs";

export const YIELD_TRACK_RECORD_VERSION = "yield-scout-track-record-v1";

/** Below this, no rate is published at all. */
export const MINIMUM_OBSERVATIONS_FOR_RATE = 5;

/**
 * One timestamped recommendation, recorded when it is made. `outcome` stays null
 * until a later, independently sampled read of the same markets exists: scoring
 * it from the snapshot that produced it would be circular.
 */
export function recordYieldDecision({ decisionId, benchmarkId = null, runId = null, snapshot, deliverable, observationHorizonDays = null, recordedAt = nowIso() } = {}) {
  if (!snapshot?.markets || !deliverable?.decision) throw new Error("A decision record requires the frozen snapshot and the agent decision.");
  const best = deliverable.decision.recommendedMarketKey
    ? deliverable.comparison.find((entry) => entry.marketKey === deliverable.decision.recommendedMarketKey)
    : null;
  const current = deliverable.comparison.find((entry) => entry.isCurrentPosition);
  const entry = {
    schemaVersion: 1,
    kind: "yield_scout_decision",
    methodologyVersion: YIELD_TRACK_RECORD_VERSION,
    decisionId,
    benchmarkId,
    runId,
    recordedAt,
    venue: deliverable.venue,
    chainId: snapshot.chainId,
    referenceBlock: { number: snapshot.asOfBlock, hash: snapshot.blockHash, timestamp: snapshot.blockTimestamp },
    positionAtDecision: {
      marketKey: deliverable.position.marketKey,
      assetSymbol: deliverable.position.assetSymbol,
      amount: deliverable.position.amount,
      supplyAprPct: current?.supplyAprPct ?? null,
    },
    recommendedAction: deliverable.decision.action,
    recommendedMarketKey: deliverable.decision.recommendedMarketKey,
    recommendedAssetSymbol: deliverable.decision.recommendedAsset,
    recommendedSupplyAprPct: best?.supplyAprPct ?? null,
    expectedYieldAdvantagePct: best?.aprDeltaPct ?? 0,
    expectedIncrementalReturn: best?.incrementalReturnOverHorizon ?? 0,
    estimatedOneOffCost: best?.oneOffCost ?? 0,
    expectedNetBenefit: best?.netBenefitOverHorizon ?? 0,
    breakEvenDays: best?.breakEvenDays ?? null,
    declaredHorizonDays: observationHorizonDays ?? deliverable.horizon?.days ?? null,
    policyVersion: deliverable.decision.policyVersion,
    outcome: null,
    outcomeNote: "Not yet observed. A recommendation is scored only against a later independent read of the same markets.",
  };
  return { ...entry, hashes: contentHashes(entry) };
}

/**
 * Score a past recommendation against a later independent read.
 *
 * What is honestly measurable is whether the rate advantage the recommendation
 * relied on actually persisted, and what the realised difference was over the
 * elapsed period. It is not a claim about the holder's total return: fees,
 * execution price, and compounding are not settled here.
 */
export function settleYieldDecision({ decision, followUpSnapshot, settledAt = nowIso() } = {}) {
  if (!decision || !followUpSnapshot?.markets) throw new Error("Settling a recommendation requires the decision and a later snapshot.");
  if (Number(followUpSnapshot.asOfBlock) <= Number(decision.referenceBlock.number)) throw new Error("The follow-up snapshot must be later than the decision block.");
  const elapsedSeconds = Number(followUpSnapshot.blockTimestamp) - Number(decision.referenceBlock.timestamp);
  const elapsedDays = elapsedSeconds / 86_400;

  const marketAt = (key) => followUpSnapshot.markets.find((market) => market.key === key) || null;
  const heldMarket = marketAt(decision.positionAtDecision.marketKey);
  const movedMarket = decision.recommendedMarketKey ? marketAt(decision.recommendedMarketKey) : null;
  if (!heldMarket) throw new Error("The follow-up snapshot does not contain the original market.");

  const heldAprNow = heldMarket.supplyAprDecimal;
  const movedAprNow = movedMarket ? movedMarket.supplyAprDecimal : null;
  const followedAdviceApr = decision.recommendedAction === "MOVE" ? movedAprNow : heldAprNow;
  const alternativeApr = decision.recommendedAction === "MOVE" ? heldAprNow : movedAprNow;

  const amount = Number(decision.positionAtDecision.amount);
  const realisedFollowed = followedAdviceApr === null ? null : returnOverHorizon({ principal: amount, apr: followedAdviceApr, days: elapsedDays });
  const realisedAlternative = alternativeApr === null ? null : returnOverHorizon({ principal: amount, apr: alternativeApr, days: elapsedDays });
  const advantagePersisted = followedAdviceApr !== null && alternativeApr !== null ? followedAdviceApr > alternativeApr : null;

  const outcome = {
    settledAt,
    followUpBlock: { number: followUpSnapshot.asOfBlock, hash: followUpSnapshot.blockHash, timestamp: followUpSnapshot.blockTimestamp },
    elapsedSeconds,
    elapsedDays: Number(elapsedDays.toFixed(3)),
    aprAtDecisionPct: decision.recommendedAction === "MOVE" ? decision.recommendedSupplyAprPct : decision.positionAtDecision.supplyAprPct,
    aprAtFollowUpPct: followedAdviceApr === null ? null : Number((followedAdviceApr * 100).toFixed(4)),
    alternativeAprAtFollowUpPct: alternativeApr === null ? null : Number((alternativeApr * 100).toFixed(4)),
    advantagePersisted,
    realisedReturnFollowingAdvice: realisedFollowed === null ? null : Number(realisedFollowed.toFixed(4)),
    realisedReturnAlternative: realisedAlternative === null ? null : Number(realisedAlternative.toFixed(4)),
    realisedDifference: realisedFollowed === null || realisedAlternative === null ? null : Number((realisedFollowed - realisedAlternative).toFixed(4)),
    verdict: advantagePersisted === null ? "unmeasurable" : advantagePersisted ? "advantage_persisted" : "advantage_did_not_persist",
    note: "Measured on rates observed at the follow-up block, applied over the elapsed period. It is not a full return accounting: execution price, fees already paid, and compounding are not settled here.",
  };
  return { ...decision, outcome, outcomeNote: null, hashes: contentHashes({ ...decision, outcome, outcomeNote: null }) };
}

/** Summarise without inventing. Below the minimum sample, no rate is published. */
export function summarizeYieldTrackRecord({ decisions = [], minimumObservations = MINIMUM_OBSERVATIONS_FOR_RATE } = {}) {
  const settled = decisions.filter((entry) => entry?.outcome && entry.outcome.verdict !== "unmeasurable");
  const persisted = settled.filter((entry) => entry.outcome.advantagePersisted === true);
  const pending = decisions.filter((entry) => !entry?.outcome);
  const enough = settled.length >= minimumObservations;
  const elapsed = settled.map((entry) => entry.outcome.elapsedDays).filter(Number.isFinite);
  return {
    methodologyVersion: YIELD_TRACK_RECORD_VERSION,
    totalDecisions: decisions.length,
    settledDecisions: settled.length,
    pendingDecisions: pending.length,
    minimumObservations,
    hasEnoughObservations: enough,
    advantagePersistenceRate: enough ? Number((persisted.length / settled.length).toFixed(4)) : null,
    observationWindowDays: elapsed.length ? { shortest: Math.min(...elapsed), longest: Math.max(...elapsed) } : null,
    actionsRecommended: {
      hold: decisions.filter((entry) => entry?.recommendedAction === "HOLD").length,
      move: decisions.filter((entry) => entry?.recommendedAction === "MOVE").length,
    },
    statement: enough
      ? `Rate advantage persisted in ${persisted.length} of ${settled.length} settled recommendations. This measures whether the advantage held, not total return.`
      : `Not enough observations. ${settled.length} of ${minimumObservations} settled recommendations recorded, so no rate is published.`,
    limitations: [
      "Persistence of a rate advantage is not profit. Execution price, fees, and compounding are not settled here.",
      "A recommendation is scored only against a later independent read, never against the snapshot that produced it.",
      "Recommendations are made on frozen mainnet state while all payment and execution stay on BSC testnet.",
    ],
    generatedAt: nowIso(),
  };
}
