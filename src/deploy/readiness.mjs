import { isPublicHttpUrl, safeUrl } from "../core.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ERC8183_COMMERCE_PROXY, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../reference/constants.mjs";
import { rpcReadinessFailures } from "./rpc-capability.mjs";

/**
 * `expectedCategory` is required so a second reference agent cannot pass the
 * readiness gate of the first. Leaving it unset checks provenance only.
 */
export function publicReadinessFailures({ agentUrl, health, readiness, status, metadata, expectedCategory = null, rpc = null } = {}) {
  const failures = [];
  const parsed = safeUrl(agentUrl);
  if (!isPublicHttpUrl(agentUrl) || parsed?.protocol !== "https:" || !parsed?.pathname.endsWith("/erc8183")) failures.push("public_https_erc8183_url");
  if (health?.ok !== true || health.body?.chainId !== REFERENCE_CHAIN_ID || health.body?.endpointAlive !== true) failures.push("health_chain_or_liveness");
  if (!readiness?.ok || readiness.body?.network !== REFERENCE_NETWORK || readiness.body?.chainId !== REFERENCE_CHAIN_ID) failures.push("readiness_network");
  if (readiness.body?.endpoint?.transport !== "public_http" || readiness.body?.endpoint?.url !== agentUrl) failures.push("public_transport_or_endpoint");
  if (readiness.body?.worker?.alive !== true) failures.push("worker_not_alive");
  if (readiness.body?.watcher?.alive !== true) failures.push("watcher_not_alive");
  if (readiness.body?.storage?.public !== true || readiness.body?.storage?.localFilesystemPresentedAsEvidence !== false) failures.push("durable_public_storage");
  if (!status?.ok || status.body?.chainId !== REFERENCE_CHAIN_ID || String(status.body?.paymentToken || "").toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase()) failures.push("status_chain_or_payment_token");
  if (!metadata?.ok || metadata.body?.origin !== "CANNED_REFERENCE" || metadata.body?.chainId !== REFERENCE_CHAIN_ID) failures.push("metadata_provenance");
  if (expectedCategory && metadata.body?.category !== expectedCategory) failures.push("metadata_category_mismatch");
  if (metadata.body?.protocols?.[0]?.verifyingContract?.toLowerCase() !== REFERENCE_ERC8183_COMMERCE_PROXY.toLowerCase()) failures.push("metadata_commerce_address");
  if (metadata.body?.protocols?.[0]?.endpoint !== agentUrl) failures.push("metadata_endpoint");
  if (status.body?.provider && readiness.body?.providerAddress && status.body.provider.toLowerCase() !== readiness.body.providerAddress.toLowerCase()) failures.push("provider_status_readiness_mismatch");

  // A watcher that cannot read the logs verifyJob needs is not ready, however
  // healthy the HTTP surface looks. Verified Run #1 failed exactly this way.
  const reported = readiness.body?.rpc;
  if (reported && reported.capable === false) failures.push("rpc_cannot_serve_verify_job_log_span");
  if (reported && reported.usingSdkDefault === true) failures.push("sdk_rpc_override_not_set");
  if (rpc) failures.push(...rpcReadinessFailures(rpc));
  return [...new Set(failures)];
}

export function referenceIdentityBindingFailures({ identity, status, metadata, agentUrl, expectedCategory = null } = {}) {
  const failures = [];
  if (!identity || identity.agentId === null || identity.agentId === undefined) failures.push("identity_id_missing");
  if (!identity?.registry) failures.push("identity_registry_missing");
  if (!identity?.provider || !status?.provider || identity.provider.toLowerCase() !== status.provider.toLowerCase()) failures.push("identity_provider_mismatch");
  if (!identity?.endpoint || identity.endpoint !== agentUrl) failures.push("identity_endpoint_mismatch");
  if (metadata?.origin !== "CANNED_REFERENCE") failures.push("identity_metadata_mismatch");
  if (expectedCategory && metadata?.category !== expectedCategory) failures.push("identity_category_mismatch");
  return [...new Set(failures)];
}

/**
 * Two reference agents must never resolve to the same ERC-8004 identity, and a
 * reference agent must never be counted as third-party inventory.
 */
export function referenceFleetIdentityFailures(records = {}) {
  const failures = [];
  const entries = Object.entries(records).filter(([, record]) => record && record.agentId !== undefined && record.agentId !== null);
  const seenAgentIds = new Map();
  const seenEndpoints = new Map();
  for (const [key, record] of entries) {
    const agentKey = `${String(record.registry).toLowerCase()}:${record.agentId}`;
    if (seenAgentIds.has(agentKey)) failures.push(`shared_erc8004_identity:${seenAgentIds.get(agentKey)}+${key}`);
    else seenAgentIds.set(agentKey, key);
    if (record.endpoint) {
      if (seenEndpoints.has(record.endpoint)) failures.push(`shared_endpoint:${seenEndpoints.get(record.endpoint)}+${key}`);
      else seenEndpoints.set(record.endpoint, key);
    }
    if (record.origin && record.origin !== "CANNED_REFERENCE") failures.push(`not_marked_first_party:${key}`);
  }
  return [...new Set(failures)];
}
