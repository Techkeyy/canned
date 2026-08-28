import { parseAbi } from "viem";

/**
 * Venus Core Pool on BNB Smart Chain. Supply yield here is fully described by
 * onchain state: a per-block supply rate, the market's own interest-rate model
 * constant, and the cash/borrow/reserve figures that set utilisation.
 * Source: https://docs-v4.venus.io/
 */
export const VENUS_MAINNET_CORE = Object.freeze({
  chainId: 56,
  comptroller: "0xfD36E2c2a6789Db23113685031d7F16329158384",
  poolRegistry: "0x9F7b01A536aFA00EF10310A162877fd792cD0666",
  source: "https://docs-v4.venus.io/",
  markets: Object.freeze({
    vUSDT: { vToken: "0xfD5840Cd36d94D7229439859C0112a4185BC0255", symbol: "USDT" },
    vUSDC: { vToken: "0xecA88125a5ADbe82614ffC12D0DB554E2e2867C8", symbol: "USDC" },
    vFDUSD: { vToken: "0xC4eF4229FEc74Ccfe17B2bdeF7715fAC740BA0ba", symbol: "FDUSD" },
    vDAI: { vToken: "0x334b3eCB4DCa3593BCCC3c7EBD1A1C1d1780FBF1", symbol: "DAI" },
  }),
});

export const VTOKEN_ABI = parseAbi([
  "function supplyRatePerBlock() view returns (uint256)",
  "function borrowRatePerBlock() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function totalReserves() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function reserveFactorMantissa() view returns (uint256)",
  "function interestRateModel() view returns (address)",
  "function underlying() view returns (address)",
  "function symbol() view returns (string)",
]);

export const IRM_ABI = parseAbi(["function blocksPerYear() view returns (uint256)"]);
export const IRM_LEGACY_ABI = parseAbi(["function BLOCKS_PER_YEAR() view returns (uint256)"]);
export const COMPTROLLER_YIELD_ABI = parseAbi([
  "function venusSupplySpeeds(address) view returns (uint256)",
  "function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa, bool isVenus)",
  "function supplyCaps(address) view returns (uint256)",
]);
export const ERC20_ABI = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

const MANTISSA = 1e18;

/**
 * Venus quotes a per-block rate. Turning that into an annual figure needs the
 * market's own blocksPerYear constant, which is read from its interest-rate
 * model rather than assumed: BSC block time has changed more than once and a
 * hardcoded constant would silently misprice every market.
 */
export function supplyApr(supplyRatePerBlock, blocksPerYear) {
  return (Number(supplyRatePerBlock) / MANTISSA) * Number(blocksPerYear);
}

export function supplyApy(supplyRatePerBlock, blocksPerYear, compoundsPerYear = 365) {
  const blocksPerPeriod = Number(blocksPerYear) / compoundsPerYear;
  const ratePerPeriod = (Number(supplyRatePerBlock) / MANTISSA) * blocksPerPeriod;
  return Math.pow(1 + ratePerPeriod, compoundsPerYear) - 1;
}

/** Utilisation is borrows over total supplied liquidity, in basis points. */
export function utilisationBps({ cash, totalBorrows, totalReserves }) {
  const denominator = BigInt(cash) + BigInt(totalBorrows) - BigInt(totalReserves);
  if (denominator <= 0n) return null;
  return Number((BigInt(totalBorrows) * 10_000n) / denominator);
}

/** Simple, non-compounded return over a horizon, in the asset's own units. */
export function returnOverHorizon({ principal, apr, days }) {
  return Number(principal) * Number(apr) * (Number(days) / 365);
}

/**
 * Days until a move's yield advantage repays its one-off cost. A move that costs
 * nothing, or is outright favourable, breaks even immediately.
 */
export function breakEvenDays({ principal, aprDelta, oneOffCost }) {
  if (Number(oneOffCost) <= 0) return 0;
  const dailyGain = (Number(principal) * Number(aprDelta)) / 365;
  if (!(dailyGain > 0)) return null;
  return Number(oneOffCost) / dailyGain;
}

export function validateAuthoritativeYieldSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") errors.push("snapshot_missing");
  if (snapshot?.protocol !== "Venus") errors.push("protocol_not_venus");
  if (snapshot?.source !== "onchain") errors.push("snapshot_not_onchain");
  if (snapshot?.authoritative !== true) errors.push("snapshot_not_marked_authoritative");
  if (!snapshot?.asOfBlock || !snapshot?.blockHash || !snapshot?.blockTimestamp) errors.push("frozen_block_fields_missing");
  if (!Array.isArray(snapshot?.markets) || snapshot.markets.length < 2) errors.push("at_least_two_markets_required");
  for (const market of snapshot?.markets || []) {
    if (!market.vToken || !market.assetSymbol) errors.push("market_identity_missing");
    if (market.supplyRatePerBlock === undefined || market.blocksPerYear === undefined) errors.push("supply_rate_fields_missing");
    if (market.cash === undefined || market.totalBorrows === undefined) errors.push("liquidity_fields_missing");
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Read every declared market at one block. Reading them together is the point:
 * comparing rates sampled at different moments would not be a comparison.
 */
export async function readVenusYieldSnapshot({ publicClient, markets = VENUS_MAINNET_CORE.markets, blockNumber, expectedChainId = 56, comptroller = VENUS_MAINNET_CORE.comptroller } = {}) {
  if (!publicClient?.readContract || !publicClient?.getBlock) throw new Error("A viem public client is required for Venus yield reads.");
  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) throw new Error(`Refusing Venus yield read on chain ${chainId}; expected ${expectedChainId}.`);
  const block = await publicClient.getBlock({ blockNumber: blockNumber === undefined || blockNumber === "latest" ? undefined : BigInt(blockNumber) });
  const atBlock = block.number;

  const readMarket = async (key, entry) => {
    const call = (functionName) => publicClient.readContract({ address: entry.vToken, abi: VTOKEN_ABI, functionName, blockNumber: atBlock });
    const [supplyRatePerBlock, borrowRatePerBlock, cash, totalBorrows, totalReserves, totalSupply, exchangeRateStored, reserveFactorMantissa, model, underlying, vSymbol] = await Promise.all([
      call("supplyRatePerBlock"), call("borrowRatePerBlock"), call("getCash"), call("totalBorrows"), call("totalReserves"),
      call("totalSupply"), call("exchangeRateStored"), call("reserveFactorMantissa"), call("interestRateModel"), call("underlying"), call("symbol"),
    ]);
    // The constant lives under two different names across model versions.
    let blocksPerYear = null;
    for (const [abi, fn] of [[IRM_ABI, "blocksPerYear"], [IRM_LEGACY_ABI, "BLOCKS_PER_YEAR"]]) {
      try { blocksPerYear = await publicClient.readContract({ address: model, abi, functionName: fn, blockNumber: atBlock }); break; } catch { /* try the next name */ }
    }
    if (blocksPerYear === null) throw new Error(`Could not read blocksPerYear for ${key}; refusing to assume a block time.`);
    const [assetSymbol, assetDecimals] = await Promise.all([
      publicClient.readContract({ address: underlying, abi: ERC20_ABI, functionName: "symbol", blockNumber: atBlock }),
      publicClient.readContract({ address: underlying, abi: ERC20_ABI, functionName: "decimals", blockNumber: atBlock }),
    ]);
    const [supplySpeed, marketRow, supplyCap] = await Promise.all([
      publicClient.readContract({ address: comptroller, abi: COMPTROLLER_YIELD_ABI, functionName: "venusSupplySpeeds", args: [entry.vToken], blockNumber: atBlock }).catch(() => null),
      publicClient.readContract({ address: comptroller, abi: COMPTROLLER_YIELD_ABI, functionName: "markets", args: [entry.vToken], blockNumber: atBlock }).catch(() => null),
      publicClient.readContract({ address: comptroller, abi: COMPTROLLER_YIELD_ABI, functionName: "supplyCaps", args: [entry.vToken], blockNumber: atBlock }).catch(() => null),
    ]);
    const apr = supplyApr(supplyRatePerBlock, blocksPerYear);
    return {
      key,
      vToken: entry.vToken,
      vTokenSymbol: vSymbol,
      asset: underlying,
      assetSymbol,
      assetDecimals: Number(assetDecimals),
      supplyRatePerBlock: supplyRatePerBlock.toString(),
      borrowRatePerBlock: borrowRatePerBlock.toString(),
      blocksPerYear: blocksPerYear.toString(),
      supplyAprDecimal: apr,
      supplyApyDecimal: supplyApy(supplyRatePerBlock, blocksPerYear),
      cash: cash.toString(),
      totalBorrows: totalBorrows.toString(),
      totalReserves: totalReserves.toString(),
      totalSupply: totalSupply.toString(),
      exchangeRateStored: exchangeRateStored.toString(),
      reserveFactorMantissa: reserveFactorMantissa.toString(),
      interestRateModel: model,
      utilisationBps: utilisationBps({ cash, totalBorrows, totalReserves }),
      // Zero means this market pays no token incentives, so the base supply rate
      // is the whole yield. A non-zero value would have to be priced separately.
      venusSupplySpeed: supplySpeed === null ? null : supplySpeed.toString(),
      incentivesIncluded: supplySpeed !== null && supplySpeed === 0n,
      collateralFactorMantissa: marketRow ? String(marketRow[1]) : null,
      supplyCap: supplyCap === null ? null : supplyCap.toString(),
    };
  };

  const entries = await Promise.all(Object.entries(markets).map(([key, entry]) => readMarket(key, entry)));
  return {
    protocol: "Venus",
    poolType: "core",
    source: "onchain",
    chainId,
    asOfBlock: String(atBlock),
    blockHash: block.hash,
    blockTimestamp: Number(block.timestamp),
    readPlan: {
      chainId,
      comptroller,
      blockTag: String(atBlock),
      methods: ["supplyRatePerBlock()", "getCash()", "totalBorrows()", "totalReserves()", "reserveFactorMantissa()", "interestRateModel()", "blocksPerYear()", "venusSupplySpeeds(address)", "supplyCaps(address)"],
      authoritative: true,
      source: VENUS_MAINNET_CORE.source,
      note: "Every market is read at the same block, so the comparison is between simultaneous states.",
    },
    markets: entries,
    authoritative: true,
  };
}
