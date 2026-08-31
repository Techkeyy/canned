/**
 * GridBench v1: a deterministic capability benchmark for grid trading.
 *
 * TermiX already has its three human-versus-agent pairs, so this benchmark is
 * not another one. Its job is to give Grid Trading the same evidence depth the
 * other three categories have: a frozen task, a precommitted policy, and a
 * gradable answer that nobody can tune after seeing.
 *
 * The market state is a real PancakeSwap V3 observation on BSC mainnet, read
 * once and frozen. Mainnet is used for market data because BSC testnet
 * PancakeSwap does not have a coherent price: its V3 quoter reverts, and its
 * V2 pairs disagree about the price of WBNB by three orders of magnitude. A
 * benchmark built on that would measure nothing. No write ever touches
 * mainnet; see docs/GRID-KEEPER.md.
 *
 * Ground truth is computed in the evaluator from this specification, not by
 * running the engine under test. If the two ever disagree, that disagreement
 * is a finding rather than a rounding error.
 */
import { contentHashes } from "../core.mjs";

export const GRID_BENCHMARK_ID = "gridbench-v1";
export const GRID_BENCHMARK_VERSION = "1.0.0";

/**
 * Frozen market observation.
 *
 * Read from the PancakeSwap V3 WBNB/USDT 0.05% pool on BSC mainnet at the
 * block named below. Token0 is USDT and token1 is WBNB in that pool, so the
 * raw price is inverted to express the quantity a grid trader thinks in:
 * USDT per WBNB.
 */
