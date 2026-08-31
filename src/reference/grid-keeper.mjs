/**
 * Canned Grid Keeper.
 *
 * The fourth reference agent, and the only one that can move capital. That
 * difference shapes the whole module: Grid Keeper does not act because it
 * decided to, it acts because a level was armed, the market reached it, the
 * budget allowed it, and a session the user granted still permits it. Any one
 * of those failing is a refusal it publishes with a reason.
 *
 * What it is NOT: it does not place native resting limit orders. BSC testnet
 * has no PancakeSwap limit-order contract deployed, and the Gelato-powered
 * mechanism PancakeSwap once used is deprecated. Grid Keeper runs
 * software-managed levels executed as swaps, and every surface says so in
 * those words. Inventing an order id would be the easiest lie in this project
 * and the most damaging.
 */
import { contentHashes, nowIso } from "../core.mjs";
import { REFERENCE_CHAIN_ID } from "./constants.mjs";
import {
  createStrategy, evaluateStrategy, deriveLedger, minimumOut,
  STRATEGY_STATES, GRID_ENGINE_VERSION,
} from "./grid-engine.mjs";

export const GRID_KEEPER_SERVICE_VERSION = "grid-keeper-service-v1";

/**
 * The execution model, stated once and reused everywhere it is displayed.
 * A single constant means the marketplace, the agent page and the deliverable
 * cannot drift into describing this differently.
 */
export const GRID_EXECUTION_MODEL = Object.freeze({
  id: "agent_managed_price_triggered_execution",
  label: "Agent-managed price-triggered execution",
  isNativeLimitOrder: false,
  venue: "PancakeSwap",
  summary: "Canned works out the grid levels and watches the price. When the price reaches a level, the agent submits a normal swap. There is no resting order sitting on an exchange, and no order id, because PancakeSwap has no limit-order contract available on this network.",
  evidence: [
    "PancakeSwap's Gelato-powered limit orders are deprecated and unmaintained.",
    "PancakeSwap Infinity's CLLimitOrder hook exists in source with tests, but is absent from PancakeSwap's own BSC testnet deployment manifest and is not deployed on chain 97.",
    "PancakeSwap SmartRouter V3 is deployed on BSC testnet and is a real trading primitive, so that is what the agent uses.",
  ],
});

/** BSC testnet contracts Grid Keeper is allowed to name in a strategy. */
export const GRID_TESTNET_VENUE = Object.freeze({
  chainId: REFERENCE_CHAIN_ID,
  smartRouterV3: "0x9a489505a00ce272eaa5e07dba6491314cae3796",
  quoterV2: "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997",
  wbnb: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
  usdt: "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd",
  swapMethod: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
});

/**
 * Turn a user's plain answers into a frozen strategy.
 *
 * The allowlists are set here rather than accepted from the caller. A user
 * choosing which contract the agent may call is a question nobody can answer
 * safely, and letting it through the API would be the escalation path.
 */
export function planGridStrategy({
  strategyId, pair, lowerPriceMinor, upperPriceMinor, levelCount,
  totalCapitalMinor, maxPerLevelMinor = null, spacing = "arithmetic",
  expiresAt, maxFills = null, cooldownMs = 60_000, maxSlippageBps = 100,
  maxPriceAgeMs = 120_000, referencePriceMinor = null, createdAt = nowIso(),
}) {
  return createStrategy({
    strategyId,
    chainId: GRID_TESTNET_VENUE.chainId,
    pair,
    lowerPriceMinor, upperPriceMinor, levelCount, spacing, referencePriceMinor,
    totalCapitalMinor, maxPerLevelMinor,
    expiresAt, maxFills, cooldownMs, maxSlippageBps, maxPriceAgeMs,
    allowedContracts: [GRID_TESTNET_VENUE.smartRouterV3],
    allowedMethods: [GRID_TESTNET_VENUE.swapMethod],
    createdAt,
  });
}

/**
 * The deliverable for a hired Grid Keeper job.
 *
 * A hire buys the agent's judgement, not a trade: the answer is what the grid
 * is, what it would do at the observed price, and what it refused. Execution
 * is a separate, separately authorised act, which is why a job can be paid for
 * and settled without any capital ever moving.
 */
