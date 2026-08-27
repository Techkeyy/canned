import path from "node:path";
import { createPublicClient, http, parseAbiItem } from "viem";
import { contentHashes, nowIso } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { PANCAKESWAP_V3, V3_FACTORY_ABI, V3_POSITION_MANAGER_ABI, BSC_MAINNET_CHAIN_ID, readPancakePositionSnapshot } from "../src/reference/pancakeswap.mjs";
import { createRebalanceBenchDefinition, publicRebalanceBenchSource, rebalanceContainsSecretAnswer, REBALANCE_BENCHMARK_ID } from "../src/reference/rebalance-benchmark.mjs";

/**
 * Declared before any read, so the frozen scenario cannot be shopped for:
 *
 * - Pool: the canonical BNB pair, WBNB/USDT, at the fee tier with the deepest
 *   liquidity and the largest oracle cardinality.
 * - Position: the most recently minted position in that pool with non-zero
 *   liquidity at the freeze block.
 * - Block: the chain head at freeze time minus a fixed confirmation depth.
 */
const SELECTION = Object.freeze({
  tokenA: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  tokenB: "0x55d398326f99059fF775485246999027B3197955",
  feeTierCandidates: [100, 500, 2500],
  poolRule: "WBNB/USDT at the fee tier with the greatest in-range liquidity and the largest observation cardinality.",
  positionRule: "The most recently minted position in the selected pool with non-zero liquidity at the freeze block.",
  blockRule: "Chain head at freeze time minus 30 blocks, for confirmation depth.",
  confirmationDepth: 30n,
  scanSpanBlocks: 1_500n,
  scanWindows: 6,
});

const MAINNET_RPCS = ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.bnbchain.org"];

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const log = (body) => console.log(JSON.stringify(body, null, 2));

const existing = await store.loadJson("state/rebalancebench-v1.json", null);
if (existing && env.CANNED_REBALANCE_REFREEZE !== "true") {
  log({ status: "already_frozen", benchmarkId: existing.benchmarkId, referenceBlock: existing.referenceBlock, precommit: existing.precommit, note: "RebalanceBench v1 is immutable. Refreezing would invalidate any baseline taken against it." });
  process.exit(0);
}
const baseline = await store.loadJson("state/rebalance-baseline.json", null);
if (baseline && baseline.status !== "not_started") {
  log({ status: "blocked", reason: "A human baseline already exists for RebalanceBench v1; the benchmark may not be refrozen.", baselineStatus: baseline.status });
  process.exit(2);
}

const rpcUrl = env.CANNED_MAINNET_READ_RPC_URL || MAINNET_RPCS[0];
const chain = { id: BSC_MAINNET_CHAIN_ID, name: "BSC", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }) });
const chainId = await publicClient.getChainId();
if (chainId !== BSC_MAINNET_CHAIN_ID) throw new Error(`Expected BSC mainnet for read-only market data; observed chain ${chainId}.`);

const head = await publicClient.getBlockNumber();
const freezeBlock = head - SELECTION.confirmationDepth;
log({ status: "selecting", head: String(head), freezeBlock: String(freezeBlock), rule: SELECTION.blockRule, access: "read_only" });

// Pool selection.
const poolCandidates = [];
for (const fee of SELECTION.feeTierCandidates) {
  const address = await publicClient.readContract({ address: PANCAKESWAP_V3.factory, abi: V3_FACTORY_ABI, functionName: "getPool", args: [SELECTION.tokenA, SELECTION.tokenB, fee] });
  if (address === "0x0000000000000000000000000000000000000000") continue;
  const poolAbi = (await import("../src/reference/pancakeswap.mjs")).V3_POOL_ABI;
  const [slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address, abi: poolAbi, functionName: "slot0", blockNumber: freezeBlock }),
    publicClient.readContract({ address, abi: poolAbi, functionName: "liquidity", blockNumber: freezeBlock }),
  ]);
  poolCandidates.push({ fee, address, liquidity: liquidity.toString(), observationCardinality: Number(slot0[3]), tick: Number(slot0[1]) });
}
if (!poolCandidates.length) throw new Error("No WBNB/USDT PancakeSwap V3 pool was found.");
poolCandidates.sort((left, right) => (BigInt(right.liquidity) > BigInt(left.liquidity) ? 1 : BigInt(right.liquidity) < BigInt(left.liquidity) ? -1 : right.observationCardinality - left.observationCardinality));
const pool = poolCandidates[0];
log({ status: "pool_selected", pool, rule: SELECTION.poolRule, candidates: poolCandidates });

