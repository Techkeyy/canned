import path from "node:path";
import { nowIso } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { buildYieldScoutDeliverable } from "../src/reference/yield-scout.mjs";
import { yieldBenchProviderTask } from "../src/reference/yield-benchmark.mjs";
import { computeYieldGroundTruth, gradeYieldResponse, yieldScoutStructuredView, yieldScoutSubmissionFromOutput } from "../src/reference/yield-evaluator.mjs";

/**
 * Fairness cases, written and run before any human sees the benchmark.
 *
 * The point is not that the agent scores well. It is that a competent person
 * writing plain English, using rounded numbers, or phrasing the same judgement
 * differently, scores as well as a precise technical answer, and that wrong
 * reasoning is separated from right reasoning rather than from wrong vocabulary.
 */
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const definition = await store.loadJson("state/yieldbench-v1.json", null);
if (!definition) { console.log(JSON.stringify({ status: "blocked", reason: "YieldBench v1 has not been frozen." })); process.exit(2); }

const truth = computeYieldGroundTruth(definition);
const deliverable = buildYieldScoutDeliverable({ jobId: null, task: yieldBenchProviderTask(definition) });

const CASES = {
  precise_technical: {
    expect: "high",
    submission: {
      chosenOption: "Venus FDUSD market (vFDUSD) at 2.83% supply APR.",
      moveDecision: "Yes, move the 25,000 USDC into FDUSD.",
      yieldAdvantage: "About 0.87 percentage points over the current USDC rate of 1.95%.",
      worthItAfterCosts: "Yes. Incremental return is roughly 17.96 USDC over 30 days, the routed swap is currently favourable at -0.027%, and gas is about 0.03 USDC, so it pays for itself immediately.",
      risksAndTradeoffs: "FDUSD liquidity is 2.56M versus USDC's 21M, so exit is thinner. Different issuer. The rate is variable and follows utilisation. The favourable swap reflects FDUSD trading slightly below peg, which is itself the exposure.",
      boundedAction: "Withdraw only the 25,000 USDC, swap via the routed path, supply to vFDUSD, capped at that amount, and review in 30 days.",
    },
  },
  plain_english: {
    expect: "high",
    submission: {
      chosenOption: "I'd go with FDUSD.",
      moveDecision: "Yeah, I'd move it.",
      yieldAdvantage: "Roughly 0.9% a year more than what it's earning now.",
      worthItAfterCosts: "Yes, it works out around 18 dollars over the month and the swap actually costs nothing right now, so it pays off straight away.",
      risksAndTradeoffs: "That market is a lot smaller so it might be harder to pull out of, it's a different company behind the coin, and the rate can drop at any time.",
      boundedAction: "Just move the 25k across and check again in a month, nothing more than that.",
    },
  },
  rounded_numbers: {
    expect: "high",
    submission: {
      chosenOption: "FDUSD",
      moveDecision: "Move",
      yieldAdvantage: "About 0.9 points better",
      worthItAfterCosts: "Yes, roughly 20 dollars over the 30 days and basically no cost to switch, so immediately worth it",
      risksAndTradeoffs: "Smaller pool to exit, different issuer, and the yield floats",
      boundedAction: "Move the whole 25000 and review after 30 days",
    },
  },
  basis_points_phrasing: {
    expect: "high",
    submission: {
      chosenOption: "The FDUSD market is the pick.",
      moveDecision: "Worth moving.",
      yieldAdvantage: "About 87 basis points of extra yield.",
      worthItAfterCosts: "Yes. Break even is day one because the swap is favourable, and the month returns about 18 units.",
      risksAndTradeoffs: "Thinner market, issuer risk, floating rate.",
      boundedAction: "Cap it at the 25,000 already held, then re-check.",
    },
  },
  naive_highest_apy: {
    expect: "mid",
    submission: {
      chosenOption: "FDUSD, it has the highest APY.",
      moveDecision: "Yes",
      yieldAdvantage: "no idea",
      worthItAfterCosts: "no idea",
      risksAndTradeoffs: "none",
      boundedAction: "no idea",
    },
  },
  wrong_pick_usdt: {
    expect: "low",
    submission: {
      chosenOption: "USDT, it has by far the deepest liquidity and a good rate.",
      moveDecision: "Yes, move to USDT.",
      yieldAdvantage: "About 0.61 points more than USDC.",
      worthItAfterCosts: "Yes, it should be worth it.",
      risksAndTradeoffs: "Issuer risk and the rate can move.",
      boundedAction: "Move the 25,000 into USDT and review later.",
    },
  },
  ignores_gas_and_swap: {
    expect: "mid",
    submission: {
      chosenOption: "FDUSD",
      moveDecision: "Yes",
      yieldAdvantage: "0.87 points",
      worthItAfterCosts: "Obviously yes, free money, there is no cost to any of this.",
      risksAndTradeoffs: "none, it is risk free",
      boundedAction: "Move everything",
    },
  },
  no_move_wrong_reason: {
    expect: "low",
    submission: {
      chosenOption: "Stay in USDC.",
      moveDecision: "No, I would not move.",
      yieldAdvantage: "There isn't really one.",
      worthItAfterCosts: "No, gas on BNB Chain is far too expensive to justify this.",
      risksAndTradeoffs: "Moving is always risky.",
      boundedAction: "Do nothing.",
    },
  },
  partial: {
    expect: "low",
    submission: {
      chosenOption: "FDUSD",
      moveDecision: "Yes",
      yieldAdvantage: "no idea",
      worthItAfterCosts: "no idea",
      risksAndTradeoffs: "The rate could change.",
      boundedAction: "no idea",
    },
  },
  all_declined: {
    expect: "zero",
    submission: Object.fromEntries(["chosenOption", "moveDecision", "yieldAdvantage", "worthItAfterCosts", "risksAndTradeoffs", "boundedAction"].map((field) => [field, "no idea"])),
  },
};

