import { REFERENCE_CHAIN_ID, REFERENCE_ERC8183_COMMERCE_PROXY, REFERENCE_NETWORK } from "../reference/constants.mjs";
import { safeError } from "../core.mjs";

/**
 * The BNB Agent SDK resolves its RPC from these variables and nothing else.
 * `CANNED_RPC_URL` is a Canned-side variable that never reaches the SDK, which
 * is exactly how Verified Run #1 ended up on the default data-seed endpoint.
 */
export const SDK_RPC_ENV_KEYS = Object.freeze({
  "bsc-testnet": "RPC_URL_BSC_TESTNET",
  "bsc-mainnet": "RPC_URL_BSC_MAINNET",
  generic: "RPC_URL",
  fallbacks: "BNBAGENT_FALLBACK_RPC_URLS",
});

export const SDK_DEFAULT_TESTNET_RPC = "https://data-seed-prebsc-2-s2.binance.org:8545";

/** The log query `ERC8183JobOps.verifyJob` performs before accepting a funded job. */
export const VERIFY_JOB_LOG_SPAN_BLOCKS = 1_500;

export function sdkRpcEnvironment(env = process.env, network = REFERENCE_NETWORK) {
  const perNetworkKey = SDK_RPC_ENV_KEYS[network] || SDK_RPC_ENV_KEYS.generic;
  const perNetwork = env[perNetworkKey] || null;
  const generic = env[SDK_RPC_ENV_KEYS.generic] || null;
  const effective = perNetwork || generic || SDK_DEFAULT_TESTNET_RPC;
  const usingSdkDefault = !perNetwork && !generic;
  return {
    network,
    perNetworkKey,
    perNetworkConfigured: Boolean(perNetwork),
    genericConfigured: Boolean(generic),
    fallbacksConfigured: Boolean(env[SDK_RPC_ENV_KEYS.fallbacks]),
    effectiveRpcUrl: effective,
    usingSdkDefault,
    cannedRpcUrlSet: Boolean(env.CANNED_RPC_URL),
    /** The exact misconfiguration that broke job 695: a Canned-side override that the SDK never reads. */
    ineffectiveCannedOverride: Boolean(env.CANNED_RPC_URL) && usingSdkDefault,
  };
}

/**
 * Prove the configured RPC can actually serve the queries the ERC-8183 watcher
 * depends on. `eth_chainId` alone is not evidence: the data-seed endpoint
 * answers it happily while rejecting the log range `verifyJob` needs.
 */
export async function probeRpcCapability({ rpcUrl, chainId = REFERENCE_CHAIN_ID, commerceAddress = REFERENCE_ERC8183_COMMERCE_PROXY, spanBlocks = VERIFY_JOB_LOG_SPAN_BLOCKS, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const checks = { reachable: false, chainIdMatches: false, headReadable: false, verifyJobLogSpan: false };
  const details = { rpcUrl, expectedChainId: chainId, spanBlocks, observedChainId: null, headBlock: null, logSpanError: null };
  const rpc = async (method, params) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
      const body = await response.json();
      if (body.error) throw new Error(body.error.message || "RPC error");
      return body.result;
    } finally { clearTimeout(timer); }
  };
  try {
    details.observedChainId = Number(await rpc("eth_chainId", []));
    checks.reachable = true;
    checks.chainIdMatches = details.observedChainId === chainId;
  } catch (error) {
    details.reachableError = safeError(error);
    return finish(checks, details);
  }
  try {
    const head = await rpc("eth_blockNumber", []);
    details.headBlock = Number(head);
    checks.headReadable = Number.isFinite(details.headBlock) && details.headBlock > 0;
  } catch (error) {
    details.headError = safeError(error);
    return finish(checks, details);
  }
  try {
    const fromBlock = `0x${Math.max(0, details.headBlock - spanBlocks).toString(16)}`;
    const logs = await rpc("eth_getLogs", [{ address: commerceAddress, fromBlock, toBlock: `0x${details.headBlock.toString(16)}` }]);
    checks.verifyJobLogSpan = Array.isArray(logs);
    details.logCount = Array.isArray(logs) ? logs.length : null;
  } catch (error) {
    details.logSpanError = safeError(error);
  }
  return finish(checks, details);
}

function finish(checks, details) {
  const failures = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
  return {
    checks,
    details,
    capable: failures.length === 0,
    failures,
    reason: failures.length === 0
      ? "The configured RPC answers chain ID, head, and the log range the ERC-8183 watcher requires."
      : failures.includes("verifyJobLogSpan")
        ? `The RPC cannot serve the ${details.spanBlocks}-block eth_getLogs range that ERC8183JobOps.verifyJob performs, so the funded-job watcher would reject every job while HTTP readiness still looked healthy.`
        : `The RPC failed: ${failures.join(", ")}.`,
  };
}

/**
 * Readiness failures caused by RPC configuration. These are deliberately fatal:
 * a service whose watcher cannot observe funded jobs is not ready, however
 * healthy its HTTP surface looks.
 */
export function rpcReadinessFailures({ environment, capability } = {}) {
  const failures = [];
  if (!environment) return ["rpc_environment_unknown"];
  if (environment.usingSdkDefault) failures.push("sdk_rpc_override_not_set");
  if (environment.ineffectiveCannedOverride) failures.push("canned_rpc_url_set_but_ignored_by_sdk");
  if (capability && capability.capable !== true) {
    if (!capability.checks.reachable) failures.push("rpc_unreachable");
    else if (!capability.checks.chainIdMatches) failures.push("rpc_wrong_chain");
    else if (!capability.checks.headReadable) failures.push("rpc_head_unreadable");
    else if (!capability.checks.verifyJobLogSpan) failures.push("rpc_cannot_serve_verify_job_log_span");
  }
  return [...new Set(failures)];
}
