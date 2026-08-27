import { parseAbi } from "viem";

/**
 * Official PancakeSwap V3 deployment. The same deterministic addresses exist on
 * BSC mainnet and BSC testnet; the addresses are identical, the markets are not.
 * Source: https://docs.pancakeswap.finance/trading-tools/building-trading-agents-on-pancakeswap-v3
 */
export const PANCAKESWAP_V3 = Object.freeze({
  factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  positionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  smartRouter: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
  quoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  masterChefV3: "0x556B9306565093C855AEA9AE92A594704c2Cd59e",
  permit2: "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768",
  source: "https://docs.pancakeswap.finance/trading-tools/building-trading-agents-on-pancakeswap-v3",
});

export const BSC_MAINNET_CHAIN_ID = 56;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export const V3_FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);

export const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

export const V3_POSITION_MANAGER_ABI = parseAbi([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function ownerOf(uint256 tokenId) view returns (address)",
]);

export const ERC20_METADATA_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** Ticks are a log price scale: price(token1 per token0, raw units) = 1.0001^tick. */
export function tickToRawPrice(tick) {
  return Math.pow(1.0001, Number(tick));
}

/**
 * Human-readable price of one whole token0 denominated in whole token1.
 * Raw tick prices are in base units, so the decimal difference must be applied.
 */
export function tickToPrice(tick, decimals0, decimals1) {
  return tickToRawPrice(tick) * Math.pow(10, Number(decimals0) - Number(decimals1));
}

export function priceToTick(price, decimals0, decimals1) {
  const raw = Number(price) / Math.pow(10, Number(decimals0) - Number(decimals1));
  return Math.round(Math.log(raw) / Math.log(1.0001));
}

export function isValidTick(tick) {
  return Number.isInteger(Number(tick)) && Number(tick) >= MIN_TICK && Number(tick) <= MAX_TICK;
}

export function isTickSpacingAligned(tick, tickSpacing) {
  const spacing = Number(tickSpacing);
  return spacing > 0 && Number.isInteger(Number(tick)) && Number(tick) % spacing === 0;
}

/** Round a tick to a usable boundary. PancakeSwap rejects unaligned ticks outright. */
export function alignTick(tick, tickSpacing, mode = "nearest") {
  const spacing = Number(tickSpacing);
  if (!(spacing > 0)) throw new Error("Tick spacing must be positive.");
  const value = Number(tick) / spacing;
  const rounded = mode === "down" ? Math.floor(value) : mode === "up" ? Math.ceil(value) : Math.round(value);
  return Math.max(MIN_TICK, Math.min(MAX_TICK, rounded * spacing));
}

/**
 * Classify a concentrated-liquidity position against the live tick.
 * A V3 position holds only token1 below its range and only token0 above it, so
 * "out of range" is also a statement about what the LP is now holding.
 */
export function classifyRange({ currentTick, tickLower, tickUpper, tickSpacing, decimals0 = 18, decimals1 = 18 } = {}) {
  const current = Number(currentTick);
  const lower = Number(tickLower);
  const upper = Number(tickUpper);
  const errors = [];
  if (!isValidTick(lower) || !isValidTick(upper)) errors.push("tick_out_of_protocol_bounds");
  if (lower >= upper) errors.push("lower_tick_not_below_upper_tick");
  if (tickSpacing !== undefined && (!isTickSpacingAligned(lower, tickSpacing) || !isTickSpacingAligned(upper, tickSpacing))) errors.push("tick_not_aligned_to_spacing");
  if (errors.length) return { valid: false, errors, status: "INVALID_RANGE" };

  const inRange = current >= lower && current < upper;
  const widthTicks = upper - lower;
  const ticksToLower = current - lower;
  const ticksToUpper = upper - current;
  const nearestEdge = ticksToLower <= ticksToUpper ? "lower" : "upper";
  const ticksToNearestEdge = Math.min(ticksToLower, ticksToUpper);
  // Fraction of the range already traversed: 0 at the lower edge, 1 at the upper.
  const positionInRange = inRange ? ticksToLower / widthTicks : null;
  const edgeProximityPct = inRange ? (ticksToNearestEdge / (widthTicks / 2)) * 100 : null;
  return {
    valid: true,
    errors: [],
    status: inRange ? "IN_RANGE" : current < lower ? "OUT_OF_RANGE_BELOW" : "OUT_OF_RANGE_ABOVE",
    inRange,
    currentTick: current,
    tickLower: lower,
    tickUpper: upper,
    widthTicks,
    ticksToLower,
    ticksToUpper,
    nearestEdge,
    ticksToNearestEdge,
    positionInRange: positionInRange === null ? null : Number(positionInRange.toFixed(6)),
    edgeProximityPct: edgeProximityPct === null ? null : Number(edgeProximityPct.toFixed(4)),
    price: { current: tickToPrice(current, decimals0, decimals1), lower: tickToPrice(lower, decimals0, decimals1), upper: tickToPrice(upper, decimals0, decimals1) },
    composition: inRange
      ? "Mixed token0 and token1; the split moves toward token0 as price falls and toward token1 as price rises."
      : current < lower
        ? "Entirely token0. Price is below the range, so the position stopped earning fees and holds the weaker asset."
        : "Entirely token1. Price is above the range, so the position stopped earning fees.",
  };
}

