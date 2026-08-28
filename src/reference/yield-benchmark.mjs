import { canonicalJson, contentHashes, id, nowIso } from "../core.mjs";
import { CATEGORIES } from "../domain.mjs";
import { REFERENCE_ORIGIN } from "./constants.mjs";
import { VENUS_MAINNET_CORE, validateAuthoritativeYieldSnapshot } from "./venus-yield.mjs";
import { YIELD_POLICY, REALLOCATION_STEPS } from "./yield-scout.mjs";

export const YIELD_BENCHMARK_ID = "YieldBench_v1";
export const YIELD_BENCHMARK_VERSION = "1.0.0";
export const YIELD_EVALUATOR_VERSION = "yield-scout-deterministic-v1";
export const YIELD_CONTROL_VERSION = "yield-scout-control-v1";

const REQUIRED_HUMAN_FIELDS = Object.freeze([
  "chosenOption",
  "moveDecision",
  "yieldAdvantage",
  "worthItAfterCosts",
  "risksAndTradeoffs",
  "boundedAction",
]);

export const YIELD_TASK_QUESTION = "You hold a stablecoin position earning interest. Using only the frozen figures provided, say which option you would choose, whether you would move at all, roughly how much extra yield the best option offers, whether that advantage is worth it after transaction costs over the stated horizon, what risks you would be accepting, and what bounded action you would authorise. Do not move any capital.";

function assertSnapshot(snapshot) {
  const result = validateAuthoritativeYieldSnapshot(snapshot);
  if (!result.valid) throw new Error(`YieldBench requires an authoritative Venus yield snapshot: ${result.errors.join(", ")}`);
}

function assertFrozenDefinition(definition) {
  if (!definition || definition.immutable !== true || definition.benchmarkId !== YIELD_BENCHMARK_ID || definition.version !== YIELD_BENCHMARK_VERSION) {
    throw new Error("An immutable YieldBench_v1 definition is required.");
  }
  assertSnapshot(definition.frozenEvidence?.snapshot);
}