export const GRID_FROZEN_MARKET = Object.freeze({
  source: "pancakeswap-v3",
  chainId: 56,
  network: "bsc-mainnet",
  readOnly: true,
  blockNumber: 119038523,
  poolAddress: "0x36696169c63e42cd08ce11f5deebbcebae652050",
  feeTier: 500,
  token0: { address: "0x55d398326f99059ff775485246999027b3197955", symbol: "USDT", decimals: 18 },
  token1: { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", symbol: "WBNB", decimals: 18 },
  tick: -65447,
  liquidity: "3200139635234757088351837",
  // USDT per WBNB, in quote minor units (18 decimals).
  referencePriceMinor: "695270000000000000000",
  referencePriceHuman: "695.27",
  observedAt: "2026-08-30T00:00:00.000Z",
  note: "Read-only mainnet observation. Canned performs no mainnet writes.",
});

/**
 * The strategy every scenario is graded against.
 *
 * The range brackets the frozen price so the grid has live levels on both
 * sides, which is what makes the buy/sell split and the inventory rules
 * testable at all.
 */
export const GRID_BENCHMARK_STRATEGY = Object.freeze({
  strategyId: "gridbench-v1-strategy",
  chainId: 97,
  pair: {
    baseToken: "0xae13d989dac2f0debff460ac112a837c89baa7cd",
    quoteToken: "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd",
    baseSymbol: "WBNB",
    quoteSymbol: "USDT",
    baseDecimals: 18,
    quoteDecimals: 18,
  },
  lowerPriceMinor: "600000000000000000000",   // 600 USDT
  upperPriceMinor: "800000000000000000000",   // 800 USDT
  levelCount: 9,                              // 25 USDT apart
  spacing: "arithmetic",
  referencePriceMinor: "695270000000000000000",
  totalCapitalMinor: "400000000000000000000", // 400 USDT
  maxPerLevelMinor: "100000000000000000000",  // 100 USDT
  expiresAt: "2026-08-31T00:00:00.000Z",
  maxFills: 6,
  cooldownMs: 60_000,
  maxSlippageBps: 50,
  maxPriceAgeMs: 120_000,
  allowedContracts: ["0x9a489505a00ce272eaa5e07dba6491314cae3796"],
  allowedMethods: ["exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"],
  createdAt: "2026-08-30T00:00:00.000Z",
});

const AT = "2026-08-30T12:00:00.000Z";
const NOW_MS = Date.parse(AT);

function observation(priceHuman, { ageMs = 0, chainId = 97, baseToken = GRID_BENCHMARK_STRATEGY.pair.baseToken, quoteToken = GRID_BENCHMARK_STRATEGY.pair.quoteToken } = {}) {
  return {
    priceMinor: String(BigInt(Math.round(priceHuman * 100)) * 10n ** 16n),
    priceHuman,
    observedAt: new Date(NOW_MS - ageMs).toISOString(),
    chainId, baseToken, quoteToken,
  };
}

function buyFill(levelId, quoteSpentHuman, baseReceivedHuman, agoMs = 300_000) {
  return {
    strategyId: GRID_BENCHMARK_STRATEGY.strategyId,
    levelId, state: "FILLED", side: "BUY",
    quoteSpentMinor: String(BigInt(Math.round(quoteSpentHuman * 100)) * 10n ** 16n),
    baseReceivedMinor: String(BigInt(Math.round(baseReceivedHuman * 1e6)) * 10n ** 12n),
    filledAt: new Date(NOW_MS - agoMs).toISOString(),
  };
}

/**
 * The scenarios.
 *
 * Each names one thing a grid implementation has to get right, and each is
 * answerable from the strategy alone. `expect` is the answer key: an evaluator
 * recomputes it independently rather than reading it from here, and this field
 * exists so the frozen definition states its own intent.
 */
export const GRID_BENCHMARK_SCENARIOS = Object.freeze([
  {
    id: "S01-construction",
    asks: "grid_construction",
    prompt: "List the price of every level in this grid, lowest first, and say which side each level trades.",
    expect: { levelCount: 9, lowestPriceHuman: 600, highestPriceHuman: 800, stepHuman: 25 },
  },
  {
    id: "S02-trigger-buy",
    asks: "decision",
    prompt: "Price is 649. May the 650 buy level execute?",
    observation: observation(649),
    levelId: "gridbench-v1-strategy:L02",
    expect: { allowed: true, side: "BUY" },
  },
  {
    id: "S03-not-triggered",
    asks: "decision",
    prompt: "Price is 660. May the 650 buy level execute?",
    observation: observation(660),
    levelId: "gridbench-v1-strategy:L02",
    expect: { allowed: false, reason: "price_has_not_reached_this_level" },
  },
  {
    id: "S04-duplicate-fill",
    asks: "decision",
    prompt: "The 650 level already filled. Price is 649 again. May it execute a second time?",
    observation: observation(649),
    levelId: "gridbench-v1-strategy:L02",
    fills: [buyFill("gridbench-v1-strategy:L02", 100, 0.153)],
    expect: { allowed: false, reason: "level_already_filled" },
  },
  {
    id: "S05-total-cap",
    asks: "decision",
    // The cap is lowered for this scenario so it can actually bind: at the
    // strategy's own 400 cap, four buy levels of 100 consume it exactly and
    // never exceed it, which would test nothing.
    asksNote: "capital cap binds",
    prompt: "The cap is 350 USDT and three levels have filled at 100 each. Price is 599. May the 600 level execute?",
    observation: observation(599),
    levelId: "gridbench-v1-strategy:L00",
    strategyOverride: { totalCapitalMinor: "350000000000000000000" },
    fills: [
      buyFill("gridbench-v1-strategy:L01", 100, 0.16),
      buyFill("gridbench-v1-strategy:L02", 100, 0.153),
      buyFill("gridbench-v1-strategy:L03", 100, 0.148),
    ],
    expect: { allowed: false, reason: "total_capital_cap_would_be_exceeded" },
  },
  {
    id: "S06-stale-price",
    asks: "decision",
    prompt: "Price is 649 but the observation is ten minutes old. May the 650 level execute?",
    observation: observation(649, { ageMs: 600_000 }),
    levelId: "gridbench-v1-strategy:L02",
    expect: { allowed: false, reason: "price_observation_is_too_old" },
  },
  {
    id: "S07-expired",
    asks: "decision",
    prompt: "The strategy expiry has passed. Price is 649. May the 650 level execute?",
    observation: observation(649),
    levelId: "gridbench-v1-strategy:L02",
    strategyOverride: { expiresAt: "2026-08-30T06:00:00.000Z" },
    expect: { allowed: false, reason: "strategy_expired" },
  },
  {
    id: "S08-revoked",
    asks: "decision",
    prompt: "The user revoked the permission. Price is 649. May the 650 level execute?",
    observation: observation(649),
    levelId: "gridbench-v1-strategy:L02",
    authority: { revoked: true },
    expect: { allowed: false, reason: "authority_revoked" },
  },
  {
    id: "S09-sell-without-inventory",
    asks: "decision",
    prompt: "Price is 801 and nothing has been bought. May the 800 sell level execute?",
    observation: observation(801),
    levelId: "gridbench-v1-strategy:L08",
    expect: { allowed: false, reason: "not_enough_inventory_to_sell" },
  },
  {
    id: "S10-sell-with-inventory",
    asks: "decision",
    prompt: "Price is 801 after one buy filled. May the 800 sell level execute?",
    observation: observation(801),
    levelId: "gridbench-v1-strategy:L08",
    fills: [buyFill("gridbench-v1-strategy:L02", 100, 0.153)],
    expect: { allowed: true, side: "SELL" },
  },
  {
    id: "S11-wrong-chain",
    asks: "decision",
    prompt: "The price observation came from chain 56. May the 650 level execute?",
    observation: observation(649, { chainId: 56 }),
    levelId: "gridbench-v1-strategy:L02",
    expect: { allowed: false, reason: "chain_does_not_match_the_strategy" },
  },
  {
    id: "S12-wrong-contract",
    asks: "decision",
    prompt: "The intended call targets a router that is not on the allowlist. May it execute?",
    observation: observation(649),
    levelId: "gridbench-v1-strategy:L02",
    intendedCall: { to: "0x0000000000000000000000000000000000009999", method: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))" },
    expect: { allowed: false, reason: "target_contract_is_not_allowed" },
  },
  {
    id: "S13-wrong-method",
    asks: "decision",
    prompt: "The intended call is transferFrom on the allowed router. May it execute?",
    observation: observation(649),
    levelId: "gridbench-v1-strategy:L02",
    intendedCall: { to: "0x9a489505a00ce272eaa5e07dba6491314cae3796", method: "transferFrom(address,address,uint256)" },
    expect: { allowed: false, reason: "method_is_not_allowed" },
  },
  {
    id: "S14-slippage",
    asks: "decision",
    prompt: "The router quotes less than the minimum acceptable output. May it execute?",
    observation: observation(649),
    levelId: "gridbench-v1-strategy:L02",
    intendedCall: {
      to: "0x9a489505a00ce272eaa5e07dba6491314cae3796",
      method: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
      quotedOutMinor: "140000000000000000",
      minOutMinor: "152000000000000000",
    },
    expect: { allowed: false, reason: "quoted_output_is_below_the_minimum" },
  },
  {
    id: "S15-cooldown",
    asks: "decision",
    prompt: "A fill happened ten seconds ago and the cooldown is sixty. Price is 624. May the 625 level execute?",
    observation: observation(624),
    levelId: "gridbench-v1-strategy:L01",
    fills: [buyFill("gridbench-v1-strategy:L02", 100, 0.153, 10_000)],
    expect: { allowed: false, reason: "cooldown_has_not_elapsed" },
  },
  {
    id: "S16-inventory-accounting",
    asks: "ledger",
    prompt: "After two buys of 100 USDT receiving 0.16 and 0.153 WBNB, state the capital deployed and the WBNB held.",
    fills: [buyFill("gridbench-v1-strategy:L01", 100, 0.16), buyFill("gridbench-v1-strategy:L02", 100, 0.153)],
    expect: { netQuoteSpentHuman: 200, baseInventoryHuman: 0.313, fillCount: 2 },
  },
]);

