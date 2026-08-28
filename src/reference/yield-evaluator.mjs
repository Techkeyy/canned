import { canonicalJson, contentHashes, isObject } from "../core.mjs";
import { buildYieldScoutDeliverable, YIELD_POLICY } from "./yield-scout.mjs";
import { YIELD_BENCHMARK_ID, YIELD_BENCHMARK_VERSION, YIELD_EVALUATOR_VERSION, yieldBaselineFields, yieldBenchControlTask } from "./yield-benchmark.mjs";

/**
 * Declined answers only. "None" and "no" are deliberately absent: they are real
 * answers to several of these questions, and RebalanceBench showed that
 * conflating them with a decline penalises a correct response.
 */
const DECLINED = ["no idea", "noidea", "i dont know", "i don't know", "idk", "dont know", "don't know", "unknown", "n/a", "not sure", "unsure", "cant tell", "can't tell", "no clue", "?", "-", ""];

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[,]/g, "").replace(/\s+/g, " ").trim();
}

export function isDeclined(value) {
  const text = normalizeText(value);
  if (!text) return true;
  const stripped = text.replace(/[.!]+$/g, "").trim();
  if (DECLINED.includes(stripped)) return true;
  return /^(i (really )?(have )?(no idea|dont know|don't know|cant tell|can't tell)|no idea|not sure|unsure)\b/.test(stripped);
}

const NEGATORS = ["not ", "no ", "never ", "isn't ", "isnt ", "is not ", "aren't ", "arent ", "wouldn't ", "wouldnt ", "would not ", "don't ", "dont ", "do not "];

function includesAny(text, terms) {
  return terms.some((term) => text.includes(String(term).toLowerCase()));
}

/** Match a phrase only where it is not negated. */
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

/**
 * A yes/no question deserves a yes/no answer. "yeah", "i would", "definitely"
 * all mean yes; this reads the sentiment rather than demanding a keyword.
 */
export function affirmation(value) {
  const text = normalizeText(value).replace(/[.!]+$/g, "").trim();
  if (!text || isDeclined(text)) return null;
  // "i would not move" must not satisfy the affirmative branch just because it
  // starts with "i would"; the negative forms are excluded explicitly.
  const yes = /^(yes|yeah|yep|yup|y|sure|definitely|absolutely|correct|true|it is|yes it is|i would(?! not)|i'd(?! not)|id(?! not)|move|move it)\b/.test(text) || includesAffirmed(text, ["i would move", "worth it", "worth moving", "yes it is", "i'd move", "would move", "makes sense to move", "should move"]);
  const no = /^(no|nope|nah|n|negative|false|dont|don't|do not|i wouldn't|i wouldnt|i would not|hold|stay|leave it)\b/.test(text) || includesAny(text, ["not worth", "wouldn't move", "wouldnt move", "would not move", "no i would", "not worth it", "stay put", "leave it where", "not move", "don't move", "dont move", "no move"]);
  if (yes && !no) return true;
  if (no && !yes) return false;
  return null;
}

/** Pull numbers out of prose, including percentages and currency amounts. */
export function extractNumbers(text) {
  return [...String(text ?? "").replace(/,/g, "").matchAll(/-?\d+(?:\.\d+)?/g)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value));
}

/** True when any number in the text is within tolerance of the target. */
function matchesNumber(text, target, tolerance) {
  if (target === null || target === undefined) return false;
  return extractNumbers(text).some((value) => Math.abs(value - Number(target)) <= tolerance);
}

/** True when any number matches the target within a relative fraction. */
function matchesRelative(text, target, fraction) {
  if (!Number.isFinite(target) || target === 0) return false;
  const allowed = Math.abs(target) * fraction;
  return extractNumbers(text).some((value) => Math.abs(value - target) <= allowed);
}

/**
 * Deterministic YieldBench ground truth, computed from the frozen snapshot and
 * the precommitted policy only. No live read, no model, no prior answer.
 */
