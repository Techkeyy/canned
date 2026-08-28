import { canonicalJson, contentHashes, nowIso } from "../core.mjs";
import { CATEGORIES } from "../domain.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ORIGIN } from "./constants.mjs";
import { breakEvenDays, returnOverHorizon, validateAuthoritativeYieldSnapshot, VENUS_MAINNET_CORE } from "./venus-yield.mjs";

export const YIELD_SCOUT_TASK_VERSION = "1.0.0";

/**
 * Reallocation policy, declared before any snapshot is frozen and before either
 * responder answers.
 *
 * The highest advertised yield is not automatically the right destination. A
 * move costs a swap and gas, concentrates the holder in a new market and a new
 * issuer, and is only worth making if the advantage survives those costs inside
 * the holder's own horizon.
 */
export const YIELD_POLICY = Object.freeze({
  version: "yield-scout-policy-v1",
  // A move must repay its one-off cost within the holder's declared horizon.
  breakEvenMustBeWithinHorizon: true,
  // And must still be ahead after costs by a margin worth the operational risk.
  minimumNetBenefitBpsOfPosition: 5,
  // Exit risk: a destination must be materially larger than the position.
  minimumLiquidityCoverMultiple: 20,
  // Concentration: the position must not become a large share of the market.
  maximumPositionShareOfMarketBps: 500,
  rationale: "A reallocation is recommended only when a destination is materially larger than the position, the position stays a small share of that market, the move repays its cost within the declared horizon, and the net benefit still clears the minimum margin. Otherwise holding is correct.",
});

/** Transaction sequence a reallocation would require, used to price gas. */
export const REALLOCATION_STEPS = Object.freeze([
  { step: "redeem", contract: "Venus vToken (source market)", method: "redeemUnderlying", gasUnits: 250_000 },
  { step: "swap", contract: "PancakeSwap SmartRouter", method: "exactInput", gasUnits: 220_000 },
  { step: "approve", contract: "destination asset", method: "approve", gasUnits: 60_000 },
  { step: "supply", contract: "Venus vToken (destination market)", method: "mint", gasUnits: 300_000 },
]);

export function validateYieldScoutTask(task = {}) {
  const errors = [];
  if (!task.authoritativeSnapshot) errors.push("authoritative_snapshot_required");
  if (task.authoritativeSnapshot && !validateAuthoritativeYieldSnapshot(task.authoritativeSnapshot).valid) errors.push("authoritative_snapshot_invalid");
  if (!task.position || !task.position.assetSymbol) errors.push("current_position_required");
  if (!(Number(task.position?.amount) > 0)) errors.push("position_amount_required");
  if (!(Number(task.horizonDays) > 0)) errors.push("horizon_required");
  if (!task.costs || task.costs.gasCostNative === undefined) errors.push("cost_inputs_required");
  return { valid: errors.length === 0, errors };
}