export function buildGridKeeperDeliverable({ jobId, task, strategy, observation, fills = [], authority = null, now = Date.now() }) {
  if (!strategy) {
    return {
      entity: "GridKeeperDeliverable",
      serviceVersion: GRID_KEEPER_SERVICE_VERSION,
      engineVersion: GRID_ENGINE_VERSION,
      jobId: jobId ?? null,
      status: "insufficient_data",
      reason: "No grid strategy was supplied, so there is nothing to evaluate. Nothing was executed.",
      executionModel: GRID_EXECUTION_MODEL,
      producedAt: nowIso(),
    };
  }

  const active = strategy.state === STRATEGY_STATES.ACTIVE ? strategy : { ...strategy, state: STRATEGY_STATES.ACTIVE };
  // A price can arrive as a BigInt. Deliverables are hashed and published as
  // JSON, which cannot carry one, so it is normalised at the boundary rather
  // than left to fail at serialisation time.
  const recorded = observation ? { ...observation, priceMinor: String(observation.priceMinor) } : null;
  const evaluation = evaluateStrategy({ strategy: active, observation, fills, now, authority });
  const ledger = deriveLedger(active, fills);

  const deliverable = {
    entity: "GridKeeperDeliverable",
    serviceVersion: GRID_KEEPER_SERVICE_VERSION,
    engineVersion: GRID_ENGINE_VERSION,
    jobId: jobId ?? null,
    task: task ?? null,
    status: "completed",
    executionModel: GRID_EXECUTION_MODEL,
    strategy: {
      strategyId: active.strategyId,
      chainId: active.chainId,
      pair: active.pair,
      range: active.range,
      capital: active.capital,
      guards: active.guards,
      authority: active.authority,
      hash: active.hashes?.sha256 ?? null,
    },
    levels: active.levels.map((level) => ({ levelId: level.levelId, priceMinor: level.priceMinor, side: level.side, allocationMinor: level.allocationMinor, state: level.state })),
    observation: recorded,
    // What it would do, and every reason it would not.
    decision: {
      nextAction: evaluation.nextAction,
      eligibleCount: evaluation.eligible.length,
      refusals: evaluation.refused.map((entry) => ({ levelId: entry.levelId, reason: entry.reason, detail: entry.detail })),
    },
    ledger: {
      fillCount: ledger.fillCount,
      netQuoteSpentMinor: String(ledger.netQuoteSpentMinor),
      baseInventoryMinor: String(ledger.baseInventoryMinor),
    },
    // A session that does not exist is reported as absent, never as unlimited.
    authority: authority
      ? { granted: true, revoked: authority.revoked === true, expiresAtMs: authority.expiresAtMs ?? null, sessionPublicKey: authority.sessionPublicKey ?? null }
      : { granted: false, revoked: false, expiresAtMs: null, sessionPublicKey: null, note: "No session has been granted, so this agent cannot execute anything." },
    producedAt: nowIso(),
  };
  return { ...deliverable, hashes: contentHashes(deliverable) };
}

/**
 * Build the exact call a level would execute.
 *
 * Returned for inspection rather than sent. Nothing in this module signs or
 * broadcasts; the caller with the session decides whether to submit it, and
 * the session's on-chain validator decides whether it is permitted.
 */
export function buildLevelSwapCall({ strategy, decision, quotedOutMinor, recipient, feeTier = 500, deadlineSeconds }) {
  if (!decision?.allowed) throw new Error("Refusing to build a call for a level that was not allowed.");
  const minOut = minimumOut(quotedOutMinor, strategy.guards.maxSlippageBps);
  const buying = decision.side === "BUY";
  return {
    to: GRID_TESTNET_VENUE.smartRouterV3,
    method: GRID_TESTNET_VENUE.swapMethod,
    chainId: strategy.chainId,
    side: decision.side,
    params: {
      tokenIn: buying ? strategy.pair.quoteToken : strategy.pair.baseToken,
      tokenOut: buying ? strategy.pair.baseToken : strategy.pair.quoteToken,
      fee: feeTier,
      recipient,
      amountIn: buying ? decision.spendMinor : decision.sellBaseMinor,
      amountOutMinimum: String(minOut),
      sqrtPriceLimitX96: "0",
      deadline: deadlineSeconds,
    },
    quotedOutMinor: String(quotedOutMinor),
    minOutMinor: String(minOut),
    value: "0",
    note: "A normal PancakeSwap swap. It is not a resting order and produces no order id.",
  };
}
