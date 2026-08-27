import { canonicalJson, contentHashes, isObject } from "../core.mjs";
import { classifyRange, isTickSpacingAligned, tickToPrice } from "./pancakeswap.mjs";
import { buildRangeKeeperDeliverable, REBALANCE_POLICY } from "./range-keeper.mjs";
import { REBALANCE_BENCHMARK_ID, REBALANCE_BENCHMARK_VERSION, REBALANCE_EVALUATOR_VERSION, rebalanceBaselineFields, rebalanceBenchControlTask } from "./rebalance-benchmark.mjs";

const NON_ANSWERS = ["no idea", "noidea", "i dont know", "i don't know", "idk", "dont know", "don't know", "unknown", "n/a", "na", "none", "?", "-", "", "not sure", "unsure", "cant tell", "can't tell", "no clue"];

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

export function isNonAnswer(value) {
  const text = normalizeText(value);
  if (!text) return true;
  const stripped = text.replace(/[.!,]+$/g, "").trim();
  if (NON_ANSWERS.includes(stripped)) return true;
  return /^(i (really )?(have )?(no idea|dont know|don't know|cant tell|can't tell)|no idea|not sure)\b/.test(stripped);
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

/**
 * Match a phrase only where it is not negated. Without this, "not close to an
 * edge" satisfies a search for "close to" and a correct answer is marked wrong.
 */
const NEGATORS = ["not ", "no ", "never ", "isn't ", "isnt ", "is not ", "aren't ", "arent ", "nowhere "];
function includesAffirmed(text, terms) {
  return terms.some((term) => {
    const needle = String(term).toLowerCase();
    let from = 0;
    for (;;) {
      const index = text.indexOf(needle, from);
      if (index < 0) return false;
      const before = text.slice(Math.max(0, index - 14), index);
      if (!NEGATORS.some((negator) => before.endsWith(negator))) return true;
      from = index + needle.length;
    }
  });
}

/** Pull every integer that could plausibly be a tick out of free text. */
function extractIntegers(text) {
  return [...String(text ?? "").matchAll(/-?\d[\d_,]*/g)]
    .map((match) => Number(match[0].replace(/[_,]/g, "")))
    .filter((value) => Number.isFinite(value));
}

/**
 * Deterministic RebalanceBench ground truth. Every value is computed from the
 * frozen snapshot and the precommitted policy. No live read, no model, and no
 * prior answer participates.
 */
export function computeRebalanceGroundTruth(definition) {
  if (definition?.benchmarkId !== REBALANCE_BENCHMARK_ID || definition?.immutable !== true) throw new Error("An immutable RebalanceBench_v1 definition is required for ground truth.");
  const snapshot = definition.frozenEvidence?.snapshot;
  if (!snapshot) throw new Error("RebalanceBench ground truth requires the frozen snapshot.");
  const { pool, slot0, position } = snapshot;
  const range = classifyRange({
    currentTick: slot0.tick,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    tickSpacing: pool.tickSpacing,
    decimals0: pool.token0.decimals,
    decimals1: pool.token1.decimals,
  });

  // The control is the same deterministic rule set applied to the same frozen
  // evidence. It is what a correct answer looks like, and it is computed here
  // rather than borrowed from the agent's deliverable.
  const control = buildRangeKeeperDeliverable({ jobId: null, task: rebalanceBenchControlTask(definition) });
  const decision = control.output.decision;
  const drift = control.output.marketContext;

  const truth = {
    evaluatorVersion: REBALANCE_EVALUATOR_VERSION,
    benchmarkId: REBALANCE_BENCHMARK_ID,
    benchmarkVersion: REBALANCE_BENCHMARK_VERSION,
    computedFrom: "frozen_snapshot_and_precommitted_policy_only",
    policyVersion: REBALANCE_POLICY.version,
    venue: "PancakeSwap",
    pool: { address: pool.address, pair: `${pool.token0.symbol}/${pool.token1.symbol}`, fee: pool.fee, tickSpacing: pool.tickSpacing },
    referenceBlock: { number: snapshot.asOfBlock, hash: snapshot.blockHash, timestamp: snapshot.blockTimestamp },
    rangeTruth: {
      status: range.status,
      inRange: range.inRange,
      currentTick: range.currentTick,
      tickLower: range.tickLower,
      tickUpper: range.tickUpper,
      widthTicks: range.widthTicks,
      ticksToLower: range.ticksToLower,
      ticksToUpper: range.ticksToUpper,
      nearestEdge: range.nearestEdge,
      ticksToNearestEdge: range.ticksToNearestEdge,
      edgeProximityPct: range.edgeProximityPct,
      priceCurrent: range.price.current,
      priceLower: range.price.lower,
      priceUpper: range.price.upper,
      priceInverted: {
        current: 1 / range.price.current,
        lower: 1 / range.price.lower,
        upper: 1 / range.price.upper,
        quote: `${pool.token0.symbol} per ${pool.token1.symbol}`,
      },
      composition: range.composition,
    },
    driftTruth: {
      available: drift.available,
      direction: drift.direction ?? null,
      tickDeltaOverLongestWindow: drift.tickDeltaOverLongestWindow ?? null,
      longestWindowSeconds: drift.longestWindowSeconds ?? null,
      windows: drift.windows ?? [],
      towardNearestEdge: drift.available
        ? (range.nearestEdge === "upper" && drift.tickDeltaOverLongestWindow > 0) || (range.nearestEdge === "lower" && drift.tickDeltaOverLongestWindow < 0)
        : null,
    },
    decisionTruth: {
      correctAction: decision.action,
      rebalanceJustified: decision.rebalanceRecommended,
      triggers: decision.triggers,
      reason: decision.reason,
      thresholds: decision.thresholds,
    },
    movementTruth: control.output.marketContext.relativeToRange,
    proposedRangeTruth: control.output.proposedRange,
    constraints: {
      tickSpacing: pool.tickSpacing,
      anyProposedRangeMustBeAligned: true,
      anyProposedRangeMustContainCurrentTick: true,
      capitalMovementAuthorized: false,
    },
  };
  return { ...truth, hashes: contentHashes(truth) };
}

const RESPONSIVE = { key: "responsive", points: 4, describe: "field answered rather than declined" };

function check(key, points, describe, predicate) {
  return { key, points, describe, predicate };
}

/**
 * Six scored dimensions, exactly the precommitted expectedOutputSchema fields.
 * Every check is satisfiable from a structured deliverable field or from the
 * equivalent prose, so a machine-readable responder earns nothing a human
 * writing sentences could not also earn.
 */
export function rebalanceRubric(truth) {
  const inRange = truth.rangeTruth.inRange;
  const edge = truth.rangeTruth.nearestEdge;
  const shouldRebalance = truth.decisionTruth.rebalanceJustified;
  const spacing = truth.constraints.tickSpacing;
  const current = truth.rangeTruth.currentTick;

  return [
    {
      dimension: "positionStatus",
      checks: [
        check("range_state_correct", 10, inRange ? "states the position is still in range" : "states the position is out of range", ({ text, structured }) => {
          const structuredState = structured?.rangeStatus?.inRange;
          if (typeof structuredState === "boolean") return structuredState === inRange;
          const saysIn = includesAny(text, ["in range", "in-range", "still in", "within range", "inside the range", "within the range", "active"]);
          const saysOut = includesAny(text, ["out of range", "out-of-range", "outside the range", "no longer in", "not in range", "inactive"]);
          return inRange ? saysIn && !saysOut : saysOut;
        }),
        check("identifies_pool_or_pair", 4, "identifies the pool, pair, or fee tier", ({ text, structured }) => Boolean(structured?.position?.pair || structured?.position?.pool) || includesAny(text, [truth.pool.pair.toLowerCase(), truth.pool.pair.split("/")[0].toLowerCase(), truth.pool.pair.split("/")[1].toLowerCase(), truth.pool.address.toLowerCase(), "pancake"])),
        check("cites_tick_or_price_evidence", 2, "cites the current tick or a price", ({ text, structured }) => structured?.rangeStatus?.currentTick !== undefined || extractIntegers(text).some((value) => value === current) || includesAny(text, ["tick", "price"])),
      ],
    },
    {
      dimension: "edgeProximity",
      checks: [
        // The nearer bound is the lower *tick*, which is the higher price in the
        // inverted quote. Both "lower" and "upper" are therefore correct English
        // for the same bound depending on which way the pair is quoted, so the
        // bound is scored on being identified unambiguously rather than on a
        // word whose meaning depends on the quote convention.
        check("nearest_bound_identified", 10, `identifies the bound at tick ${truth.rangeTruth[edge === "lower" ? "tickLower" : "tickUpper"]} as the nearer one`, ({ text, structured }) => {
          const structuredEdge = structured?.rangeStatus?.nearestEdge;
          if (structuredEdge) return structuredEdge === edge;
          const nearTick = truth.rangeTruth[edge === "lower" ? "tickLower" : "tickUpper"];
          const farTick = truth.rangeTruth[edge === "lower" ? "tickUpper" : "tickLower"];
          const numbers = extractIntegers(text);
          // Citing the near bound's tick, and not only the far one, is unambiguous.
          if (numbers.includes(nearTick) && !numbers.includes(farTick)) return true;
          const nearPrice = truth.rangeTruth[edge === "lower" ? "priceLower" : "priceUpper"];
          const farPrice = truth.rangeTruth[edge === "lower" ? "priceUpper" : "priceLower"];
          const mentionsPrice = (value) => {
            const direct = Number(value).toPrecision(7);
            const inverted = Number(1 / value).toPrecision(7);
            return [direct, inverted].some((candidate) => text.includes(String(candidate).replace(/0+$/, "").slice(0, 6)));
          };
          if (mentionsPrice(nearPrice) && !mentionsPrice(farPrice)) return true;
          // Otherwise accept a single, self-consistent edge word in either frame.
          const saysUpper = includesAny(text, ["upper", "top", "ceiling", "high end", "upper bound", "upper edge", "above"]);
          const saysLower = includesAny(text, ["lower", "bottom", "floor", "low end", "lower bound", "lower edge", "below"]);
          return saysUpper !== saysLower;
        }),
        check("proximity_assessment_correct", 6, truth.rangeTruth.edgeProximityPct !== null && truth.rangeTruth.edgeProximityPct <= 25
          ? "conveys that the position is close to an edge"
          : "conveys that the position is not close to an edge", ({ text, structured }) => {
          const pct = truth.rangeTruth.edgeProximityPct;
          if (!truth.rangeTruth.inRange) return true;
          const structuredPct = structured?.rangeStatus?.edgeProximityPct;
          if (Number.isFinite(structuredPct)) return (structuredPct <= 25) === (pct <= 25);
          const saysClose = includesAffirmed(text, ["close to", "near the edge", "nearly out", "about to leave", "at risk of leaving", "very near", "tight"]);
          const saysNotClose = includesAny(text, ["not close", "comfortably", "plenty of room", "well inside", "not near", "far from", "safe distance", "middle", "room to move", "not at risk", "healthy", "not going to", "no danger"]);
          const quantified = extractIntegers(text).includes(truth.rangeTruth.ticksToNearestEdge);
          if (pct <= 25) return saysClose && !saysNotClose;
          return (saysNotClose && !saysClose) || quantified;
        }),
      ],
    },
    {
      dimension: "marketMovement",
      checks: [
        // Tick direction is quote-dependent: here a rising tick is a falling
        // USDT-per-WBNB price, so both "up" and "down" are correct English for
        // the same move. Scoring direction alone would punish a correct answer,
        // so movement is scored against the position's own range instead.
        check("movement_relative_to_range_correct", 10, truth.driftTruth.available
          ? `describes the move as ${truth.movementTruth.directionRelativeToRange}`
          : "states that no usable price history is available", ({ text, structured }) => {
          if (!truth.driftTruth.available) return includesAny(text, ["no history", "not enough", "unavailable", "cannot tell", "can't tell", "no data", "no oracle"]);
          const structuredToward = structured?.marketContext?.relativeToRange?.towardNearestEdge;
          if (typeof structuredToward === "boolean") return structuredToward === truth.movementTruth.towardNearestEdge;
          const saysToward = includesAny(text, ["toward", "towards", "closer to the", "approaching", "drifting into", "nearing the edge", "heading for"]);
          const saysAway = includesAny(text, ["away from", "further from", "farther from", "back into the middle", "toward the centre", "toward the center", "recovered", "moved off"]);
          if (truth.movementTruth.towardNearestEdge) return saysToward && !saysAway;
          if (saysAway && !saysToward) return true;
          // A plain directional statement is accepted in either quote frame,
          // provided it is not self-contradictory.
          const rising = includesAny(text, ["rising", "rose", "up", "increased", "climbing", "higher", "upward"]);
          const falling = includesAny(text, ["falling", "fell", "down", "decreased", "dropping", "lower", "downward"]);
          const flat = includesAny(text, ["flat", "unchanged", "stable", "sideways", "little", "barely", "hardly"]);
          return (rising !== falling) || flat;
        }),
        check("movement_magnitude_correct", 6, `recognises the move as ${truth.movementTruth.materiality} relative to the range`, ({ text, structured }) => {
          if (!truth.driftTruth.available) return true;
          const structuredMateriality = structured?.marketContext?.relativeToRange?.materiality;
          if (structuredMateriality) return structuredMateriality === truth.movementTruth.materiality;
          if (truth.movementTruth.materiality === "small") return includesAny(text, ["small", "minor", "modest", "slight", "little", "barely", "stable", "not much", "narrow", "tiny", "marginal", "insignificant"]);
          if (truth.movementTruth.materiality === "large") return includesAny(text, ["large", "big", "significant", "sharp", "substantial", "major", "steep"]);
          return includesAny(text, ["moderate", "some", "noticeable", "moved"]);
        }),
      ],
    },
    {
      dimension: "rebalanceDecision",
      checks: [
        check("decision_matches_policy", 12, shouldRebalance ? "concludes a rebalance is justified" : "concludes no rebalance is justified", ({ text, structured }) => {
          const structuredAction = structured?.decision?.action;
          if (structuredAction) return shouldRebalance ? structuredAction === "REBALANCE" : structuredAction === "HOLD";
          const saysAct = includesAny(text, ["rebalance now", "should rebalance", "yes rebalance", "recommend rebalanc", "do rebalance", "reposition", "move the range", "recentre", "recenter"]);
          const saysHold = includesAny(text, ["no rebalance", "do not rebalance", "don't rebalance", "leave it", "hold", "no action", "not justified", "no need", "leave alone", "stay", "keep it"]);
          return shouldRebalance ? saysAct && !saysHold : saysHold && !saysAct;
        }),
        check("justifies_against_cost", 4, "weighs the decision against a real cost or benefit rather than asserting it", ({ text, structured }) => Boolean(structured?.decision?.reason || structured?.tradeoffs) || includesAny(text, ["gas", "fee", "cost", "impermanent", "worth", "because", "since", "still earning", "not earning"])),
      ],
    },
    {
      dimension: "proposedRange",
      checks: [
        check("proposal_consistent_with_decision", 10, shouldRebalance ? "gives a replacement range" : "correctly gives no replacement range, or gives one that is still legal", ({ text, structured, declined }) => {
          if (!shouldRebalance) {
            // Saying no range is needed is the right answer when holding.
            // Proposing one anyway is only penalised if it is itself illegal.
            if (isNoRangeNeeded(text) && !structured?.proposedRange) return true;
            const ticks = structured?.proposedRange ? [structured.proposedRange.tickLower, structured.proposedRange.tickUpper] : extractIntegers(text).filter((value) => Math.abs(value) > 1000);
            if (!ticks.length || ticks.length < 2) return true;
            const [low, high] = [Math.min(...ticks), Math.max(...ticks)];
            return low < high && isTickSpacingAligned(low, spacing) && isTickSpacingAligned(high, spacing);
          }
          if (structured?.proposedRange) return Number.isFinite(structured.proposedRange.tickLower) && Number.isFinite(structured.proposedRange.tickUpper);
          const ticks = extractIntegers(text).filter((value) => Math.abs(value) > 1000);
          return ticks.length >= 2;
        }),
        check("proposal_legal_and_contains_price", 6, shouldRebalance ? "the proposed range is tick-aligned, ordered, and contains the current tick" : "no illegal range is proposed", ({ text, structured }) => {
          const ticks = structured?.proposedRange
            ? [structured.proposedRange.tickLower, structured.proposedRange.tickUpper]
            : extractIntegers(text).filter((value) => Math.abs(value) > 1000);
          if (ticks.length < 2) return !shouldRebalance;
          const low = Math.min(...ticks);
          const high = Math.max(...ticks);
          return low < high && isTickSpacingAligned(low, spacing) && isTickSpacingAligned(high, spacing) && current >= low && current < high;
        }),
      ],
    },
    {
      dimension: "risksAndTradeoffs",
      checks: [
        check("names_a_real_cost", 8, "names a real cost of acting or of not acting", ({ text, structured }) => Boolean(structured?.tradeoffs?.costOfActing?.length) || includesAny(text, ["gas", "impermanent", "il ", "slippage", "fees reset", "stop earning", "no fees", "out of range", "exposure", "one asset", "conversion"])),
        check("no_capital_movement_claim", 4, "does not claim capital was moved and does not recommend an unbounded action", ({ text, structured }) => {
          if (structured?.execution?.automaticActionTaken === false || structured?.execution?.capitalMoved === false) return true;
          return !includesAny(text, ["i moved", "i rebalanced it", "i executed", "i swapped", "i withdrew", "unlimited approval", "approve unlimited"]);
        }),
        check("acknowledges_uncertainty", 4, "acknowledges that a single snapshot does not predict the next move", ({ text, structured }) => Boolean(structured?.evidence?.limitations?.length) || includesAny(text, ["may", "might", "could", "uncertain", "not a forecast", "cannot predict", "can't predict", "no guarantee", "if price", "risk", "snapshot", "assumption"])),
      ],
    },
  ];
}

const NO_RANGE_NEEDED = ["none", "no", "n/a", "na", "not needed", "no new range", "none needed", "nothing", "no range", "not applicable", "no change", "leave as is", "unchanged"];

/**
 * "None" is a non-answer for most fields, but for the proposed range it is the
 * correct answer whenever holding is correct. Treating it as a decline would
 * penalise the right call.
 */
function isNoRangeNeeded(value) {
  const text = normalizeText(value).replace(/[.!,]+$/g, "").trim();
  if (!text) return false;
  // "no idea" is a decline, not a decision that no new range is needed.
  if (/^(no idea|no clue|not sure|unsure|dont know|don't know|idk|unknown|cant tell|can't tell)\b/.test(text)) return false;
  return NO_RANGE_NEEDED.includes(text)
    || /^(none|no|n\/a|nothing)\b/.test(text)
    || includesAny(text, ["no new range", "none needed", "not needed", "no rebalance", "no range change", "keep the current range", "leave the range"]);
}


function dimensionView({ field, submission, structuredFor, holdIsCorrect = false }) {
  const rawValue = submission?.[field];
  const structured = structuredFor ? structuredFor(field) : null;
  const source = structured === null || structured === undefined ? rawValue : canonicalJson(structured);
  const text = normalizeText(structured === null || structured === undefined ? rawValue : `${rawValue ?? ""} ${canonicalJson(structured)}`);
  const declined = field === "proposedRange" && holdIsCorrect && isNoRangeNeeded(rawValue) ? false : isNonAnswer(source);
  return { rawValue: rawValue ?? null, text, structured, declined };
}

export function gradeRebalanceResponse({ truth, submission, structuredFor = null, responder }) {
  const rubric = rebalanceRubric(truth);
  const dimensions = rubric.map(({ dimension, checks }) => {
    const view = dimensionView({ field: dimension, submission, structuredFor, holdIsCorrect: truth.decisionTruth.rebalanceJustified === false });
    const responsive = !view.declined;
    const checkResults = checks.map((item) => {
      const passed = responsive ? Boolean(item.predicate({ ...view, declined: view.declined })) : false;
      return { key: item.key, describe: item.describe, points: item.points, awarded: passed ? item.points : 0, passed };
    });
    const awarded = (responsive ? RESPONSIVE.points : 0) + checkResults.reduce((total, item) => total + item.awarded, 0);
    const available = RESPONSIVE.points + checks.reduce((total, item) => total + item.points, 0);
    return {
      dimension,
      responsive,
      declined: view.declined,
      rawValue: view.rawValue,
      awarded,
      available,
      checks: [{ key: RESPONSIVE.key, describe: RESPONSIVE.describe, points: RESPONSIVE.points, awarded: responsive ? RESPONSIVE.points : 0, passed: responsive }, ...checkResults],
    };
  });
  const awarded = dimensions.reduce((total, item) => total + item.awarded, 0);
  const available = dimensions.reduce((total, item) => total + item.available, 0);
  const result = {
    evaluatorVersion: truth.evaluatorVersion,
    benchmarkId: truth.benchmarkId,
    responder,
    groundTruthHash: truth.hashes.keccak256,
    qualityScore: available > 0 ? Number(((awarded / available) * 100).toFixed(2)) : null,
    awarded,
    available,
    declinedDimensions: dimensions.filter((item) => item.declined).map((item) => item.dimension),
    completeness: Number(((dimensions.filter((item) => item.responsive).length / dimensions.length) * 100).toFixed(2)),
    correctItems: dimensions.flatMap((item) => item.checks.filter((entry) => entry.passed).map((entry) => `${item.dimension}.${entry.key}`)),
    missedItems: dimensions.flatMap((item) => item.checks.filter((entry) => !entry.passed).map((entry) => `${item.dimension}.${entry.key}`)),
    unsupportedClaims: dimensions.flatMap((item) => item.checks.filter((entry) => !entry.passed && entry.key.startsWith("no_")).map((entry) => `${item.dimension}.${entry.key}`)),
    dimensions,
  };
  return { ...result, hashes: contentHashes(result) };
}

/** Map the Range Keeper deliverable onto the six precommitted dimensions. */
export function rangeKeeperStructuredView(output) {
  if (!isObject(output)) return () => null;
  const views = {
    positionStatus: { rangeStatus: output.rangeStatus, position: output.position },
    edgeProximity: { rangeStatus: output.rangeStatus },
    marketMovement: { marketContext: output.marketContext },
    rebalanceDecision: { decision: output.decision, tradeoffs: output.tradeoffs },
    proposedRange: { proposedRange: output.proposedRange, decision: output.decision },
    risksAndTradeoffs: { tradeoffs: output.tradeoffs, execution: output.execution, evidence: output.evidence },
  };
  return (dimension) => views[dimension] ?? null;
}

export function rangeKeeperSubmissionFromOutput(output) {
  const view = rangeKeeperStructuredView(output);
  return Object.fromEntries(rebalanceBaselineFields().map((field) => [field, isObject(output) ? canonicalJson(view(field)) : null]));
}

export { tickToPrice };