function evaluateCandidate({ market, position, horizonDays, costs, snapshot, policy, nativePriceInAsset }) {
  const isCurrent = market.key === position.marketKey;
  const amount = Number(position.amount);
  const currentMarket = snapshot.markets.find((entry) => entry.key === position.marketKey);
  const aprDelta = market.supplyAprDecimal - currentMarket.supplyAprDecimal;

  const swapQuote = isCurrent ? null : (costs.swapRoutes || []).find((route) => route.toMarketKey === market.key) || null;
  const swapCostFraction = isCurrent ? 0 : swapQuote?.bestCostFraction ?? null;
  const swapCostAsset = swapCostFraction === null ? null : amount * swapCostFraction;
  const gasCostAsset = isCurrent ? 0 : Number(costs.gasCostNative) * Number(nativePriceInAsset);
  const oneOffCost = swapCostAsset === null ? null : swapCostAsset + gasCostAsset;

  const grossReturn = returnOverHorizon({ principal: amount, apr: market.supplyAprDecimal, days: horizonDays });
  const incrementalGross = returnOverHorizon({ principal: amount, apr: aprDelta, days: horizonDays });
  const netBenefit = oneOffCost === null ? null : incrementalGross - oneOffCost;
  const netBenefitBps = netBenefit === null ? null : (netBenefit / amount) * 10_000;
  const breakEven = isCurrent ? 0 : breakEvenDays({ principal: amount, aprDelta, oneOffCost });

  const liquidityAsset = Number(market.cash) / 10 ** market.assetDecimals;
  const liquidityCoverMultiple = amount > 0 ? liquidityAsset / amount : null;
  const positionShareOfMarketBps = liquidityAsset > 0 ? (amount / liquidityAsset) * 10_000 : null;

  const disqualifiers = [];
  if (!isCurrent) {
    if (swapCostFraction === null) disqualifiers.push("no_usable_swap_route");
    if (liquidityCoverMultiple !== null && liquidityCoverMultiple < policy.minimumLiquidityCoverMultiple) disqualifiers.push("insufficient_destination_liquidity");
    if (positionShareOfMarketBps !== null && positionShareOfMarketBps > policy.maximumPositionShareOfMarketBps) disqualifiers.push("position_too_large_a_share_of_market");
    if (policy.breakEvenMustBeWithinHorizon && (breakEven === null || breakEven > horizonDays)) disqualifiers.push("does_not_break_even_within_horizon");
    if (netBenefitBps !== null && netBenefitBps < policy.minimumNetBenefitBpsOfPosition) disqualifiers.push("net_benefit_below_minimum");
    if (netBenefit !== null && netBenefit <= 0) disqualifiers.push("no_net_benefit");
  }

  return {
    marketKey: market.key,
    vToken: market.vToken,
    assetSymbol: market.assetSymbol,
    isCurrentPosition: isCurrent,
    supplyAprPct: Number((market.supplyAprDecimal * 100).toFixed(4)),
    supplyApyPct: Number((market.supplyApyDecimal * 100).toFixed(4)),
    aprDeltaPct: Number((aprDelta * 100).toFixed(4)),
    utilisationBps: market.utilisationBps,
    liquidityAsset: Number(liquidityAsset.toFixed(2)),
    liquidityCoverMultiple: liquidityCoverMultiple === null ? null : Number(liquidityCoverMultiple.toFixed(2)),
    positionShareOfMarketBps: positionShareOfMarketBps === null ? null : Number(positionShareOfMarketBps.toFixed(2)),
    incentivesIncluded: market.incentivesIncluded,
    grossReturnOverHorizon: Number(grossReturn.toFixed(4)),
    incrementalReturnOverHorizon: Number(incrementalGross.toFixed(4)),
    swapRoute: swapQuote ? { kind: swapQuote.bestRoute?.kind ?? null, hops: swapQuote.bestRoute?.hops ?? null, fees: swapQuote.bestRoute?.fees ?? null, costFraction: swapCostFraction, costPct: swapCostFraction === null ? null : Number((swapCostFraction * 100).toFixed(4)) } : null,
    swapCostAsset: swapCostAsset === null ? null : Number(swapCostAsset.toFixed(4)),
    gasCostAsset: Number(gasCostAsset.toFixed(4)),
    oneOffCost: oneOffCost === null ? null : Number(oneOffCost.toFixed(4)),
    netBenefitOverHorizon: netBenefit === null ? null : Number(netBenefit.toFixed(4)),
    netBenefitBps: netBenefitBps === null ? null : Number(netBenefitBps.toFixed(2)),
    breakEvenDays: breakEven === null ? null : Number(breakEven.toFixed(2)),
    qualifies: isCurrent ? true : disqualifiers.length === 0,
    disqualifiers,
  };
}

/**
 * The Yield Scout deliverable. It compares declared venues on the same frozen
 * state, prices the move honestly, and recommends holding whenever moving does
 * not pay. It never moves capital.
 */
