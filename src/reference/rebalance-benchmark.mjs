import { canonicalJson, contentHashes, id, nowIso } from "../core.mjs";
import { CATEGORIES } from "../domain.mjs";
import { REFERENCE_ORIGIN } from "./constants.mjs";
import { PANCAKESWAP_V3, tickToPrice, validateAuthoritativePancakeSnapshot } from "./pancakeswap.mjs";
import { REBALANCE_POLICY } from "./range-keeper.mjs";

export const REBALANCE_BENCHMARK_ID = "RebalanceBench_v1";
export const REBALANCE_BENCHMARK_VERSION = "1.0.0";
export const REBALANCE_EVALUATOR_VERSION = "range-keeper-deterministic-v1";
export const REBALANCE_CONTROL_VERSION = "range-keeper-control-v1";

const REQUIRED_HUMAN_FIELDS = Object.freeze([
  "positionStatus",
  "edgeProximity",
  "marketMovement",
  "rebalanceDecision",
  "proposedRange",
  "risksAndTradeoffs",
]);

export const REBALANCE_TASK_QUESTION = "Read the frozen PancakeSwap V3 position. Say whether it is still in range and how close price is to a range edge, describe how the market moved around it, decide whether a rebalance is justified, give a bounded replacement range only if one is justified, and state the risks you are accepting. Do not move capital.";

function assertSnapshot(snapshot) {
  const result = validateAuthoritativePancakeSnapshot(snapshot);
  if (!result.valid) throw new Error(`RebalanceBench requires an authoritative PancakeSwap snapshot: ${result.errors.join(", ")}`);
}

function assertFrozenDefinition(definition) {
  if (!definition || definition.immutable !== true || definition.benchmarkId !== REBALANCE_BENCHMARK_ID || definition.version !== REBALANCE_BENCHMARK_VERSION) {
    throw new Error("An immutable RebalanceBench_v1 definition is required.");
  }
  assertSnapshot(definition.frozenEvidence?.snapshot);
  if (String(definition.frozenEvidence.snapshot.pool.address).toLowerCase() !== String(definition.pool?.address).toLowerCase()) {
    throw new Error("RebalanceBench frozen snapshot and pool do not match.");
  }
}

