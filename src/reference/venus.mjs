import { parseAbi } from "viem";
import { REFERENCE_CHAIN_ID, VENUS_TESTNET_CORE } from "./constants.mjs";

export const VENUS_CORE_COMPTROLLER_ABI = parseAbi([
  "function getAccountLiquidity(address account) view returns (uint256, uint256, uint256)",
  "function getAssetsIn(address account) view returns (address[])",
  "function markets(address market) view returns (bool, uint256, bool)",
  "function oracle() view returns (address)",
  "function closeFactorMantissa() view returns (uint256)",
  "function liquidationIncentiveMantissa() view returns (uint256)",
]);

export const VENUS_MARKET_READ_ABI = parseAbi([
  "function getAccountSnapshot(address account) view returns (uint256, uint256, uint256, uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function borrowBalanceStored(address account) view returns (uint256)",
  "function exchangeRateStored() view returns (uint256)",
  "function getCash() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function borrowRatePerBlock() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export const VENUS_ORACLE_READ_ABI = parseAbi([
  "function getUnderlyingPrice(address vToken) view returns (uint256)",
]);

export const VENUS_POSITION_READ_REQUIREMENTS = Object.freeze({
  core: {
    source: "Venus Core Pool",
    primaryRead: "Comptroller.getAccountLiquidity(address)",
    note: "Liquidity and shortfall are preserved in raw protocol units. They are not relabeled as a generic health factor.",
  },
  isolated: {
    source: "Venus Isolated Pool",
    primaryRead: "Pool-specific position reads plus Comptroller liquidation rules",
    note: "getBorrowingPower alone is not treated as a liquidation verdict; the configured pool and liquidation threshold must be authoritative.",
  },
});