const results = [];
const agent = gradeYieldResponse({ truth, submission: yieldScoutSubmissionFromOutput(deliverable.output), structuredFor: yieldScoutStructuredView(deliverable.output), responder: "canned_yield_scout" });
results.push({ name: "agent_deliverable", expect: "high", score: agent.qualityScore, missed: agent.missedItems });
for (const [name, entry] of Object.entries(CASES)) {
  const score = gradeYieldResponse({ truth, submission: entry.submission, responder: name });
  results.push({ name, expect: entry.expect, score: score.qualityScore, missed: score.missedItems });
}

const scoreOf = (name) => results.find((entry) => entry.name === name).score;
const COMPETENT = ["agent_deliverable", "precise_technical", "plain_english", "rounded_numbers", "basis_points_phrasing"];
const competentScores = COMPETENT.map(scoreOf);
const lowestCompetent = Math.min(...competentScores);
const highestCompetent = Math.max(...competentScores);

/**
 * Ordering and equivalence, not absolute bands. Absolute thresholds only encode
 * the author's guess; what the benchmark actually has to guarantee is that
 * phrasing does not decide the score and that wrong reasoning ranks below right
 * reasoning.
 */
const assertions = [
  { name: "competent_answers_all_score_high", pass: lowestCompetent >= 85, detail: `lowest competent answer scored ${lowestCompetent}` },
  { name: "phrasing_does_not_decide_the_score", pass: highestCompetent - lowestCompetent <= 15, detail: `spread across competent phrasings is ${Number((highestCompetent - lowestCompetent).toFixed(2))} points` },
  { name: "plain_english_matches_technical", pass: Math.abs(scoreOf("plain_english") - scoreOf("precise_technical")) <= 15, detail: `plain ${scoreOf("plain_english")} vs technical ${scoreOf("precise_technical")}` },
  { name: "rounded_numbers_accepted", pass: scoreOf("rounded_numbers") >= 85, detail: `rounded answer scored ${scoreOf("rounded_numbers")}` },
  { name: "basis_points_accepted", pass: scoreOf("basis_points_phrasing") >= 85, detail: `basis-point answer scored ${scoreOf("basis_points_phrasing")}` },
  { name: "wrong_venue_ranks_below_every_competent_answer", pass: scoreOf("wrong_pick_usdt") < lowestCompetent, detail: `wrong venue ${scoreOf("wrong_pick_usdt")} vs lowest competent ${lowestCompetent}` },
  { name: "wrong_no_move_ranks_below_every_competent_answer", pass: scoreOf("no_move_wrong_reason") < lowestCompetent, detail: `wrong hold ${scoreOf("no_move_wrong_reason")}` },
  { name: "risk_free_claim_is_penalised", pass: scoreOf("ignores_gas_and_swap") < lowestCompetent, detail: `risk-free answer ${scoreOf("ignores_gas_and_swap")} must rank below competent answers` },
  { name: "naive_pick_without_reasoning_ranks_low", pass: scoreOf("naive_highest_apy") < scoreOf("wrong_pick_usdt"), detail: `naive ${scoreOf("naive_highest_apy")} vs reasoned-but-wrong ${scoreOf("wrong_pick_usdt")}` },
  { name: "partial_answer_ranks_below_complete_ones", pass: scoreOf("partial") < lowestCompetent, detail: `partial ${scoreOf("partial")}` },
  { name: "declining_everything_scores_zero", pass: scoreOf("all_declined") === 0, detail: `declined ${scoreOf("all_declined")}` },
];
const failures = assertions.filter((entry) => !entry.pass);

console.log(JSON.stringify({
  status: failures.length ? "yield_evaluator_fairness_failed" : "yield_evaluator_fairness_passed",
  benchmarkId: definition.benchmarkId,
  evaluatorVersion: truth.evaluatorVersion,
  groundTruthAction: truth.decisionTruth.correctAction,
  groundTruthAsset: truth.decisionTruth.correctAssetSymbol,
  scores: Object.fromEntries(results.map((entry) => [entry.name, entry.score])),
  assertions,
  failures,
  note: "Run before any human saw the benchmark. The test is that phrasing does not decide the score and that wrong reasoning ranks below right reasoning.",
  checkedAt: nowIso(),
}, null, 2));
if (failures.length) process.exit(2);
