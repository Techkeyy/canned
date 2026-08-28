import path from "node:path";
import { createPublicClient, http } from "viem";
import { contentHashes, nowIso } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { readVenusYieldSnapshot, VENUS_MAINNET_CORE } from "../src/reference/venus-yield.mjs";
import { quoteReallocationRoutes, reallocationGasCost } from "../src/reference/swap-route.mjs";
import { REALLOCATION_STEPS } from "../src/reference/yield-scout.mjs";
import { createYieldBenchDefinition, publicYieldBenchSource, yieldContainsSecretAnswer, YIELD_BENCHMARK_ID } from "../src/reference/yield-benchmark.mjs";

/**
 * Declared before any read, so the scenario cannot be shopped for:
 *
 * - Venue: Venus Core Pool, the deepest lending market on BNB Smart Chain.
 * - Markets: every listed Core stablecoin market, so the comparison is not a
 *   hand-picked pair.
 * - Position: 25,000 USDC, a round retail-to-small-treasury size.
 * - Horizon: 30 days.
 * - Block: chain head at freeze time minus a fixed confirmation depth. Every
 *   yield, liquidity, swap quote, and gas figure is taken at that one block.
 */
const SELECTION = Object.freeze({
  positionAsset: "USDC",
  positionMarketKey: "vUSDC",
  positionAmount: 25_000,
  horizonDays: 30,
  confirmationDepth: 30n,
  blockRule: "Chain head at freeze time minus 30 blocks, for confirmation depth.",
  marketRule: "Every listed Venus Core stablecoin market, not a hand-picked pair.",
  positionRule: "A round 25,000 USDC position, declared before any rate was read.",
});

const TOKENS = Object.freeze({
  USDT: "0x55d398326f99059fF775485246999027B3197955",
  USDC: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  FDUSD: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409",
  DAI: "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3",
});

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const log = (body) => console.log(JSON.stringify(body, null, 2));

const existing = await store.loadJson("state/yieldbench-v1.json", null);
if (existing && env.CANNED_YIELD_REFREEZE !== "true") {
  log({ status: "already_frozen", benchmarkId: existing.benchmarkId, referenceBlock: existing.referenceBlock, precommit: existing.precommit, note: "YieldBench v1 is immutable. Refreezing would invalidate any baseline taken against it." });
  process.exit(0);
}
const baseline = await store.loadJson("state/yield-baseline.json", null);
if (baseline && baseline.status !== "not_started") {
  log({ status: "blocked", reason: "A human baseline already exists for YieldBench v1; the benchmark may not be refrozen.", baselineStatus: baseline.status });
  process.exit(2);
}

// A single read endpoint is a single point of failure for a freeze that must be
// coherent; try the declared endpoints until one answers.
const MAINNET_RPCS = [env.CANNED_MAINNET_READ_RPC_URL, "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.bnbchain.org", "https://bsc-dataseed2.bnbchain.org"].filter(Boolean);
let publicClient = null;
let rpcUrl = null;
for (const candidate of MAINNET_RPCS) {
  try {
    const chain = { id: 56, name: "BSC", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [candidate] } } };
    const client = createPublicClient({ chain, transport: http(candidate, { timeout: 30_000, retryCount: 3 }) });
    if (await client.getChainId() !== 56) continue;
    publicClient = client;
    rpcUrl = candidate;
    break;
  } catch { /* try the next endpoint */ }
}
if (!publicClient) throw new Error(`No BSC mainnet read endpoint answered. Tried: ${MAINNET_RPCS.join(", ")}`);
log({ status: "rpc_selected", rpcUrl, access: "read_only" });

const head = await publicClient.getBlockNumber();
const freezeBlock = head - SELECTION.confirmationDepth;
log({ status: "selecting", head: String(head), freezeBlock: String(freezeBlock), rule: SELECTION.blockRule, access: "read_only" });

// Every market, one block.
const snapshot = await readVenusYieldSnapshot({ publicClient, blockNumber: freezeBlock });
log({ status: "markets_read", block: snapshot.asOfBlock, markets: snapshot.markets.map((market) => ({ key: market.key, asset: market.assetSymbol, aprPct: Number((market.supplyAprDecimal * 100).toFixed(3)), utilBps: market.utilisationBps, incentiveSpeed: market.venusSupplySpeed })) });

const position = snapshot.markets.find((market) => market.key === SELECTION.positionMarketKey);
if (!position) throw new Error("The declared position market is not in the snapshot.");
const amountRaw = BigInt(Math.round(SELECTION.positionAmount * 10 ** position.assetDecimals));