function address(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

export function createVenusCoreReadPlan({ account, comptrollerAddress, blockTag = "latest" } = {}) {
  if (!address(account)) throw new Error("A valid Venus position account is required.");
  if (!address(comptrollerAddress)) throw new Error("A configured Venus Core Comptroller address is required.");
  return {
    chainId: REFERENCE_CHAIN_ID,
    poolType: "core",
    account,
    contract: comptrollerAddress,
    method: "getAccountLiquidity(address)",
    args: [account],
    blockTag,
    authoritative: true,
  };
}

export function officialVenusCoreTestnet() {
  return { ...VENUS_TESTNET_CORE, chainId: REFERENCE_CHAIN_ID, poolType: "core" };
}

export async function readVenusCoreLiquidity({ publicClient, account, comptrollerAddress, blockTag = "latest" } = {}) {
  if (!publicClient?.getChainId || !publicClient?.readContract) throw new Error("A viem public client is required for Venus reads.");
  const chainId = await publicClient.getChainId();
  if (chainId !== REFERENCE_CHAIN_ID) throw new Error(`Refusing Venus read on chain ${chainId}; expected BSC testnet chain 97.`);
  const plan = createVenusCoreReadPlan({ account, comptrollerAddress, blockTag });
  const result = await publicClient.readContract({ address: comptrollerAddress, abi: VENUS_CORE_COMPTROLLER_ABI, functionName: "getAccountLiquidity", args: [account], blockTag });
  const [errorCode, liquidity, shortfall] = result;
  return {
    protocol: "Venus",
    poolType: "core",
    source: "onchain",
    chainId,
    account,
    asOfBlock: blockTag,
    readPlan: plan,
    errorCode: String(errorCode),
    liquidityRaw: String(liquidity),
    shortfallRaw: String(shortfall),
    authoritative: true,
  };
}

export async function readVenusCorePosition({ publicClient, account, blockNumber = "latest", contracts = VENUS_TESTNET_CORE } = {}) {
  if (!publicClient?.getChainId || !publicClient?.readContract || !publicClient?.getBlock) throw new Error("A viem public client is required for Venus position reads.");
  const chainId = await publicClient.getChainId();
  if (chainId !== REFERENCE_CHAIN_ID) throw new Error(`Refusing Venus read on chain ${chainId}; expected BSC testnet chain 97.`);
  const block = await publicClient.getBlock({ blockNumber: blockNumber === "latest" ? undefined : BigInt(blockNumber) });
  const atBlock = block.number;
  const comptroller = contracts.comptroller;
  const oracle = contracts.oracle;
  const marketAddresses = [contracts.vBNB, contracts.vUSDT];
  const readOptional = async (functionName) => {
    try { return await publicClient.readContract({ address: comptroller, abi: VENUS_CORE_COMPTROLLER_ABI, functionName, blockNumber: atBlock }); } catch { return null; }
  };
  const [liquidity, assetsIn, closeFactor, liquidationIncentive, marketRows, markets, prices] = await Promise.all([
    publicClient.readContract({ address: comptroller, abi: VENUS_CORE_COMPTROLLER_ABI, functionName: "getAccountLiquidity", args: [account], blockNumber: atBlock }),
    publicClient.readContract({ address: comptroller, abi: VENUS_CORE_COMPTROLLER_ABI, functionName: "getAssetsIn", args: [account], blockNumber: atBlock }),
    publicClient.readContract({ address: comptroller, abi: VENUS_CORE_COMPTROLLER_ABI, functionName: "closeFactorMantissa", blockNumber: atBlock }),
    readOptional("liquidationIncentiveMantissa"),
    Promise.all(marketAddresses.map((market) => publicClient.readContract({ address: comptroller, abi: VENUS_CORE_COMPTROLLER_ABI, functionName: "markets", args: [market], blockNumber: atBlock }))),
    Promise.all(marketAddresses.map((market) => publicClient.readContract({ address: market, abi: VENUS_MARKET_READ_ABI, functionName: "getAccountSnapshot", args: [account], blockNumber: atBlock }))),
    Promise.all(marketAddresses.map((market) => publicClient.readContract({ address: oracle, abi: VENUS_ORACLE_READ_ABI, functionName: "getUnderlyingPrice", args: [market], blockNumber: atBlock }))),
  ]);
  const [errorCode, liquidityRaw, shortfallRaw] = liquidity;
  const marketSnapshots = Object.fromEntries(marketAddresses.map((market, index) => {
    const [error, vTokenBalance, borrowBalance, exchangeRate] = markets[index];
    const [listed, collateralFactorMantissa, isComped] = marketRows[index];
    return [market, {
      vToken: market,
      listed,
      collateralFactorMantissa: String(collateralFactorMantissa),
      isComped,
      snapshotError: String(error),
      vTokenBalanceRaw: String(vTokenBalance),
      borrowBalanceRaw: String(borrowBalance),
      exchangeRateMantissa: String(exchangeRate),
      priceRaw: String(prices[index]),
    }];
  }));
  return {
    protocol: "Venus",
    poolType: "core",
    source: "onchain",
    chainId,
    account,
    asOfBlock: String(atBlock),
    blockHash: block.hash,
    blockTimestamp: Number(block.timestamp),
    readPlan: { ...createVenusCoreReadPlan({ account, comptrollerAddress: comptroller, blockTag: String(atBlock) }), contracts: { ...contracts }, markets: marketAddresses },
    errorCode: String(errorCode),
    liquidityRaw: String(liquidityRaw),
    shortfallRaw: String(shortfallRaw),
    assetsIn,
    closeFactorMantissa: String(closeFactor),
    liquidationIncentiveMantissa: liquidationIncentive === null ? null : String(liquidationIncentive),
    marketSnapshots,
    authoritative: true,
  };
}

export function validateAuthoritativeVenusSnapshot(snapshot) {
  const errors = [];
  if (!snapshot || typeof snapshot !== "object") errors.push("snapshot_missing");
  if (snapshot?.protocol !== "Venus") errors.push("protocol_not_venus");
  if (snapshot?.source !== "onchain") errors.push("snapshot_not_onchain");
  if (Number(snapshot?.chainId) !== REFERENCE_CHAIN_ID) errors.push("snapshot_wrong_chain");
  if (snapshot?.authoritative !== true) errors.push("snapshot_not_marked_authoritative");
  if (snapshot?.poolType === "core" && (snapshot?.liquidityRaw === undefined || snapshot?.shortfallRaw === undefined)) errors.push("core_liquidity_fields_missing");
  if (snapshot?.healthFactor !== undefined && (typeof snapshot.healthFactor !== "number" || !Number.isFinite(snapshot.healthFactor))) errors.push("health_factor_not_numeric");
  return { valid: errors.length === 0, errors };
}

export function classifyVenusSnapshot(snapshot, { warningHealthFactor = null, criticalHealthFactor = null } = {}) {
  const validation = validateAuthoritativeVenusSnapshot(snapshot);
  if (!validation.valid) return { status: "UNAVAILABLE", validation, currentHealthFactor: null, liquidationProximity: "unknown" };
  const shortfallRaw = snapshot.shortfallRaw === undefined ? null : BigInt(snapshot.shortfallRaw);
  const currentHealthFactor = snapshot.healthFactor ?? null;
  let status = shortfallRaw !== null && shortfallRaw > 0n ? "LIQUIDATION_RISK" : "NO_SHORTFALL_OBSERVED";
  if (currentHealthFactor !== null && criticalHealthFactor !== null && currentHealthFactor <= criticalHealthFactor) status = "CRITICAL";
  else if (currentHealthFactor !== null && warningHealthFactor !== null && currentHealthFactor <= warningHealthFactor) status = "WARNING";
  return {
    status,
    validation,
    currentHealthFactor,
    liquidationProximity: currentHealthFactor === null ? "protocol_liquidity_fields_only" : "health_factor_from_authoritative_snapshot",
    liquidityRaw: snapshot.liquidityRaw ?? null,
    shortfallRaw: snapshot.shortfallRaw ?? null,
  };
}

export function compareVenusSnapshots(previous, current) {
  if (!previous || !current) return { status: "not_enough_data", changes: [] };
  const fields = ["healthFactor", "liquidityRaw", "shortfallRaw"];
  const changes = fields.flatMap((field) => {
    if (previous[field] === undefined || current[field] === undefined || String(previous[field]) === String(current[field])) return [];
    return [{ field, previous: previous[field], current: current[field] }];
  });
  return { status: "compared", changes };
}