export function createRebalanceBenchDefinition({ snapshot, createdAt = nowIso(), sourceUrls = [], selectionRule = null, environmentRationale = null } = {}) {
  assertSnapshot(snapshot);
  const definition = {
    kind: "rebalance_benchmark_definition",
    benchmarkId: REBALANCE_BENCHMARK_ID,
    version: REBALANCE_BENCHMARK_VERSION,
    category: CATEGORIES.REBALANCING,
    origin: REFERENCE_ORIGIN,
    immutable: true,
    createdAt,
    venue: "PancakeSwap",
    chain: { network: "bsc-mainnet-read-only", chainId: snapshot.chainId },
    executionBoundary: {
      marketDataChain: "bsc-mainnet",
      marketDataAccess: "read_only",
      paymentAndAgentExecutionChain: "bsc-testnet",
      paymentChainId: 97,
      mainnetWriteAuthorized: false,
      rationale: environmentRationale || "PancakeSwap V3 is deployed on BSC testnet at the same addresses, but its testnet pools carry mutually inconsistent prices across fee tiers and an observation cardinality of 1, so they have no usable market or oracle history. Mainnet state is read-only; every Canned payment and agent execution stays on BSC testnet.",
    },
    pool: {
      address: snapshot.pool.address,
      token0: snapshot.pool.token0,
      token1: snapshot.pool.token1,
      fee: snapshot.pool.fee,
      feePercent: snapshot.pool.feePercent,
      tickSpacing: snapshot.pool.tickSpacing,
    },
    position: {
      tokenId: snapshot.position.tokenId,
      tickLower: snapshot.position.tickLower,
      tickUpper: snapshot.position.tickUpper,
      liquidity: snapshot.position.liquidity,
      selectionRule: selectionRule || "Declared before reading: the most recently minted position with non-zero liquidity in the declared pool at the freeze block.",
    },
    referenceBlock: { number: snapshot.asOfBlock, hash: snapshot.blockHash, timestamp: snapshot.blockTimestamp },
    task: {
      question: REBALANCE_TASK_QUESTION,
      expectedOutputSchema: REQUIRED_HUMAN_FIELDS,
      permittedInformationSources: [
        "the frozen raw PancakeSwap V3 pool and position snapshot served by the baseline flow",
        "the cited official PancakeSwap documentation",
        "the cited onchain contract reads",
      ],
      prohibitedAssistance: [
        "Canned Range Keeper output",
        "any LLM or automated answer generator",
        "any evaluator or ground-truth result",
        "an answer copied from another attempt",
      ],
    },
    frozenEvidence: { snapshot },
    policy: REBALANCE_POLICY,
    controls: {
      method: "Independent deterministic protocol-read control using the same frozen evidence; it is not the human baseline.",
      humanBaseline: { required: true, outputPreservedVerbatim: true, noAutoCorrection: true },
      agent: { sameFrozenEvidence: true, automaticActionTaken: false, capitalMoved: false },
    },
    sources: {
      sourceUrls: sourceUrls.length ? sourceUrls : [PANCAKESWAP_V3.source, "https://developer.pancakeswap.finance/contracts/v3/addresses"],
      officialPancakeSwapContracts: PANCAKESWAP_V3,
    },
    methodology: {
      timing: "Server records start and finish timestamps; elapsed time is calculated from the server clock. The agent clock runs from quote request to the provider's onchain submission.",
      cost: "Human declares external cost; Canned records the paid agent fee and actual network receipts after the continuation run.",
      scoring: "Deterministic evaluator version is pinned. Every check is satisfiable from prose or from a structured deliverable. No result is exposed until the human baseline is submitted.",
      tolerances: {
        rawProtocolFields: "exact",
        tickArithmetic: "exact",
        edgeProximity: "direction and nearest edge must be correct; a numeric estimate is not required",
        proposedRange: "must be tick-spacing aligned, ordered, and contain the current tick",
        prose: "reviewed against the declared schema",
        action: "bounded and non-transactional",
      },
    },
    evaluator: { version: REBALANCE_EVALUATOR_VERSION, status: "sealed_until_baseline_submission" },
  };
  const hashes = contentHashes(definition);
  return { ...definition, precommit: { canonicalSha256: hashes.sha256, manifestKeccak256: hashes.keccak256 } };
}

/** Public task packet. Carries no evaluator, no ground truth, and no agent output. */
export function publicRebalanceBenchPacket(definition) {
  if (!definition?.precommit?.manifestKeccak256) throw new Error("A frozen RebalanceBench definition is required.");
  return {
    benchmarkId: definition.benchmarkId,
    version: definition.version,
    category: definition.category,
    venue: definition.venue,
    chain: definition.chain,
    executionBoundary: definition.executionBoundary,
    pool: definition.pool,
    position: { tokenId: definition.position.tokenId, tickLower: definition.position.tickLower, tickUpper: definition.position.tickUpper, liquidity: definition.position.liquidity },
    referenceBlock: definition.referenceBlock,
    task: definition.task,
    controls: { humanBaseline: definition.controls.humanBaseline, agent: definition.controls.agent },
    methodology: definition.methodology,
    precommit: definition.precommit,
    baseline: { required: true, status: "not_started", contaminationBoundary: "Do not open or request Canned output until the human submission is accepted." },
  };
}

/**
 * Raw source packet for the human. Contains the authoritative reads and a
 * plain-language rendering of them, but no classification, no decision, and no
 * evaluator result. An LP should be able to answer from this without reading
 * Solidity.
 */
