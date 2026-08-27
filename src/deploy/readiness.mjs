import { isPublicHttpUrl, safeUrl } from "../core.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ERC8183_COMMERCE_PROXY, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../reference/constants.mjs";

export function publicReadinessFailures({ agentUrl, health, readiness, status, metadata } = {}) {
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
  if (!metadata?.ok || metadata.body?.origin !== "CANNED_REFERENCE" || metadata.body?.chainId !== REFERENCE_CHAIN_ID || metadata.body?.category !== "Health Factor Monitoring") failures.push("metadata_provenance");
  if (metadata.body?.protocols?.[0]?.verifyingContract?.toLowerCase() !== REFERENCE_ERC8183_COMMERCE_PROXY.toLowerCase()) failures.push("metadata_commerce_address");
  if (metadata.body?.protocols?.[0]?.endpoint !== agentUrl) failures.push("metadata_endpoint");
  if (status.body?.provider && readiness.body?.providerAddress && status.body.provider.toLowerCase() !== readiness.body.providerAddress.toLowerCase()) failures.push("provider_status_readiness_mismatch");
  return [...new Set(failures)];
}

export function referenceIdentityBindingFailures({ identity, status, metadata, agentUrl } = {}) {
  const failures = [];
  if (!identity || identity.agentId === null || identity.agentId === undefined) failures.push("identity_id_missing");
  if (!identity?.registry) failures.push("identity_registry_missing");
  if (!identity?.provider || !status?.provider || identity.provider.toLowerCase() !== status.provider.toLowerCase()) failures.push("identity_provider_mismatch");
  if (!identity?.endpoint || identity.endpoint !== agentUrl) failures.push("identity_endpoint_mismatch");
  if (metadata?.origin !== "CANNED_REFERENCE" || metadata?.category !== "Health Factor Monitoring") failures.push("identity_metadata_mismatch");
  return [...new Set(failures)];
}