export function computeYieldGroundTruth(definition) {
  if (definition?.benchmarkId !== YIELD_BENCHMARK_ID || definition?.immutable !== true) throw new Error("An immutable YieldBench_v1 definition is required for ground truth.");
  const control = buildYieldScoutDeliverable({ jobId: null, task: yieldBenchControlTask(definition) });
  if (!control.ok) throw new Error(`The control could not be computed: ${control.errors?.join(", ")}`);
  const output = control.output;
  const current = output.comparison.find((entry) => entry.isCurrentPosition);
  const best = output.decision.recommendedMarketKey ? output.comparison.find((entry) => entry.marketKey === output.decision.recommendedMarketKey) : null;
  const highest = output.decision.highestAdvertisedYield;

  const truth = {
    evaluatorVersion: YIELD_EVALUATOR_VERSION,
    benchmarkId: YIELD_BENCHMARK_ID,
    benchmarkVersion: YIELD_BENCHMARK_VERSION,
    computedFrom: "frozen_snapshot_and_precommitted_policy_only",
    policyVersion: YIELD_POLICY.version,
    venue: definition.venue,
    referenceBlock: definition.referenceBlock,
    horizonDays: definition.horizonDays,
    position: { marketKey: current.marketKey, assetSymbol: current.assetSymbol, amount: output.position.amount, supplyAprPct: current.supplyAprPct },
    decisionTruth: {
      correctAction: output.decision.action,
      moveRecommended: output.decision.moveRecommended,
      correctMarketKey: output.decision.recommendedMarketKey,
      correctAssetSymbol: output.decision.recommendedAsset,
      reason: output.decision.reason,
      thresholds: output.decision.thresholds,
    },
    arithmeticTruth: best
      ? {
          yieldAdvantagePct: best.aprDeltaPct,
          incrementalReturnOverHorizon: best.incrementalReturnOverHorizon,
          swapCostPct: best.swapRoute?.costPct ?? null,
          swapCostAsset: best.swapCostAsset,
          gasCostAsset: best.gasCostAsset,
          oneOffCost: best.oneOffCost,
          netBenefitOverHorizon: best.netBenefitOverHorizon,
          netBenefitBps: best.netBenefitBps,
          breakEvenDays: best.breakEvenDays,
          movePaysForItselfImmediately: best.breakEvenDays === 0,
        }
      : null,
    highestAdvertisedYield: { marketKey: highest.marketKey, assetSymbol: highest.assetSymbol, supplyAprPct: highest.supplyAprPct, isTheRecommendation: highest.isTheRecommendation },
    candidates: output.comparison.map((entry) => ({ marketKey: entry.marketKey, assetSymbol: entry.assetSymbol, supplyAprPct: entry.supplyAprPct, qualifies: entry.qualifies, disqualifiers: entry.disqualifiers, netBenefitOverHorizon: entry.netBenefitOverHorizon, liquidityCoverMultiple: entry.liquidityCoverMultiple })),
    riskTruth: output.risks.identified.map((entry) => entry.risk),
    constraints: { capitalMovementAuthorized: false, boundedActionRequired: true },
  };
  return { ...truth, hashes: contentHashes(truth) };
}

const RESPONSIVE = { key: "responsive", points: 4, describe: "field answered rather than declined" };

function check(key, points, describe, predicate) {
  return { key, points, describe, predicate };
}

/**
 * Six dimensions, exactly the precommitted expectedOutputSchema fields.
 * Every check is satisfiable from prose or from a structured deliverable, and
 * numeric checks use the tolerances declared in the frozen benchmark.
 */