export function createYieldBenchDefinition({ snapshot, position, horizonDays, costs, createdAt = nowIso(), sourceUrls = [], selectionRule = null, environmentRationale = null } = {}) {
  assertSnapshot(snapshot);
  if (!snapshot.markets.some((market) => market.key === position.marketKey)) throw new Error("The current position must reference a market inside the frozen snapshot.");
  const definition = {
    kind: "yield_benchmark_definition",
    benchmarkId: YIELD_BENCHMARK_ID,
    version: YIELD_BENCHMARK_VERSION,
    category: CATEGORIES.YIELD_OPTIMISATION,
    origin: REFERENCE_ORIGIN,
    immutable: true,
    createdAt,
    venue: "Venus",
    chain: { network: "bsc-mainnet-read-only", chainId: snapshot.chainId },
    executionBoundary: {
      marketDataChain: "bsc-mainnet",
      marketDataAccess: "read_only",
      paymentAndAgentExecutionChain: "bsc-testnet",
      paymentChainId: 97,
      mainnetWriteAuthorized: false,
      capitalMovementAuthorized: false,
      rationale: environmentRationale || "Supply yield is only meaningful where real borrowing demand sets utilisation. BSC testnet lending markets carry no real demand, so their rates describe nothing. Mainnet state is read-only; every Canned payment and agent execution stays on BSC testnet, and no capital is ever moved.",
    },
    position: { ...position, selectionRule: selectionRule || "Declared before reading: a round retail stablecoin position in the deepest available stablecoin market." },
    horizonDays,
    costs,
    referenceBlock: { number: snapshot.asOfBlock, hash: snapshot.blockHash, timestamp: snapshot.blockTimestamp },
    coherence: {
      allMarketsReadAtSameBlock: true,
      swapQuotesAtSameBlock: costs.quotedAtBlock === snapshot.asOfBlock,
      gasPriceAtSameBlock: costs.gasPriceAtBlock === snapshot.asOfBlock,
      note: "Every yield, liquidity, swap quote, and gas figure comes from one block, so nothing in the comparison is sampled at a different moment.",
    },
    task: {
      question: YIELD_TASK_QUESTION,
      expectedOutputSchema: REQUIRED_HUMAN_FIELDS,
      permittedInformationSources: [
        "the frozen yield and cost figures served by the baseline flow",
        "the cited official Venus documentation",
        "the cited onchain contract reads",
      ],
      prohibitedAssistance: [
        "Canned Yield Scout output",
        "any LLM or automated answer generator",
        "any evaluator or ground-truth result",
        "an answer copied from another attempt",
      ],
    },
    frozenEvidence: { snapshot },
    policy: YIELD_POLICY,
    controls: {
      method: "Independent deterministic protocol-read control using the same frozen evidence; it is not the human baseline.",
      humanBaseline: { required: true, outputPreservedVerbatim: true, noAutoCorrection: true },
      agent: { sameFrozenEvidence: true, automaticActionTaken: false, capitalMoved: false },
    },
    sources: {
      sourceUrls: sourceUrls.length ? sourceUrls : [VENUS_MAINNET_CORE.source, "https://docs.pancakeswap.finance/trading-tools/building-trading-agents-on-pancakeswap-v3"],
      officialVenusContracts: { comptroller: VENUS_MAINNET_CORE.comptroller, poolRegistry: VENUS_MAINNET_CORE.poolRegistry },
    },
    methodology: {
      timing: "Server records start and finish timestamps; elapsed time is calculated from the server clock. The agent clock runs from quote request to the provider's onchain submission.",
      cost: "Human declares external cost; Canned records the paid agent fee and actual network receipts after the continuation run.",
      scoring: "Deterministic evaluator version is pinned. Numeric answers are scored against precommitted tolerances, and every check is satisfiable from prose or from a structured deliverable.",
      returnBasis: "Simple, non-compounded return over the horizon.",
      tolerances: {
        rawProtocolFields: "exact",
        yieldAdvantagePct: "within 0.15 percentage points, or a correct relative statement",
        incrementalReturn: "within 25 percent of the computed value",
        breakEvenDays: "within 5 days, or a correct statement that the move pays for itself immediately",
        prose: "reviewed against the declared schema",
        action: "bounded and non-transactional",
      },
    },
    evaluator: { version: YIELD_EVALUATOR_VERSION, status: "sealed_until_baseline_submission" },
  };
  const hashes = contentHashes(definition);
  return { ...definition, precommit: { canonicalSha256: hashes.sha256, manifestKeccak256: hashes.keccak256 } };
}

/** Public task packet. No evaluator, no ground truth, no agent output. */
export function publicYieldBenchPacket(definition) {
  if (!definition?.precommit?.manifestKeccak256) throw new Error("A frozen YieldBench definition is required.");
  return {
    benchmarkId: definition.benchmarkId,
    version: definition.version,
    category: definition.category,
    venue: definition.venue,
    chain: definition.chain,
    executionBoundary: definition.executionBoundary,
    position: { marketKey: definition.position.marketKey, assetSymbol: definition.position.assetSymbol, amount: definition.position.amount },
    horizonDays: definition.horizonDays,
    referenceBlock: definition.referenceBlock,
    task: definition.task,
    controls: { humanBaseline: definition.controls.humanBaseline, agent: definition.controls.agent },
    methodology: definition.methodology,
    precommit: definition.precommit,
    baseline: { required: true, status: "not_started", contaminationBoundary: "Do not open or request Canned output until the human submission is accepted." },
  };
}

/**
 * Raw source packet for the human: the authoritative figures plus a plain
 * rendering of them. It contains no ranking, no recommendation, no net-benefit
 * computation, and no evaluator result. Someone who understands "interest rate"
 * and "fee" should be able to answer it.
 */