export function buildYieldScoutDeliverable({ jobId = null, task = {}, snapshot = task.authoritativeSnapshot, observedAt = nowIso(), policy = YIELD_POLICY } = {}) {
  const validation = validateYieldScoutTask({ ...task, authoritativeSnapshot: snapshot });
  if (!validation.valid) {
    return {
      ok: false,
      status: "insufficient_authoritative_data",
      errors: validation.errors,
      output: {
        schemaVersion: YIELD_SCOUT_TASK_VERSION,
        origin: REFERENCE_ORIGIN,
        category: CATEGORIES.YIELD_OPTIMISATION,
        jobId: jobId === null ? null : Number(jobId),
        status: "INSUFFICIENT_AUTHORITATIVE_DATA",
        recommendation: "Do not act. Supply an authoritative multi-market yield snapshot, the current position, the horizon, and the cost inputs before comparing venues.",
      },
    };
  }

  const { position, horizonDays, costs } = task;
  const nativePriceInAsset = Number(costs.nativePriceInAsset ?? 0);
  const candidates = snapshot.markets
    .map((market) => evaluateCandidate({ market, position, horizonDays, costs, snapshot, policy, nativePriceInAsset }))
    .sort((left, right) => (right.netBenefitOverHorizon ?? -Infinity) - (left.netBenefitOverHorizon ?? -Infinity));

  const current = candidates.find((candidate) => candidate.isCurrentPosition);
  const movable = candidates.filter((candidate) => !candidate.isCurrentPosition && candidate.qualifies);
  const best = movable.length ? movable[0] : null;
  const shouldMove = Boolean(best);
  const rejected = candidates.filter((candidate) => !candidate.isCurrentPosition && !candidate.qualifies);
  const highestApr = candidates.reduce((top, candidate) => (candidate.supplyAprPct > top.supplyAprPct ? candidate : top), candidates[0]);

  const output = {
    schemaVersion: YIELD_SCOUT_TASK_VERSION,
    origin: REFERENCE_ORIGIN,
    category: CATEGORIES.YIELD_OPTIMISATION,
    jobId: jobId === null ? null : Number(jobId),
    observedAt,
    venue: "Venus",
    position: {
      protocol: "Venus",
      poolType: snapshot.poolType,
      chainId: snapshot.chainId,
      marketKey: position.marketKey,
      assetSymbol: position.assetSymbol,
      amount: Number(position.amount),
      currentSupplyAprPct: current.supplyAprPct,
      currentSupplyApyPct: current.supplyApyPct,
      asOfBlock: snapshot.asOfBlock,
      source: snapshot.source,
    },
    horizon: { days: Number(horizonDays), basis: "simple, non-compounded return over the declared horizon" },
    comparison: candidates,
    decision: {
      action: shouldMove ? "MOVE" : "HOLD",
      moveRecommended: shouldMove,
      recommendedMarketKey: best ? best.marketKey : null,
      recommendedAsset: best ? best.assetSymbol : null,
      policyVersion: policy.version,
      thresholds: {
        minimumNetBenefitBpsOfPosition: policy.minimumNetBenefitBpsOfPosition,
        minimumLiquidityCoverMultiple: policy.minimumLiquidityCoverMultiple,
        maximumPositionShareOfMarketBps: policy.maximumPositionShareOfMarketBps,
        breakEvenMustBeWithinHorizon: policy.breakEvenMustBeWithinHorizon,
      },
      expectedNetBenefit: best ? best.netBenefitOverHorizon : 0,
      expectedIncrementalReturn: best ? best.incrementalReturnOverHorizon : 0,
      breakEvenDays: best ? best.breakEvenDays : null,
      reason: shouldMove
        ? `Moving to ${best.assetSymbol} clears every policy threshold: the destination holds ${best.liquidityCoverMultiple}x the position, the move repays its cost in ${best.breakEvenDays} days inside a ${horizonDays}-day horizon, and it is ahead by ${best.netBenefitBps} bps after costs.`
        : `No destination clears the policy thresholds, so staying in ${current.assetSymbol} is correct. Moving would cost more than the yield advantage returns over ${horizonDays} days.`,
      highestAdvertisedYield: { marketKey: highestApr.marketKey, assetSymbol: highestApr.assetSymbol, supplyAprPct: highestApr.supplyAprPct, isTheRecommendation: best ? highestApr.marketKey === best.marketKey : false },
      rejectedCandidates: rejected.map((candidate) => ({ marketKey: candidate.marketKey, assetSymbol: candidate.assetSymbol, supplyAprPct: candidate.supplyAprPct, disqualifiers: candidate.disqualifiers })),
    },
    costs: {
      gasCostNative: Number(costs.gasCostNative),
      gasCostAsset: best ? best.gasCostAsset : Number(costs.gasCostNative) * nativePriceInAsset,
      gasPriceWei: costs.gasPriceWei ?? null,
      transactionSequence: REALLOCATION_STEPS,
      swapPricing: "Both a direct and a routed quote were taken from the venue; the cheaper route prices the move.",
    },
    risks: {
      identified: buildRisks({ current, best, shouldMove, candidates }),
      note: "These are the risks a holder accepts, not a prediction. Yields move with utilisation and are not fixed for the horizon.",
    },
    execution: {
      mode: "recommendation_only",
      automaticActionTaken: false,
      capitalMoved: false,
      reason: "Canned Yield Scout v1 compares and recommends. It never withdraws, supplies, swaps, borrows, repays, bridges, or approves spending.",
      futureBoundedPlan: shouldMove ? boundedYieldPlan({ position, best, policy, horizonDays }) : null,
    },
    confidence: {
      marketsCompared: candidates.length,
      allMarketsSameBlock: true,
      incentivesVerifiedZero: snapshot.markets.every((market) => market.incentivesIncluded === true),
      missingData: snapshot.markets.filter((market) => market.venusSupplySpeed === null).map((market) => `${market.key}:incentive_speed_unavailable`),
      limitations: [
        "Supply rates move with utilisation; the figures describe one block, not the horizon.",
        "Returns are simple over the horizon, not compounded.",
        "Swap costs are a quote at one block, not a guaranteed execution price.",
      ],
    },
    evidence: {
      authoritativeProtocol: "Venus",
      readSource: snapshot.readPlan || null,
      snapshotHash: contentHashes(snapshot).keccak256,
      venueContracts: { comptroller: VENUS_MAINNET_CORE.comptroller, markets: snapshot.markets.map((market) => ({ key: market.key, vToken: market.vToken })) },
    },
  };
  return { ok: true, status: "delivered", output, canonicalOutput: canonicalJson(output) };
}

