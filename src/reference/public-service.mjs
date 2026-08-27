import { isPublicHttpUrl, safeUrl } from "../core.mjs";
import { CATEGORY_LABELS } from "../domain.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ERC8183_COMMERCE_PROXY, REFERENCE_NETWORK, REFERENCE_ORIGIN, REFERENCE_PAYMENT_TOKEN, referenceSpec } from "./constants.mjs";

export const REFERENCE_SERVICE_VERSION = "health-guard-service-v1";

export function validatePublicReferenceConfig({ agentUrl, storageApiKey = process.env.STORAGE_API_KEY, chainId = REFERENCE_CHAIN_ID, network = REFERENCE_NETWORK } = {}) {
  const errors = [];
  if (network !== REFERENCE_NETWORK) errors.push("network_must_be_bsc_testnet");
  if (Number(chainId) !== REFERENCE_CHAIN_ID) errors.push("chain_id_must_be_97");
  if (!isPublicHttpUrl(agentUrl)) errors.push("agent_url_must_be_public_http_or_https");
  if (safeUrl(agentUrl)?.protocol !== "https:") errors.push("agent_url_must_use_https");
  if (!safeUrl(agentUrl)?.pathname.endsWith("/erc8183")) errors.push("agent_url_must_end_in_erc8183");
  if (!storageApiKey) errors.push("ipfs_storage_api_key_required");
  return { valid: errors.length === 0, errors };
}

export function publicHealthGuardMetadata(options = {}) {
  return publicReferenceMetadata({ ...options, referenceKey: "health-factor" });
}

export function publicReferenceMetadata({ agentUrl, providerAddress, agentId = null, registry = null, referenceKey = "health-factor" } = {}) {
  const spec = referenceSpec(referenceKey);
  if (!spec) throw new Error(`Unknown reference agent key: ${referenceKey}`);
  return {
    schemaVersion: 1,
    name: spec.name,
    description: spec.description,
    category: CATEGORY_LABELS[spec.category] || spec.category,
    referenceKey: spec.key,
    venue: spec.venue || null,
    capabilities: [...spec.capabilities],
    executionPolicy: spec.executionPolicy,
    origin: REFERENCE_ORIGIN,
    provider: providerAddress || null,
    network: REFERENCE_NETWORK,
    chainId: REFERENCE_CHAIN_ID,
    version: spec.serviceVersion || REFERENCE_SERVICE_VERSION,
    identity: agentId === null ? null : { agentId, registry, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID },
    protocols: [{ name: "ERC-8183", endpoint: agentUrl, verifyingContract: REFERENCE_ERC8183_COMMERCE_PROXY, servicePriceRaw: spec.priceRaw, currency: REFERENCE_PAYMENT_TOKEN, quote: "signed_provider_quote", delivery: "provider_storage" }],
    endpoints: {
      health: `${agentUrl}/health`,
      readiness: `${agentUrl}/readiness`,
      status: `${agentUrl}/status`,
      negotiate: `${agentUrl}/negotiate`,
      job: `${agentUrl}/job/{jobId}`,
      response: `${agentUrl}/job/{jobId}/response`,
    },
  };
}

export function publicReadinessSummary({ runtime, providerAddress, agentUrl, storageMode, fulfillmentEnabled = false, metadata = null, rpc = null } = {}) {
  const health = runtime.health();
  const readiness = runtime.readiness();
  return {
    ok: health.ok === true && readiness.endpoint?.alive === true,
    origin: REFERENCE_ORIGIN,
    identity: runtime.spec.identity,
    providerAddress,
    network: REFERENCE_NETWORK,
    chainId: REFERENCE_CHAIN_ID,
    endpoint: { url: agentUrl, alive: true, transport: "public_http" },
    worker: { ...readiness.worker, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, providerAddress },
    watcher: { ...(readiness.watcher || { alive: false, status: "not_started" }), network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, providerAddress },
    storage: { mode: storageMode, public: storageMode === "ipfs", localFilesystemPresentedAsEvidence: false },
    fulfillment: { enabled: fulfillmentEnabled, paidRunExecuted: false },
    version: metadata?.version || REFERENCE_SERVICE_VERSION,
    // Published so a buyer can see whether the funded-job watcher can actually
    // read the chain, rather than inferring it from a healthy HTTP response.
    rpc: rpc ? {
      capable: rpc.capable === true,
      usingSdkDefault: rpc.environment?.usingSdkDefault === true,
      configuredVia: rpc.environment?.perNetworkConfigured ? rpc.environment.perNetworkKey : rpc.environment?.genericConfigured ? "RPC_URL" : "sdk_default",
      verifyJobLogSpanServed: rpc.checks?.verifyJobLogSpan === true,
      checkedAt: rpc.checkedAt || null,
      reason: rpc.reason || null,
    } : null,
    metadata: metadata ? { name: metadata.name, category: metadata.category, identity: metadata.identity, venue: metadata.venue || null, referenceKey: metadata.referenceKey || null } : null,
  };
}