export function publicYieldBenchSource(definition) {
  if (!definition?.frozenEvidence?.snapshot) throw new Error("A frozen YieldBench definition is required.");
  const snapshot = definition.frozenEvidence.snapshot;
  const { position, horizonDays, costs } = definition;
  const current = snapshot.markets.find((market) => market.key === position.marketKey);
  const fmt = (value, digits = 3) => Number(Number(value).toFixed(digits));
  const liquidityOf = (market) => Number(market.cash) / 10 ** market.assetDecimals;

  return {
    benchmarkId: definition.benchmarkId,
    venue: "Venus Core Pool on BNB Smart Chain",
    asOfBlock: snapshot.asOfBlock,
    blockHash: snapshot.blockHash,
    blockTimestamp: snapshot.blockTimestamp,
    plainLanguage: {
      whatYouHold: `You have ${position.amount} ${position.assetSymbol} supplied to the Venus ${position.assetSymbol} market, currently earning ${fmt(current.supplyAprDecimal * 100)}% a year.`,
      theQuestion: `You are deciding whether to move that ${position.assetSymbol} into a different stablecoin market on the same protocol, and you are judging it over the next ${horizonDays} days.`,
      howToRead: "Each row is a market you could supply to. The rate is what supplying earns. Available liquidity is how much of that asset is sitting in the market unborrowed, which is what you would be competing to withdraw against. Utilisation is how much of the market is currently lent out.",
      options: snapshot.markets.map((market) => ({
        asset: market.assetSymbol,
        market: market.key,
        supplyRatePctPerYear: fmt(market.supplyAprDecimal * 100),
        yearlyRateCompoundedPct: fmt(market.supplyApyDecimal * 100),
        availableLiquidity: fmt(liquidityOf(market), 0),
        utilisationPct: market.utilisationBps === null ? null : fmt(market.utilisationBps / 100, 1),
        tokenIncentives: market.incentivesIncluded ? "none, the rate above is the whole yield" : "unknown",
        isYourCurrentPosition: market.key === position.marketKey,
      })),
      whatMovingCosts: {
        explanation: `Moving means withdrawing your ${position.assetSymbol}, swapping it for the other stablecoin, and supplying that instead. There are two costs: the swap, and the network fee for the transactions.`,
        swapCosts: (costs.swapRoutes || []).map((route) => ({
          into: route.toAssetSymbol,
          bestRouteCostPct: route.bestCostFraction === null ? null : fmt(route.bestCostFraction * 100, 4),
          note: route.bestCostFraction === null
            ? "No usable route was found at this size."
            : route.bestCostFraction < 0
              ? `Currently favourable: at this size the swap returns slightly more than you put in, because ${route.toAssetSymbol} is trading a little below ${position.assetSymbol}.`
              : "A cost, deducted from the amount you end up supplying.",
          routesChecked: (route.routes || []).filter((entry) => entry.available).map((entry) => ({ via: entry.hops.length > 2 ? `routed through ${entry.viaSymbol || "an intermediary"}` : "direct pool", costPct: fmt(entry.costFraction * 100, 4) })),
        })),
        networkFee: { totalForAllSteps: `${fmt(costs.gasCostNative, 8)} BNB`, approximateValue: `${fmt(costs.gasCostNative * costs.nativePriceInAsset, 4)} ${position.assetSymbol}`, steps: REALLOCATION_STEPS.map((step) => step.step) },
      },
      thingsWorthNoticing: [
        "A higher rate is not automatically worth moving to; the move has to earn back what it costs within your horizon.",
        "A market with less available liquidity is harder to get out of if many people withdraw at once.",
        "Different stablecoins are issued by different companies, so moving changes whose promise you are holding.",
        "These rates float with borrowing demand. They are not fixed for the horizon.",
      ],
    },
    rawOnchainEvidence: snapshot,
    rawCostEvidence: costs,
    disclosure: "Raw authoritative reads and a plain-language rendering of them. No ranking, recommendation, net-benefit calculation, break-even figure, evaluator result, or agent output is included.",
  };
}