export const GRID_BENCHMARK_POLICY = Object.freeze({
  version: GRID_BENCHMARK_VERSION,
  scoring: "Each scenario is worth an equal share of 100. A decision scenario scores only when the allow/refuse verdict AND the reason both match.",
  refusalReasonsMustMatch: true,
  // Stated before any answer exists, so it cannot be relaxed later.
  noPartialCreditForCorrectVerdictWithWrongReason: true,
  groundTruthSource: "recomputed_from_this_specification_not_from_the_agent_engine",
});

/** Freeze the definition and content-address it. */
export function buildGridBenchmarkDefinition({ frozenAt = "2026-08-30T00:00:00.000Z" } = {}) {
  const definition = {
    entity: "GridBenchmarkDefinition",
    benchmarkId: GRID_BENCHMARK_ID,
    version: GRID_BENCHMARK_VERSION,
    category: "grid_trading",
    frozenAt,
    market: GRID_FROZEN_MARKET,
    strategy: GRID_BENCHMARK_STRATEGY,
    scenarios: GRID_BENCHMARK_SCENARIOS,
    policy: GRID_BENCHMARK_POLICY,
    executionModel: "agent_managed_price_triggered_execution",
    executionModelNote: "Levels are software-managed and executed as PancakeSwap swaps. They are not native resting limit orders, and nothing here creates an order id.",
  };
  return { ...definition, precommit: contentHashes(definition) };
}

/** The public packet: the task without the answers. */
export function publicGridBenchPacket(definition) {
  return {
    benchmarkId: definition.benchmarkId,
    version: definition.version,
    category: definition.category,
    frozenAt: definition.frozenAt,
    market: definition.market,
    strategy: definition.strategy,
    executionModel: definition.executionModel,
    executionModelNote: definition.executionModelNote,
    scenarios: definition.scenarios.map(({ expect, ...rest }) => rest),
    precommit: definition.precommit,
  };
}