function buildRisks({ current, best, shouldMove, candidates }) {
  const risks = [
    { risk: "yield_is_variable", detail: "Venus supply rates follow utilisation and can fall at any block; the advantage is not locked in." },
  ];
  if (shouldMove) {
    risks.push({ risk: "issuer_risk", detail: `Moving from ${current.assetSymbol} to ${best.assetSymbol} exchanges one stablecoin issuer's risk for another's.` });
    risks.push({ risk: "destination_liquidity", detail: `The destination market holds ${best.liquidityAsset} ${best.assetSymbol}, ${best.liquidityCoverMultiple}x the position. A thinner market is harder to exit in stress.` });
    risks.push({ risk: "execution_price", detail: "The swap is priced from a quote. Real execution can differ, and the quoted advantage can disappear." });
    if (best.swapRoute?.costFraction !== null && best.swapRoute?.costFraction < 0) {
      risks.push({ risk: "peg_deviation", detail: `The swap is currently favourable because ${best.assetSymbol} trades slightly below ${current.assetSymbol}. That discount is also the risk being taken on.` });
    }
  } else {
    risks.push({ risk: "opportunity_cost", detail: "Holding forgoes a higher advertised yield elsewhere; the policy judged that the advantage does not survive costs." });
  }
  const thin = candidates.filter((candidate) => !candidate.isCurrentPosition && candidate.disqualifiers.includes("insufficient_destination_liquidity"));
  if (thin.length) risks.push({ risk: "thin_alternatives", detail: `${thin.map((candidate) => candidate.assetSymbol).join(", ")} advertise yield but were rejected on destination liquidity.` });
  return risks;
}

/**
 * The shape a later Altana session would be scoped to. Declared so the execution
 * boundary is designed rather than retrofitted; nothing here grants anything.
 */
export function boundedYieldPlan({ position, best, policy, horizonDays }) {
  return {
    status: "PLANNED_NOT_AUTHORIZED",
    network: "bsc-testnet",
    chainId: REFERENCE_CHAIN_ID,
    protocolAllowlist: ["Venus", "PancakeSwap"],
    contractAllowlist: [`Venus ${position.marketKey}`, `Venus ${best.marketKey}`, "PancakeSwap SmartRouter"],
    methodAllowlist: ["redeemUnderlying", "exactInput", "approve", "mint"],
    forbidden: ["borrow", "repayBorrow", "transferFrom to an external address", "unlimited allowance", "arbitrary calldata", "bridging"],
    asset: position.assetSymbol,
    maximumAmount: Number(position.amount),
    maximumApprovalPerStep: Number(position.amount),
    minimumAcceptableNetBenefitBps: policy.minimumNetBenefitBpsOfPosition,
    maximumSwapCostBps: 50,
    horizonDays: Number(horizonDays),
    expirySeconds: 900,
    revocable: true,
    requiresOperatorConfirmation: true,
    note: "No Altana session exists for this plan. It is a declared boundary, not an authorization.",
  };
}

/** Independent deterministic control: same frozen evidence, no agent, no action. */
export function buildIndependentYieldControl({ task = {}, snapshot = task.authoritativeSnapshot } = {}) {
  const built = buildYieldScoutDeliverable({ jobId: null, task, snapshot });
  return {
    ...built,
    output: built.output ? { ...built.output, origin: "CANNED_INDEPENDENT_CONTROL", control: true, execution: { ...built.output.execution, mode: "control_only" } } : built.output,
    provenance: { independent: true, kind: "deterministic_protocol_read_control", humanBaseline: false, termixEligible: false },
  };
}