/** The only benchmark-bound payload a provider may receive. */
export function yieldBenchAgentInput(definition) {
  assertFrozenDefinition(definition);
  return {
    benchmarkId: YIELD_BENCHMARK_ID,
    version: YIELD_BENCHMARK_VERSION,
    venue: definition.venue,
    chain: structuredClone(definition.chain),
    position: { marketKey: definition.position.marketKey, assetSymbol: definition.position.assetSymbol, amount: definition.position.amount },
    horizonDays: definition.horizonDays,
    costs: structuredClone(definition.costs),
    task: {
      question: definition.task.question,
      expectedOutputSchema: [...definition.task.expectedOutputSchema],
      permittedInformationSources: [...definition.task.permittedInformationSources],
      prohibitedAssistance: [...definition.task.prohibitedAssistance],
    },
    evidence: { snapshot: structuredClone(definition.frozenEvidence.snapshot), snapshotHash: contentHashes(definition.frozenEvidence.snapshot).keccak256 },
  };
}

export function yieldBenchProviderTask(definition, { jobId = null } = {}) {
  const input = yieldBenchAgentInput(definition);
  return {
    benchmarkId: input.benchmarkId,
    version: input.version,
    jobId: jobId === null ? null : Number(jobId),
    venue: "venus",
    position: input.position,
    horizonDays: input.horizonDays,
    costs: input.costs,
    authoritativeSnapshot: input.evidence.snapshot,
    automaticActionTaken: false,
  };
}

export function yieldBenchControlTask(definition) {
  const task = yieldBenchProviderTask(definition);
  return { venue: task.venue, position: task.position, horizonDays: task.horizonDays, costs: task.costs, authoritativeSnapshot: task.authoritativeSnapshot };
}

export function validateYieldBenchAgentInput({ definition, input } = {}) {
  const errors = [];
  let expected = null;
  try { expected = yieldBenchAgentInput(definition); } catch (error) { errors.push(error.message); }
  if (expected && canonicalJson(input) !== canonicalJson(expected)) errors.push("agent_input_does_not_match_frozen_definition");
  if (yieldContainsSecretAnswer(input)) errors.push("agent_input_contains_forbidden_answer_key");
  return { valid: errors.length === 0, errors, snapshotHash: expected?.evidence.snapshotHash || null };
}

export function createYieldBaselineAttempt({ benchmarkId, startedAt = nowIso() } = {}) {
  if (benchmarkId !== YIELD_BENCHMARK_ID) throw new Error("Unknown YieldBench baseline.");
  return { attemptId: id("human-yield-baseline"), benchmarkId, status: "started", startedAt, finishedAt: null, elapsedMs: null, submission: null, submittedAt: null };
}

export function completeYieldBaseline({ attempt, submission, submittedAt = nowIso(), elapsedMs } = {}) {
  if (!attempt || attempt.status !== "started") throw new Error("A started YieldBench baseline is required.");
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) throw new Error("Baseline submission must be a JSON object.");
  const missing = REQUIRED_HUMAN_FIELDS.filter((field) => submission[field] === undefined);
  if (missing.length) throw new Error(`Baseline is missing required fields: ${missing.join(", ")}`);
  const measuredElapsedMs = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : Math.max(0, Date.parse(submittedAt) - Date.parse(attempt.startedAt));
  return { ...attempt, status: "submitted", finishedAt: submittedAt, submittedAt, elapsedMs: measuredElapsedMs, submission: structuredClone(submission) };
}

export function yieldContainsSecretAnswer(value) {
  const forbidden = [
    "groundtruth", "ground_truth", "agentoutput", "agent_output", "evaluatorresult", "evaluator_result",
    "expectedanswer", "expected_answer", "correctdecision", "correct_decision", "correctaction", "correct_action",
    "recommendedmarket", "recommended_market", "moverecommended", "move_recommended", "netbenefit", "net_benefit",
    "breakevendays", "break_even_days", "qualifies", "disqualifiers", "bestoption", "best_option",
  ];
  const visit = (item) => {
    if (!item || typeof item !== "object") return false;
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (forbidden.includes(normalized)) return true;
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(value);
}

export function yieldBaselineFields() { return [...REQUIRED_HUMAN_FIELDS]; }
