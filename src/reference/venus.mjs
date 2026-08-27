import { parseAbi } from "viem";
import { REFERENCE_CHAIN_ID } from "./constants.mjs";

export const VENUS_CORE_COMPTROLLER_ABI = parseAbi([
  "function getAccountLiquidity(address account) view returns (uint256, uint256, uint256)",
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