export function publicRebalanceBenchSource(definition) {
  if (!definition?.frozenEvidence?.snapshot) throw new Error("A frozen RebalanceBench definition is required.");
  const snapshot = definition.frozenEvidence.snapshot;
  const { token0, token1 } = snapshot.pool;
  const price = (tick) => tickToPrice(tick, token0.decimals, token1.decimals);
  const inverted = (tick) => 1 / price(tick);
  const fmt = (value) => Number(value.toPrecision(8));
  // A lower tick means a higher token0-per-token1 price, so the inverted quote
  // has to be sorted before it is shown or it reads backwards.
  const invertedBounds = [inverted(snapshot.position.tickLower), inverted(snapshot.position.tickUpper)].sort((a, b) => a - b);
  const directBounds = [price(snapshot.position.tickLower), price(snapshot.position.tickUpper)].sort((a, b) => a - b);
  const quoteDirect = `${token1.symbol} per ${token0.symbol}`;
  const quoteInverted = `${token0.symbol} per ${token1.symbol}`;
  return {
    benchmarkId: definition.benchmarkId,
    venue: "PancakeSwap V3",
    asOfBlock: snapshot.asOfBlock,
    blockHash: snapshot.blockHash,
    blockTimestamp: snapshot.blockTimestamp,
    pool: {
      address: snapshot.pool.address,
      pair: `${token0.symbol}/${token1.symbol}`,
      feeTier: `${snapshot.pool.feePercent}%`,
      tickSpacing: snapshot.pool.tickSpacing,
      poolLiquidityRaw: snapshot.pool.liquidityRaw,
    },
    plainLanguage: {
      whatYouOwn: `A PancakeSwap V3 liquidity position (NFT #${snapshot.position.tokenId}) in the ${token0.symbol}/${token1.symbol} ${snapshot.pool.feePercent}% pool on BNB Smart Chain.`,
      yourRange: `The position earns trading fees only while the pool price stays inside its range. In ${quoteInverted} terms that range is ${fmt(invertedBounds[0])} to ${fmt(invertedBounds[1])}.`,
      currentPrice: `Right now the pool price is ${fmt(inverted(snapshot.slot0.tick))} ${quoteInverted}.`,
      ticksExplained: `PancakeSwap stores prices as integer "ticks" on a log scale. Your range runs from tick ${snapshot.position.tickLower} to tick ${snapshot.position.tickUpper}; the pool is currently at tick ${snapshot.slot0.tick}. A higher tick means a higher ${quoteDirect} price, which is a lower ${quoteInverted} price.`,
      priceTable: {
        note: `Both quote directions are shown. Use whichever is clearer; they describe the same thing.`,
        rangeLowerTick: { tick: snapshot.position.tickLower, [quoteDirect]: fmt(price(snapshot.position.tickLower)), [quoteInverted]: fmt(inverted(snapshot.position.tickLower)) },
        currentTick: { tick: snapshot.slot0.tick, [quoteDirect]: fmt(price(snapshot.slot0.tick)), [quoteInverted]: fmt(inverted(snapshot.slot0.tick)) },
        rangeUpperTick: { tick: snapshot.position.tickUpper, [quoteDirect]: fmt(price(snapshot.position.tickUpper)), [quoteInverted]: fmt(inverted(snapshot.position.tickUpper)) },
      },
      rangeSummary: {
        widthTicks: snapshot.position.tickUpper - snapshot.position.tickLower,
        [`rangeLow_${quoteInverted.replace(/ /g, "_")}`]: fmt(invertedBounds[0]),
        [`rangeHigh_${quoteInverted.replace(/ /g, "_")}`]: fmt(invertedBounds[1]),
        [`rangeLow_${quoteDirect.replace(/ /g, "_")}`]: fmt(directBounds[0]),
        [`rangeHigh_${quoteDirect.replace(/ /g, "_")}`]: fmt(directBounds[1]),
      },
      howTheMarketMoved: snapshot.observations?.meanTicks?.length
        ? snapshot.observations.meanTicks.filter((entry) => entry.secondsAgo > 0).map((entry) => ({
            window: entry.secondsAgo >= 3600 ? `last ${entry.secondsAgo / 3600} hour(s)` : `last ${entry.secondsAgo / 60} minute(s)`,
            averageTick: entry.meanTick,
            [`averagePrice_${quoteInverted.replace(/ /g, "_")}`]: fmt(inverted(entry.meanTick)),
            note: "Average over that window, taken from the pool's own price oracle.",
          }))
        : [],
      rules: [
        "A position earns fees only while the pool's current tick is inside its range.",
        `If price falls below the range the position becomes entirely ${token0.symbol}; above the range, entirely ${token1.symbol}. Either way it stops earning fees.`,
        "Rebalancing costs gas, locks in impermanent loss at the current price, and restarts fee accrual, so it is not automatically the right move.",
        `Any new range must use ticks that are multiples of this pool's tick spacing (${snapshot.pool.tickSpacing}), and the lower tick must be below the upper tick.`,
      ],
    },
    rawOnchainEvidence: snapshot,
    disclosure: "Raw authoritative reads and a plain-language rendering of them. No range classification, rebalance decision, recommended range, evaluator result, or agent output is included.",
  };
}