/**
 * Mean tick over each requested window, taken from the pool's own TWAP oracle.
 * Cardinality bounds how far back the pool can answer; windows beyond it are
 * reported as unavailable rather than estimated.
 */
export function meanTicksFromObservations({ secondsAgos, tickCumulatives }) {
  if (!Array.isArray(secondsAgos) || !Array.isArray(tickCumulatives) || secondsAgos.length !== tickCumulatives.length) {
    throw new Error("Observation windows and tick cumulatives must line up.");
  }
  const nowIndex = secondsAgos.indexOf(0);
  if (nowIndex < 0) throw new Error("Observations must include a zero-seconds-ago reading.");
  const nowCumulative = BigInt(tickCumulatives[nowIndex]);
  return secondsAgos.map((secondsAgo, index) => {
    if (secondsAgo === 0) return { secondsAgo: 0, meanTick: null, note: "reference point" };
    const delta = nowCumulative - BigInt(tickCumulatives[index]);
    return { secondsAgo: Number(secondsAgo), meanTick: Number(delta / BigInt(secondsAgo)) };
  });
}

export function validateAuthoritativePancakeSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") errors.push("snapshot_missing");
  if (snapshot?.protocol !== "PancakeSwapV3") errors.push("protocol_not_pancakeswap_v3");
  if (snapshot?.source !== "onchain") errors.push("snapshot_not_onchain");
  if (snapshot?.authoritative !== true) errors.push("snapshot_not_marked_authoritative");
  if (!snapshot?.asOfBlock || !snapshot?.blockHash || !snapshot?.blockTimestamp) errors.push("frozen_block_fields_missing");
  if (!snapshot?.pool?.address || !snapshot?.pool?.token0 || !snapshot?.pool?.token1) errors.push("pool_identity_missing");
  if (snapshot?.pool?.tickSpacing === undefined || snapshot?.pool?.fee === undefined) errors.push("pool_fee_or_spacing_missing");
  if (snapshot?.slot0?.tick === undefined || !snapshot?.slot0?.sqrtPriceX96) errors.push("slot0_missing");
  if (!snapshot?.position || snapshot.position.tickLower === undefined || snapshot.position.tickUpper === undefined) errors.push("position_bounds_missing");
  if (snapshot?.position?.liquidity === undefined) errors.push("position_liquidity_missing");
  return { valid: errors.length === 0, errors };
}

/**
 * Read the complete authoritative pool and position state at one frozen block.
 * Every value comes from a contract read at `blockNumber`; nothing is estimated
 * and nothing is scraped.
 */