// Swap costs for every candidate, quoted at the same block, direct and routed.
const swapRoutes = [];
for (const market of snapshot.markets) {
  if (market.key === SELECTION.positionMarketKey) continue;
  const intermediaries = Object.entries(TOKENS)
    .filter(([symbol]) => symbol !== position.assetSymbol && symbol !== market.assetSymbol && symbol !== "DAI")
    .map(([, address]) => address);
  const quote = await quoteReallocationRoutes({ publicClient, tokenIn: position.asset, tokenOut: market.asset, amountIn: amountRaw, intermediaries, blockNumber: freezeBlock });
  const annotated = {
    ...quote,
    toMarketKey: market.key,
    toAssetSymbol: market.assetSymbol,
    routes: quote.routes.map((route) => ({ ...route, viaSymbol: route.hops.length > 2 ? Object.entries(TOKENS).find(([, address]) => address.toLowerCase() === route.hops[1].toLowerCase())?.[0] ?? null : null })),
  };
  swapRoutes.push(annotated);
  log({ status: "route_quoted", to: market.assetSymbol, bestCostPct: quote.bestCostFraction === null ? null : Number((quote.bestCostFraction * 100).toFixed(4)), routesAvailable: quote.routesAvailable, bestKind: quote.bestRoute?.kind ?? null });
}

const block = await publicClient.getBlock({ blockNumber: freezeBlock });
const gasPriceWei = await publicClient.getGasPrice();
const gas = reallocationGasCost({ gasPriceWei, steps: REALLOCATION_STEPS });
// One stablecoin is worth about one dollar, so the native price is expressed in
// the position asset via the frozen BNB/stable pool rather than an outside feed.
const bnbQuote = await quoteReallocationRoutes({ publicClient, tokenIn: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", tokenOut: position.asset, amountIn: 10n ** 18n, intermediaries: [TOKENS.USDT], feeTiers: [100, 500, 2500], blockNumber: freezeBlock });
const nativePriceInAsset = bnbQuote.bestRoute ? Number(bnbQuote.bestRoute.amountOut) / 10 ** position.assetDecimals : null;
if (!(nativePriceInAsset > 0)) throw new Error("Could not price the network fee in the position asset; refusing to freeze an incomplete cost model.");

const costs = {
  quotedAtBlock: String(freezeBlock),
  gasPriceAtBlock: String(freezeBlock),
  gasPriceWei: gasPriceWei.toString(),
  gasCostNative: gas.gasCostNative,
  gasSteps: REALLOCATION_STEPS,
  totalGasUnits: gas.totalGasUnits,
  nativeSymbol: "BNB",
  nativePriceInAsset,
  nativePriceSource: { venue: "PancakeSwap V3", route: bnbQuote.bestRoute?.hops ?? null, fees: bnbQuote.bestRoute?.fees ?? null, blockTag: String(freezeBlock) },
  swapRoutes,
};

const definition = createYieldBenchDefinition({
  snapshot,
  position: { marketKey: SELECTION.positionMarketKey, assetSymbol: position.assetSymbol, asset: position.asset, amount: SELECTION.positionAmount, assetDecimals: position.assetDecimals },
  horizonDays: SELECTION.horizonDays,
  costs,
  selectionRule: `${SELECTION.blockRule} ${SELECTION.marketRule} ${SELECTION.positionRule}`,
  sourceUrls: [VENUS_MAINNET_CORE.source, "https://docs.pancakeswap.finance/trading-tools/building-trading-agents-on-pancakeswap-v3", `https://bscscan.com/address/${VENUS_MAINNET_CORE.comptroller}`],
});

const source = publicYieldBenchSource(definition);
if (yieldContainsSecretAnswer(source) || yieldContainsSecretAnswer(definition.task)) throw new Error("The frozen definition leaks an answer key; refusing to freeze.");
const { precommit, ...withoutPrecommit } = definition;
const recomputed = contentHashes(withoutPrecommit);
if (recomputed.sha256 !== precommit.canonicalSha256 || recomputed.keccak256 !== precommit.manifestKeccak256) throw new Error("The precommit hashes do not reproduce; refusing to freeze.");

await store.saveJson("state/yieldbench-v1.json", definition);
const evidence = await store.saveEvidence({ kind: "yield_benchmark_frozen", benchmarkId: YIELD_BENCHMARK_ID, definition, frozenAt: nowIso() });

log({
  status: "yield_benchmark_frozen",
  benchmarkId: definition.benchmarkId,
  version: definition.version,
  venue: definition.venue,
  marketDataChain: definition.executionBoundary.marketDataChain,
  marketDataAccess: definition.executionBoundary.marketDataAccess,
  paymentChain: definition.executionBoundary.paymentAndAgentExecutionChain,
  position: { asset: definition.position.assetSymbol, amount: definition.position.amount, market: definition.position.marketKey },
  horizonDays: definition.horizonDays,
  referenceBlock: definition.referenceBlock,
  blockTimestampIso: new Date(Number(block.timestamp) * 1000).toISOString(),
  markets: snapshot.markets.map((market) => ({ asset: market.assetSymbol, aprPct: Number((market.supplyAprDecimal * 100).toFixed(3)), liquidity: Number((Number(market.cash) / 10 ** market.assetDecimals).toFixed(0)) })),
  costs: { gasCostNative: costs.gasCostNative, nativePriceInAsset: Number(nativePriceInAsset.toFixed(2)), swapBestCostPct: swapRoutes.map((route) => ({ to: route.toAssetSymbol, pct: route.bestCostFraction === null ? null : Number((route.bestCostFraction * 100).toFixed(4)) })) },
  coherence: definition.coherence,
  evaluator: definition.evaluator,
  precommit: definition.precommit,
  evidence: evidence.sha256,
  secretOutput: "none",
});
