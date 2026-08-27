import { Eight004ScanAdapter } from "./8004scan.mjs";

/**
 * Robust indexer lookup for any agent ID.
 *
 * The earlier verifier scanned only `getAllAgents(100, 0)` and therefore
 * reported a high token ID as unindexed simply because it was not on page one.
 * Direct lookup is tried first; paginated scanning is a fallback that actually
 * paginates rather than reading a single page.
 */
export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_MAX_PAGES = 25;

export async function lookupIndexedAgent({ chainId = 97, agentId, adapter = new Eight004ScanAdapter(), maxPages = DEFAULT_MAX_PAGES, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  if (agentId === null || agentId === undefined) throw new Error("An agent ID is required for an indexer lookup.");
  const wanted = String(agentId);

  const direct = await adapter.detail(chainId, wanted).catch((error) => ({ ok: false, status: null, error: String(error?.message || error) }));
  if (direct.ok && direct.body && String(direct.body.token_id ?? "") === wanted && Number(direct.body.chain_id) === Number(chainId)) {
    return {
      indexed: true,
      method: "direct_lookup",
      pagesScanned: 0,
      record: { canonicalAgentId: direct.body.agent_id ?? null, tokenId: String(direct.body.token_id), chainId: Number(direct.body.chain_id), name: direct.body.name ?? null, ownerAddress: direct.body.owner_address ?? null, contractAddress: direct.body.contract_address ?? null, isTestnet: direct.body.is_testnet ?? null },
      httpStatus: direct.status ?? null,
    };
  }

  // Fallback: page through the listing rather than trusting the first page.
  let pagesScanned = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await adapter.get("/agents", { chain_id: chainId, limit: pageSize, offset: page * pageSize }).catch(() => null);
    pagesScanned += 1;
    const items = response?.body?.items || response?.body?.agents || response?.body?.data || (Array.isArray(response?.body) ? response.body : []);
    if (!Array.isArray(items) || items.length === 0) break;
    const hit = items.find((item) => String(item?.token_id ?? item?.agentId ?? item?.id ?? "") === wanted);
    if (hit) {
      return {
        indexed: true,
        method: "paginated_scan",
        pagesScanned,
        record: { canonicalAgentId: hit.agent_id ?? null, tokenId: wanted, chainId: Number(hit.chain_id ?? chainId), name: hit.name ?? null, ownerAddress: hit.owner_address ?? null, contractAddress: hit.contract_address ?? null, isTestnet: hit.is_testnet ?? null },
        httpStatus: response?.status ?? null,
      };
    }
    if (items.length < pageSize) break;
  }
  return { indexed: false, method: direct.ok === false && direct.status ? "direct_lookup_miss_then_paginated_scan" : "paginated_scan", pagesScanned, record: null, httpStatus: direct.status ?? null, reason: "The agent was not returned by direct lookup or by a paginated scan of the indexer." };
}

/** Owner reported by the indexer must match the provider Canned verified onchain. */
export function indexerOwnerMatches({ lookup, expectedOwner }) {
  if (!lookup?.indexed || !lookup.record?.ownerAddress || !expectedOwner) return null;
  return String(lookup.record.ownerAddress).toLowerCase() === String(expectedOwner).toLowerCase();
}