/** The only benchmark-bound payload a provider may receive. */
export function rebalanceBenchAgentInput(definition) {
  assertFrozenDefinition(definition);
  const snapshot = structuredClone(definition.frozenEvidence.snapshot);
  return {
    benchmarkId: REBALANCE_BENCHMARK_ID,
    version: REBALANCE_BENCHMARK_VERSION,
    venue: definition.venue,
    chain: structuredClone(definition.chain),
    pool: structuredClone(definition.pool),
    position: { tokenId: definition.position.tokenId, tickLower: definition.position.tickLower, tickUpper: definition.position.tickUpper, liquidity: definition.position.liquidity },
    task: {
      question: definition.task.question,
      expectedOutputSchema: [...definition.task.expectedOutputSchema],
      permittedInformationSources: [...definition.task.permittedInformationSources],
      prohibitedAssistance: [...definition.task.prohibitedAssistance],
    },
    evidence: { snapshot, snapshotHash: contentHashes(snapshot).keccak256 },
  };
}

export function rebalanceBenchProviderTask(definition, { jobId = null } = {}) {
  const input = rebalanceBenchAgentInput(definition);
  return {
    benchmarkId: input.benchmarkId,
    version: input.version,
    jobId: jobId === null ? null : Number(jobId),
    venue: "pancakeswap",
    pool: input.pool.address,
    authoritativeSnapshot: input.evidence.snapshot,
    automaticActionTaken: false,
  };
}

export function rebalanceBenchControlTask(definition) {
  const task = rebalanceBenchProviderTask(definition);
  return { venue: task.venue, pool: task.pool, authoritativeSnapshot: task.authoritativeSnapshot };
}

export function validateRebalanceBenchAgentInput({ definition, input } = {}) {
  const errors = [];
  let expected = null;
  try { expected = rebalanceBenchAgentInput(definition); } catch (error) { errors.push(error.message); }
  if (expected && canonicalJson(input) !== canonicalJson(expected)) errors.push("agent_input_does_not_match_frozen_definition");
  if (rebalanceContainsSecretAnswer(input)) errors.push("agent_input_contains_forbidden_answer_key");
  return { valid: errors.length === 0, errors, snapshotHash: expected?.evidence.snapshotHash || null };
}

export function createRebalanceBaselineAttempt({ benchmarkId, startedAt = nowIso() } = {}) {
  if (benchmarkId !== REBALANCE_BENCHMARK_ID) throw new Error("Unknown RebalanceBench baseline.");
  return { attemptId: id("human-rebalance-baseline"), benchmarkId, status: "started", startedAt, finishedAt: null, elapsedMs: null, submission: null, submittedAt: null };
}

export function completeRebalanceBaseline({ attempt, submission, submittedAt = nowIso(), elapsedMs } = {}) {
  if (!attempt || attempt.status !== "started") throw new Error("A started RebalanceBench baseline is required.");
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) throw new Error("Baseline submission must be a JSON object.");
  const missing = REQUIRED_HUMAN_FIELDS.filter((field) => submission[field] === undefined);
  if (missing.length) throw new Error(`Baseline is missing required fields: ${missing.join(", ")}`);
  const measuredElapsedMs = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : Math.max(0, Date.parse(submittedAt) - Date.parse(attempt.startedAt));
  return { ...attempt, status: "submitted", finishedAt: submittedAt, submittedAt, elapsedMs: measuredElapsedMs, submission: structuredClone(submission) };
}

export function rebalanceContainsSecretAnswer(value) {
  const forbidden = [
    "groundtruth", "ground_truth", "agentoutput", "agent_output", "evaluatorresult", "evaluator_result",
    "expectedanswer", "expected_answer", "correctdecision", "correct_decision", "rebalancerecommended",
    "recommendedrange", "recommended_range", "proposedticklower", "proposedtickupper", "correctaction", "correct_action",
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

export function rebalanceBaselineFields() { return [...REQUIRED_HUMAN_FIELDS]; }