export function yieldRubric(truth) {
  const shouldMove = truth.decisionTruth.moveRecommended;
  const correctAsset = truth.decisionTruth.correctAssetSymbol;
  const currentAsset = truth.position.assetSymbol;
  const arithmetic = truth.arithmeticTruth;
  const assetNames = truth.candidates.map((entry) => entry.assetSymbol.toLowerCase());

  return [
    {
      dimension: "chosenOption",
      checks: [
        check("names_the_correct_option", 16, shouldMove ? `identifies ${correctAsset} as the option to choose` : `identifies staying in ${currentAsset} as the option to choose`, ({ text, structured }) => {
          const structuredChoice = structured?.decision?.recommendedAsset ?? (structured?.decision?.action === "HOLD" ? currentAsset : null);
          if (structuredChoice) return String(structuredChoice).toLowerCase() === String(shouldMove ? correctAsset : currentAsset).toLowerCase();
          const target = String(shouldMove ? correctAsset : currentAsset).toLowerCase();
          const mentionsTarget = text.includes(target);
          // Naming several options is not a choice; the answer must not point
          // at a different asset as the pick.
          const others = assetNames.filter((name) => name !== target && name !== currentAsset.toLowerCase());
          const mentionsOther = others.some((name) => text.includes(name));
          if (mentionsTarget && !mentionsOther) return true;
          if (!shouldMove) return includesAffirmed(text, ["stay", "hold", "leave it", "current", "keep", "do nothing", "no change"]);
          return mentionsTarget && includesAffirmed(text, ["choose", "pick", "move to", "go with", "best", "switch to"]);
        }),
        check("does_not_pick_a_disqualified_option", 4, "does not choose an option the policy rules out", ({ text, structured }) => {
          const rejected = truth.candidates.filter((entry) => !entry.qualifies && entry.assetSymbol.toLowerCase() !== currentAsset.toLowerCase());
          if (!rejected.length) return true;
          if (structured?.decision?.recommendedAsset) return !rejected.some((entry) => entry.assetSymbol.toLowerCase() === String(structured.decision.recommendedAsset).toLowerCase());
          return !rejected.some((entry) => text.includes(entry.assetSymbol.toLowerCase()) && includesAffirmed(text, ["choose " + entry.assetSymbol.toLowerCase(), "move to " + entry.assetSymbol.toLowerCase(), "pick " + entry.assetSymbol.toLowerCase()]));
        }),
      ],
    },
    {
      dimension: "moveDecision",
      checks: [
        check("move_decision_correct", 14, shouldMove ? "concludes the position should move" : "concludes the position should stay", ({ text, structured }) => {
          const structuredAction = structured?.decision?.action;
          if (structuredAction) return shouldMove ? structuredAction === "MOVE" : structuredAction === "HOLD";
          const said = affirmation(text);
          if (said !== null) return said === shouldMove;
          const saysMove = includesAffirmed(text, ["move", "switch", "reallocate", "shift", "transfer it"]);
          const saysStay = includesAny(text, ["stay", "hold", "leave it", "do nothing", "keep it", "not move", "no move"]);
          return shouldMove ? saysMove && !saysStay : saysStay && !saysMove;
        }),
      ],
    },
    {
      dimension: "yieldAdvantage",
      checks: [
        check("yield_advantage_correct", 12, arithmetic ? `states the advantage as about ${arithmetic.yieldAdvantagePct} percentage points` : "states that no option offers a worthwhile advantage", ({ text, structured }) => {
          if (!arithmetic) return includesAny(text, ["none", "no advantage", "not better", "nothing", "no gain", "negligible", "zero"]);
          const structuredDelta = structured?.decision?.expectedIncrementalReturn !== undefined ? structured?.comparison?.find?.((entry) => entry.marketKey === truth.decisionTruth.correctMarketKey)?.aprDeltaPct : undefined;
          if (Number.isFinite(structuredDelta)) return Math.abs(structuredDelta - arithmetic.yieldAdvantagePct) <= 0.15;
          // Accept the difference in percentage points, the same figure in basis
          // points, or the two rates stated so the difference is implied.
          if (matchesNumber(text, arithmetic.yieldAdvantagePct, 0.15)) return true;
          if (matchesNumber(text, arithmetic.yieldAdvantagePct * 100, 15)) return true;
          const target = truth.candidates.find((entry) => entry.marketKey === truth.decisionTruth.correctMarketKey);
          const statesBothRates = target && matchesNumber(text, target.supplyAprPct, 0.15) && matchesNumber(text, truth.position.supplyAprPct, 0.15);
          return Boolean(statesBothRates);
        }),
        check("advantage_direction_sane", 4, "does not overstate the advantage", ({ text, structured }) => {
          if (!arithmetic) return true;
          if (structured) return true;
          const numbers = extractNumbers(text);
          // Reject an answer claiming an advantage several times the real one.
          return !numbers.some((value) => value > 0 && value < 100 && value > arithmetic.yieldAdvantagePct * 5 && value < 100);
        }),
      ],
    },
    {
      dimension: "worthItAfterCosts",
      checks: [
        check("worth_it_conclusion_correct", 10, shouldMove ? "concludes the advantage survives costs over the horizon" : "concludes the advantage does not survive costs", ({ text, structured }) => {
          if (structured?.decision?.moveRecommended !== undefined) return structured.decision.moveRecommended === shouldMove;
          const said = affirmation(text);
          if (said !== null) return said === shouldMove;
          const worth = includesAffirmed(text, ["worth it", "worth the", "covers the cost", "pays for itself", "yes", "clears", "beats the cost"]);
          const notWorth = includesAny(text, ["not worth", "doesn't cover", "does not cover", "eats the", "wiped out", "too small", "marginal"]);
          return shouldMove ? worth && !notWorth : notWorth && !worth;
        }),
        check("quantifies_benefit_or_breakeven", 6, arithmetic ? `cites the incremental return near ${arithmetic.incrementalReturnOverHorizon} or the break-even near ${arithmetic.breakEvenDays} days` : "explains why the numbers do not justify moving", ({ text, structured }) => {
          if (!arithmetic) return includesAny(text, ["cost", "fee", "gas", "swap", "return", "yield"]);
          if (structured?.decision?.expectedNetBenefit !== undefined) return true;
          if (matchesRelative(text, arithmetic.incrementalReturnOverHorizon, 0.25)) return true;
          if (matchesRelative(text, arithmetic.netBenefitOverHorizon, 0.25)) return true;
          if (arithmetic.movePaysForItselfImmediately && includesAny(text, ["immediately", "straight away", "right away", "no cost", "free", "favourable", "favorable", "pays for itself", "instantly", "day one", "no break"])) return true;
          if (matchesNumber(text, arithmetic.breakEvenDays, 5)) return true;
          return false;
        }),
      ],
    },
    {
      dimension: "risksAndTradeoffs",
      checks: [
        check("names_a_real_risk", 10, "names a real risk of the chosen course", ({ text, structured }) => Boolean(structured?.risks?.identified?.length) || includesAny(text, ["rate", "variable", "float", "change", "issuer", "depeg", "peg", "liquidity", "withdraw", "exit", "thin", "smaller", "utilisation", "utilization", "counterparty", "risk", "slippage", "execution", "opportunity cost"])),
        check("no_risk_free_claim", 8, "does not claim the move is risk free", ({ text, structured }) => {
          if (structured?.risks?.identified?.length) return true;
          const stripped = normalizeText(text).replace(/[.!]+$/g, "").trim();
          if (["none", "no risks", "nothing", "no risk"].includes(stripped)) return false;
          return !includesAffirmed(text, ["risk free", "risk-free", "no risk at all", "completely safe", "guaranteed"]);
        }),
        check("acknowledges_rates_move", 6, "notes that the yields are not fixed, or that the figures are a snapshot", ({ text, structured }) => Boolean(structured?.confidence?.limitations?.length) || includesAny(text, ["variable", "can change", "could change", "not fixed", "float", "snapshot", "moment", "may fall", "might drop", "utilisation", "utilization", "no guarantee", "not guaranteed", "estimate"])),
      ],
    },
    {
      dimension: "boundedAction",
      checks: [
        check("action_matches_decision", 10, shouldMove ? "describes a bounded reallocation" : "describes leaving the position and continuing to monitor", ({ text, structured }) => {
          if (structured?.execution?.futureBoundedPlan !== undefined) return shouldMove ? structured.execution.futureBoundedPlan !== null : structured.execution.futureBoundedPlan === null;
          if (shouldMove) return includesAffirmed(text, ["withdraw", "redeem", "swap", "supply", "deposit", "move", "reallocate", "switch"]);
          return includesAny(text, ["nothing", "no action", "leave", "keep", "hold", "monitor", "re-check", "recheck", "review", "watch"]);
        }),
        check("action_is_bounded", 6, "puts a limit on the action rather than leaving it open ended", ({ text, structured }) => Boolean(structured?.execution?.futureBoundedPlan?.maximumAmount ?? structured?.execution?.mode) || includesAny(text, ["only", "limit", "cap", "max", "up to", "no more than", "bounded", "just the", "the whole", "all of", "amount", "review", "monitor", "check again"])),
        check("no_capital_movement_claim", 4, "does not claim to have already moved the capital", ({ text, structured }) => {
          if (structured?.execution?.capitalMoved === false) return true;
          return !includesAny(text, ["i moved", "i have moved", "i swapped", "i withdrew", "i deposited", "i executed", "already moved"]);
        }),
      ],
    },
  ];
}