// Position selection.
const increaseEvent = parseAbiItem("event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)");
const seen = new Map();
for (let window = 0; window < SELECTION.scanWindows; window += 1) {
  const toBlock = freezeBlock - SELECTION.scanSpanBlocks * BigInt(window);
  const fromBlock = toBlock - SELECTION.scanSpanBlocks;
  try {
    const logs = await publicClient.getLogs({ address: PANCAKESWAP_V3.positionManager, event: increaseEvent, fromBlock, toBlock });
    for (const entry of logs) {
      const tokenId = String(entry.args.tokenId);
      const previous = seen.get(tokenId);
      if (!previous || entry.blockNumber > previous) seen.set(tokenId, entry.blockNumber);
    }
  } catch { /* a window the endpoint will not serve is skipped, not estimated */ }
}
const ordered = [...seen.entries()].sort((left, right) => (right[1] > left[1] ? 1 : right[1] < left[1] ? -1 : 0));
let selectedPosition = null;
for (const [tokenId, mintedAt] of ordered) {
  try {
    const position = await publicClient.readContract({ address: PANCAKESWAP_V3.positionManager, abi: V3_POSITION_MANAGER_ABI, functionName: "positions", args: [BigInt(tokenId)], blockNumber: freezeBlock });
    const [, , token0, token1, fee, , , liquidity] = position;
    const pair = [token0.toLowerCase(), token1.toLowerCase()];
    if (Number(fee) !== pool.fee) continue;
    if (!pair.includes(SELECTION.tokenA.toLowerCase()) || !pair.includes(SELECTION.tokenB.toLowerCase())) continue;
    if (liquidity <= 0n) continue;
    selectedPosition = { tokenId, lastIncreaseBlock: String(mintedAt) };
    break;
  } catch { /* an unreadable token ID is skipped */ }
}
if (!selectedPosition) throw new Error("No non-zero-liquidity position was found in the selected pool within the scanned window.");
log({ status: "position_selected", position: selectedPosition, rule: SELECTION.positionRule, scanned: ordered.length });

// Frozen authoritative read.
const snapshot = await readPancakePositionSnapshot({ publicClient, poolAddress: pool.address, positionTokenId: selectedPosition.tokenId, blockNumber: freezeBlock });
const definition = createRebalanceBenchDefinition({
  snapshot,
  selectionRule: `${SELECTION.blockRule} ${SELECTION.poolRule} ${SELECTION.positionRule}`,
  sourceUrls: [PANCAKESWAP_V3.source, "https://developer.pancakeswap.finance/contracts/v3/addresses", `https://bscscan.com/address/${pool.address}`],
});

// The public packet the human will see must not carry an answer.
const source = publicRebalanceBenchSource(definition);
if (rebalanceContainsSecretAnswer(source) || rebalanceContainsSecretAnswer(definition.task)) throw new Error("The frozen definition leaks an answer key; refusing to freeze.");

const { precommit, ...withoutPrecommit } = definition;
const recomputed = contentHashes(withoutPrecommit);
if (recomputed.sha256 !== precommit.canonicalSha256 || recomputed.keccak256 !== precommit.manifestKeccak256) throw new Error("The precommit hashes do not reproduce; refusing to freeze.");

await store.saveJson("state/rebalancebench-v1.json", definition);
const evidence = await store.saveEvidence({ kind: "rebalance_benchmark_frozen", benchmarkId: REBALANCE_BENCHMARK_ID, definition, frozenAt: nowIso() });

log({
  status: "rebalance_benchmark_frozen",
  benchmarkId: definition.benchmarkId,
  version: definition.version,
  venue: definition.venue,
  marketDataChain: definition.executionBoundary.marketDataChain,
  marketDataAccess: definition.executionBoundary.marketDataAccess,
  paymentChain: definition.executionBoundary.paymentAndAgentExecutionChain,
  pool: { address: definition.pool.address, pair: `${definition.pool.token0.symbol}/${definition.pool.token1.symbol}`, fee: definition.pool.fee, tickSpacing: definition.pool.tickSpacing },
  position: definition.position,
  referenceBlock: definition.referenceBlock,
  currentTick: snapshot.slot0.tick,
  observationWindows: snapshot.observations ? snapshot.observations.meanTicks.map((entry) => entry.secondsAgo) : [],
  evaluator: definition.evaluator,
  precommit: definition.precommit,
  evidence: evidence.sha256,
  secretOutput: "none",
});
