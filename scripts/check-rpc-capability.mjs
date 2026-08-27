import { probeRpcCapability, rpcReadinessFailures, sdkRpcEnvironment, SDK_RPC_ENV_KEYS } from "../src/deploy/rpc-capability.mjs";
import { REFERENCE_NETWORK } from "../src/reference/constants.mjs";
import { nowIso } from "../src/core.mjs";

/**
 * Audit the RPC configuration every reference-agent ERC-8183 watcher depends on.
 * This is the check that would have caught the Verified Run #1 failure before a
 * single U was spent.
 */
const network = process.env.CANNED_NETWORK || REFERENCE_NETWORK;
const environment = sdkRpcEnvironment(process.env, network);
const capability = await probeRpcCapability({ rpcUrl: environment.effectiveRpcUrl });
const failures = rpcReadinessFailures({ environment, capability });

const report = {
  status: failures.length ? "rpc_configuration_failed" : "rpc_capability_verified",
  network,
  sdkEnvironmentKeys: SDK_RPC_ENV_KEYS,
  configuration: {
    perNetworkKey: environment.perNetworkKey,
    perNetworkConfigured: environment.perNetworkConfigured,
    genericRpcUrlConfigured: environment.genericConfigured,
    fallbacksConfigured: environment.fallbacksConfigured,
    usingSdkDefault: environment.usingSdkDefault,
    cannedRpcUrlSet: environment.cannedRpcUrlSet,
    ineffectiveCannedOverride: environment.ineffectiveCannedOverride,
    effectiveRpcUrl: environment.effectiveRpcUrl,
  },
  capability: { capable: capability.capable, checks: capability.checks, failures: capability.failures, reason: capability.reason, headBlock: capability.details.headBlock, observedChainId: capability.details.observedChainId, logSpanBlocks: capability.details.spanBlocks, logCount: capability.details.logCount ?? null },
  failures,
  guidance: environment.ineffectiveCannedOverride
    ? `CANNED_RPC_URL is set but the BNB SDK does not read it. Set ${environment.perNetworkKey} instead, or the watcher will silently fall back to the SDK default.`
    : failures.length
      ? `Set ${environment.perNetworkKey} to an endpoint that serves the eth_getLogs range ERC8183JobOps.verifyJob performs.`
      : "The configured RPC serves chain ID, head, and the verifyJob log range.",
  checkedAt: nowIso(),
  secretOutput: "none",
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(2);