function dimensionView({ field, submission, structuredFor }) {
  const rawValue = submission?.[field];
  const structured = structuredFor ? structuredFor(field) : null;
  const source = structured === null || structured === undefined ? rawValue : canonicalJson(structured);
  const text = normalizeText(structured === null || structured === undefined ? rawValue : `${rawValue ?? ""} ${canonicalJson(structured)}`);
  return { rawValue: rawValue ?? null, text, structured, declined: isDeclined(source) };
}

export function gradeYieldResponse({ truth, submission, structuredFor = null, responder }) {
  const rubric = yieldRubric(truth);
  const dimensions = rubric.map(({ dimension, checks }) => {
    const view = dimensionView({ field: dimension, submission, structuredFor });
    const responsive = !view.declined;
    const checkResults = checks.map((item) => {
      const passed = responsive ? Boolean(item.predicate(view)) : false;
      return { key: item.key, describe: item.describe, points: item.points, awarded: passed ? item.points : 0, passed };
    });
    const awarded = (responsive ? RESPONSIVE.points : 0) + checkResults.reduce((total, item) => total + item.awarded, 0);
    const available = RESPONSIVE.points + checks.reduce((total, item) => total + item.points, 0);
    return {
      dimension, responsive, declined: view.declined, rawValue: view.rawValue, awarded, available,
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

/** Map the Yield Scout deliverable onto the six precommitted dimensions. */
export function yieldScoutStructuredView(output) {
  if (!isObject(output)) return () => null;
  const views = {
    chosenOption: { decision: output.decision, comparison: output.comparison },
    moveDecision: { decision: output.decision },
    yieldAdvantage: { decision: output.decision, comparison: output.comparison },
    worthItAfterCosts: { decision: output.decision, costs: output.costs },
    risksAndTradeoffs: { risks: output.risks, confidence: output.confidence },
    boundedAction: { execution: output.execution },
  };
  return (dimension) => views[dimension] ?? null;
}

export function yieldScoutSubmissionFromOutput(output) {
  const view = yieldScoutStructuredView(output);
  return Object.fromEntries(yieldBaselineFields().map((field) => [field, isObject(output) ? canonicalJson(view(field)) : null]));
}
