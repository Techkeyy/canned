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
import { canonicalJson, contentHashes, nowIso } from "../core.mjs";
import { REFERENCE_CHAIN_ID } from "./constants.mjs";
import {
  createStrategy, evaluateStrategy, evaluateLevel, deriveLedger, minimumOut,
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
  routerVersion: "PancakeSwap V2",
  summary: "Canned works out the grid levels and watches the price. When the price reaches a level, the agent submits a normal PancakeSwap V2 swap. There is no resting order sitting on an exchange, and no order id, because PancakeSwap has no limit-order contract available on this network.",
  evidence: [
    "PancakeSwap's Gelato-powered limit orders are deprecated and unmaintained.",
    "PancakeSwap Infinity's CLLimitOrder hook exists in source with tests, but is absent from PancakeSwap's own BSC testnet deployment manifest and is not deployed on chain 97.",
    "SmartRouter V3 is deployed on BSC testnet, but its QuoterV2 reverts at every input size tested, so the V3 route cannot be quoted or simulated and is not executable here.",
    "The PancakeSwap V2 router quotes and simulates against a live WBNB/USDT pair, so that is the route the agent is permitted to call. A permission must name a route that works, not the one that was planned.",
  ],
});

/** BSC testnet contracts Grid Keeper is allowed to name in a strategy. */
export const GRID_TESTNET_VENUE = Object.freeze({
  chainId: REFERENCE_CHAIN_ID,
  // The executable route, verified by quote and simulation on chain 97.
  router: "0xd99d1c33f9fc3444f8101754abc46c52416550d1",
  routerVersion: "PancakeSwap V2",
  swapMethod: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  swapSelector: "0x38ed1739",
  wbnb: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
  usdt: "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd",
  // Kept for the record: planned in Directive #17, then found unusable because
  // its quoter reverts on this network. Never placed in an allowlist.
  notExecutable: Object.freeze({
    smartRouterV3: "0x9a489505a00ce272eaa5e07dba6491314cae3796",
    quoterV2: "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997",
    swapMethod: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
    reason: "quoter_reverts_on_bsc_testnet",
  }),
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
    allowedContracts: [GRID_TESTNET_VENUE.router],
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
    to: GRID_TESTNET_VENUE.router,
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

/**
 * Answer the frozen GridBench, as the agent, for a paid job.
 *
 * The agent runs its own engine over each scenario and reports what it would
 * do and why. It never sees the answer key: the public packet carries no
 * `expect` field, and grading happens elsewhere against ground truth
 * recomputed from the specification.
 *
 * Nothing here executes anything. A GridBench job buys the agent's judgement
 * about a frozen situation, which is why it can be paid for and settled with
 * no capital moving.
 */
export function buildGridBenchAnswers({ definition, nowMs = Date.parse("2026-08-30T12:00:00.000Z") }) {
  const strategyFor = (scenario) => {
    const merged = { ...definition.strategy, ...(scenario.strategyOverride ?? {}) };
    return createStrategy({
      ...merged,
      lowerPriceMinor: BigInt(merged.lowerPriceMinor),
      upperPriceMinor: BigInt(merged.upperPriceMinor),
      totalCapitalMinor: BigInt(merged.totalCapitalMinor),
      maxPerLevelMinor: BigInt(merged.maxPerLevelMinor),
      referencePriceMinor: BigInt(merged.referencePriceMinor),
    });
  };

  const answers = {};
  for (const scenario of definition.scenarios) {
    if (scenario.asks === "grid_construction") {
      const built = strategyFor(scenario);
      answers[scenario.id] = {
        asks: scenario.asks,
        levels: built.levels.map((level) => ({ levelId: level.levelId, priceMinor: level.priceMinor, side: level.side })),
      };
    } else if (scenario.asks === "ledger") {
      const ledger = deriveLedger(strategyFor(scenario), scenario.fills ?? []);
      answers[scenario.id] = {
        asks: scenario.asks,
        fillCount: ledger.fillCount,
        netQuoteSpentMinor: String(ledger.netQuoteSpentMinor),
        baseInventoryMinor: String(ledger.baseInventoryMinor),
      };
    } else {
      const built = { ...strategyFor(scenario), state: STRATEGY_STATES.ACTIVE };
      const decision = evaluateLevel({
        strategy: built,
        level: { levelId: scenario.levelId },
        observation: scenario.observation,
        fills: scenario.fills ?? [],
        now: nowMs,
        authority: scenario.authority ?? null,
        intendedCall: scenario.intendedCall ?? null,
      });
      answers[scenario.id] = { asks: scenario.asks, allowed: decision.allowed, reason: decision.reason, side: decision.side ?? null };
    }
  }
  return answers;
}

/**
 * The deliverable for a paid GridBench job.
 *
 * Carries the answers, the grid it derived, and the execution model, so a
 * reader can check what was claimed without trusting the grading. It states
 * plainly that no trade occurred, because a grid agent's deliverable is the
 * easiest place in this project to imply one did.
 */
export function buildGridBenchDeliverable({ jobId, task, definition, nowMs }) {
  const answers = buildGridBenchAnswers({ definition, nowMs });
  const strategy = createStrategy({
    ...definition.strategy,
    lowerPriceMinor: BigInt(definition.strategy.lowerPriceMinor),
    upperPriceMinor: BigInt(definition.strategy.upperPriceMinor),
    totalCapitalMinor: BigInt(definition.strategy.totalCapitalMinor),
    maxPerLevelMinor: BigInt(definition.strategy.maxPerLevelMinor),
    referencePriceMinor: BigInt(definition.strategy.referencePriceMinor),
  });

  const deliverable = {
    entity: "GridBenchDeliverable",
    serviceVersion: GRID_KEEPER_SERVICE_VERSION,
    engineVersion: GRID_ENGINE_VERSION,
    jobId: jobId ?? null,
    task: task ?? null,
    status: "completed",
    benchmarkId: definition.benchmarkId,
    benchmarkVersion: definition.version,
    benchmarkPrecommit: definition.precommit,
    executionModel: GRID_EXECUTION_MODEL,
    strategy: {
      strategyId: strategy.strategyId,
      chainId: strategy.chainId,
      pair: strategy.pair,
      range: strategy.range,
      capital: strategy.capital,
      guards: strategy.guards,
      authority: strategy.authority,
      hash: strategy.hashes?.sha256 ?? null,
    },
    levels: strategy.levels.map((level) => ({ levelId: level.levelId, priceMinor: level.priceMinor, side: level.side, allocationMinor: level.allocationMinor })),
    answers,
    // Said explicitly: this deliverable is judgement about a frozen scenario,
    // not a record of trading.
    execution: {
      onchainSwapsPerformed: 0,
      capitalMoved: false,
      altanaSessionUsed: false,
      note: "No trade occurred. A GridBench job buys the agent's decisions about a frozen situation; execution is a separate, separately authorised act.",
    },
    producedAt: nowIso(),
  };
  return { ...deliverable, hashes: contentHashes(deliverable) };
}

/**
 * Adapt a deliverable into the shape the reference runtime submits.
 *
 * The runtime reads `result.output` and content-addresses that; a builder that
 * returns the deliverable directly therefore submits an EMPTY deliverable,
 * which is exactly what happened to paid job 835. The boundary is made
 * explicit here rather than left to each caller to remember.
 */
export function gridTaskResult(deliverable) {
  const ok = deliverable?.status === "completed";
  return {
    ok,
    status: ok ? "delivered" : deliverable?.status || "error",
    output: deliverable,
    canonicalOutput: canonicalJson(deliverable),
  };
}