export async function readPancakePositionSnapshot({ publicClient, poolAddress, positionTokenId, blockNumber, observationWindowsSeconds = [300, 3600, 21600, 86400], expectedChainId = BSC_MAINNET_CHAIN_ID } = {}) {
  if (!publicClient?.readContract || !publicClient?.getBlock) throw new Error("A viem public client is required for PancakeSwap reads.");
  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) throw new Error(`Refusing PancakeSwap read on chain ${chainId}; expected ${expectedChainId}.`);
  const block = await publicClient.getBlock({ blockNumber: blockNumber === undefined || blockNumber === "latest" ? undefined : BigInt(blockNumber) });
  const atBlock = block.number;
  const poolCall = (functionName, args) => publicClient.readContract({ address: poolAddress, abi: V3_POOL_ABI, functionName, args, blockNumber: atBlock });

  const [slot0, poolLiquidity, token0, token1, fee, tickSpacing, feeGrowthGlobal0X128, feeGrowthGlobal1X128] = await Promise.all([
    poolCall("slot0"), poolCall("liquidity"), poolCall("token0"), poolCall("token1"),
    poolCall("fee"), poolCall("tickSpacing"), poolCall("feeGrowthGlobal0X128"), poolCall("feeGrowthGlobal1X128"),
  ]);

  const meta = async (token) => {
    const [symbol, decimals] = await Promise.all([
      publicClient.readContract({ address: token, abi: ERC20_METADATA_ABI, functionName: "symbol", blockNumber: atBlock }),
      publicClient.readContract({ address: token, abi: ERC20_METADATA_ABI, functionName: "decimals", blockNumber: atBlock }),
    ]);
    return { address: token, symbol, decimals: Number(decimals) };
  };
  const [meta0, meta1] = await Promise.all([meta(token0), meta(token1)]);

  const position = await publicClient.readContract({ address: PANCAKESWAP_V3.positionManager, abi: V3_POSITION_MANAGER_ABI, functionName: "positions", args: [BigInt(positionTokenId)], blockNumber: atBlock });
  const [, , posToken0, posToken1, posFee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1] = position;
  if (posToken0.toLowerCase() !== token0.toLowerCase() || posToken1.toLowerCase() !== token1.toLowerCase() || Number(posFee) !== Number(fee)) {
    throw new Error("The position does not belong to the declared pool.");
  }

  // The oracle can only answer within its observation cardinality. Windows it
  // cannot serve are recorded as unavailable rather than filled with a guess.
  const secondsAgos = [...observationWindowsSeconds].sort((a, b) => b - a).concat(0);
  let observations = null;
  let observationError = null;
  for (let attempt = 0; attempt < secondsAgos.length - 1 && observations === null; attempt += 1) {
    const candidate = secondsAgos.slice(attempt);
    try {
      const [tickCumulatives] = await poolCall("observe", [candidate.map((value) => Number(value))]);
      observations = { secondsAgos: candidate.map(Number), tickCumulatives: tickCumulatives.map(String), meanTicks: meanTicksFromObservations({ secondsAgos: candidate.map(Number), tickCumulatives }) };
    } catch (error) {
      observationError = error.shortMessage || error.message;
    }
  }

  return {
    protocol: "PancakeSwapV3",
    source: "onchain",
    chainId,
    venue: "PancakeSwap",
    asOfBlock: String(atBlock),
    blockHash: block.hash,
    blockTimestamp: Number(block.timestamp),
    readPlan: {
      chainId,
      factory: PANCAKESWAP_V3.factory,
      positionManager: PANCAKESWAP_V3.positionManager,
      pool: poolAddress,
      blockTag: String(atBlock),
      methods: ["slot0()", "liquidity()", "token0()", "token1()", "fee()", "tickSpacing()", "feeGrowthGlobal0X128()", "feeGrowthGlobal1X128()", "observe(uint32[])", "positions(uint256)"],
      authoritative: true,
      source: PANCAKESWAP_V3.source,
    },
    pool: {
      address: poolAddress,
      token0: meta0,
      token1: meta1,
      fee: Number(fee),
      feePercent: Number(fee) / 10_000,
      tickSpacing: Number(tickSpacing),
      liquidityRaw: poolLiquidity.toString(),
      feeGrowthGlobal0X128: feeGrowthGlobal0X128.toString(),
      feeGrowthGlobal1X128: feeGrowthGlobal1X128.toString(),
    },
    slot0: {
      sqrtPriceX96: slot0[0].toString(),
      tick: Number(slot0[1]),
      observationIndex: Number(slot0[2]),
      observationCardinality: Number(slot0[3]),
      unlocked: Boolean(slot0[6]),
    },
    position: {
      tokenId: String(positionTokenId),
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      liquidity: liquidity.toString(),
      feeGrowthInside0LastX128: feeGrowthInside0LastX128.toString(),
      feeGrowthInside1LastX128: feeGrowthInside1LastX128.toString(),
      tokensOwed0: tokensOwed0.toString(),
      tokensOwed1: tokensOwed1.toString(),
    },
    observations,
    observationError: observations ? null : observationError,
    authoritative: true,
  };
}
