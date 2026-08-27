import { contentHashes, isObject, isPublicHttpUrl, nowIso, requestJson, safeError } from "../core.mjs";
import { CATEGORIES, CATEGORY_LABELS } from "../domain.mjs";

export const EIGHT004SCAN_BASE = "https://api.8004scan.io/api/v1";

export const CATEGORY_QUERIES = Object.freeze({
  [CATEGORIES.REBALANCING]: "DeFi liquidity position range rebalancing agent",
  [CATEGORIES.GRID_TRADING]: "grid trading automated ladder agent",
  [CATEGORIES.YIELD_OPTIMISATION]: "stablecoin yield optimisation routing agent",
  [CATEGORIES.HEALTH_FACTOR_MONITORING]: "lending health factor monitoring protection agent",
});

// Keep discovery focused on BNB-relevant work instead of attempting to index the
// entire registry. The first entry in each list remains CATEGORY_QUERIES for
// callers that need a canonical label; the variants widen recall for inventory.
export const CATEGORY_QUERY_VARIANTS = Object.freeze({
  [CATEGORIES.REBALANCING]: Object.freeze([
    CATEGORY_QUERIES[CATEGORIES.REBALANCING],
    "PancakeSwap LP position range manager agent",
    "concentrated liquidity range management agent",
  ]),
  [CATEGORIES.GRID_TRADING]: Object.freeze([
    CATEGORY_QUERIES[CATEGORIES.GRID_TRADING],
    "automated trading grid orders agent",
    "market making spread capture ladder agent",
  ]),
  [CATEGORIES.YIELD_OPTIMISATION]: Object.freeze([
    CATEGORY_QUERIES[CATEGORIES.YIELD_OPTIMISATION],
    "DeFi yield aggregator APY routing agent",
    "Venus Lista stablecoin yield agent",
  ]),
  [CATEGORIES.HEALTH_FACTOR_MONITORING]: Object.freeze([
    CATEGORY_QUERIES[CATEGORIES.HEALTH_FACTOR_MONITORING],
    "Venus lending health factor liquidation protection agent",
    "borrow collateral monitoring alert agent",
  ]),
});

const CATEGORY_SIGNALS = Object.freeze({
  [CATEGORIES.REBALANCING]: [
    ["rebalance", "rebalances", "rebalancing"], ["liquidity", "lp", "range"], ["pancakeswap", "uniswap", "position"],
  ],
  [CATEGORIES.GRID_TRADING]: [["grid", "ladder", "rungs"], ["trading", "trade", "orders"], ["inventory skew", "spread capture", "requote"]],
  [CATEGORIES.YIELD_OPTIMISATION]: [["yield", "apr", "apy"], ["optimisation", "optimization", "route", "routing"], ["stablecoin", "lending", "venus", "pool"]],
  [CATEGORIES.HEALTH_FACTOR_MONITORING]: [["health factor", "health-factor"], ["lending", "borrow", "collateral", "liquidation"], ["monitor", "protect", "withdraw", "alert"]],
});

function textSignals(detail) {
  const offchain = detail?.raw_metadata?.offchain_content;
  const services = [detail?.services, detail?.endpoints, offchain?.services, offchain?.endpoints];
  return JSON.stringify({
    description: detail?.description,
    tags: detail?.tags,
    categories: detail?.categories,
    supportedProtocols: detail?.supported_protocols,
    services,
  }).toLowerCase();
}

export function classifyCategories(detail) {
  const text = textSignals(detail);
  return Object.entries(CATEGORY_SIGNALS).map(([category, groups]) => {
    const signals = groups.flatMap((group) => group.filter((term) => text.includes(term)));
    const uniqueSignals = [...new Set(signals)];
    const score = uniqueSignals.length;
    return {
      category,
      label: CATEGORY_LABELS[category],
      score,
      signals: uniqueSignals,
      confidence: score >= 4 ? "high" : score >= 2 ? "medium" : "low",
      justifiedBy: "description, tags/categories, protocol metadata, and service metadata; name alone is not used",
    };
  }).filter((item) => item.score >= 2).sort((a, b) => b.score - a.score);
}

function serviceEntries(value, fallbackType) {
  if (Array.isArray(value)) return value.map((item) => ({ ...item, type: item.type || item.name || fallbackType }));
  if (isObject(value)) return Object.entries(value).map(([key, item]) => ({ ...(isObject(item) ? item : { endpoint: item }), type: item?.type || item?.name || key || fallbackType }));
  return [];
}

export function extractServices(detail) {
  const offchain = detail?.raw_metadata?.offchain_content || {};
  const values = [
    ...serviceEntries(detail?.services, "service"),
    ...serviceEntries(detail?.endpoints, "endpoint"),
    ...serviceEntries(offchain.services, "service"),
    ...serviceEntries(offchain.endpoints, "endpoint"),
  ];
  if (detail?.a2a_endpoint) values.push({ type: "A2A", endpoint: detail.a2a_endpoint, version: detail.a2a_version });
  if (detail?.mcp_server) values.push({ type: "MCP", endpoint: detail.mcp_server, version: detail.mcp_version });
  if (detail?.agent_url) values.push({ type: "agent_url", endpoint: detail.agent_url });
  const seen = new Set();
  return values.map((service) => ({
    type: String(service.type || "unknown"),
    name: service.name || null,
    endpoint: service.endpoint || service.url || service.uri || null,
    version: service.version || null,
    description: service.description || null,
  })).filter((service) => {
    const key = service.endpoint;
    if (!service.endpoint || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function supportsFrom(detail, services, cards) {
  const text = JSON.stringify({ detail, services, cards }).toLowerCase();
  return {
    a2a: text.includes("a2a") || services.some((service) => /a2a/i.test(service.type)),
    mcp: text.includes("mcp") || services.some((service) => /mcp/i.test(service.type)),
    erc8183: text.includes("erc-8183") || text.includes("erc8183") || text.includes("notify_funded") || text.includes("notify-funded"),
    x402: detail?.x402_supported === true || text.includes("x402"),
    b402: detail?.b402_supported === true || text.includes("b402"),
    httpTaskApi: services.some((service) => /http|rest|api|task/i.test(`${service.type} ${service.description || ""}`)),
  };
}

export class Eight004ScanAdapter {
  constructor({ baseUrl = EIGHT004SCAN_BASE, apiKey = process.env.CANNED_8004SCAN_API_KEY, timeoutMs = 12_000, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async get(path, params = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return requestJson(url.toString(), {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      headers: this.apiKey ? { "X-API-Key": this.apiKey } : {},
    });
  }

  async search(query, { chainId = 97, limit = 3 } = {}) {
    const response = await this.get("/agents/search/semantic", { q: query, chain_id: chainId, limit, offset: 0 });
    const items = response.body?.items || response.body?.agents || response.body?.data?.items || [];
    return { response, items: Array.isArray(items) ? items : [] };
  }

  async detail(chainId, tokenId) {
    return this.get(`/agents/${chainId}/${encodeURIComponent(tokenId)}`);
  }

  async probeService(service) {
    const observedAt = nowIso();
    if (!isPublicHttpUrl(service.endpoint)) {
      return { ...service, observedAt, status: "blocked_private_or_local", reachable: false, callable: false, elapsedMs: 0, reason: "Private or local endpoints are not probed by the discovery service." };
    }
    const response = await requestJson(service.endpoint, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      headers: { "User-Agent": "canned-inventory/0.1" },
    });
    const skills = Array.isArray(response.body?.skills) ? response.body.skills : [];
    const text = `${response.rawText} ${JSON.stringify(response.body || {})}`.toLowerCase();
    const callable = response.ok && (skills.some((skill) => /negotiate|notify.?funded|execute|trade|yield|health/i.test(JSON.stringify(skill))) || /message\/send|erc.?8183|notify.?funded|negotiate/.test(text));
    return {
      ...service,
      observedAt,
      status: response.ok ? (callable ? "reachable_callable_candidate" : "reachable_not_callable_proof") : "unreachable",
      reachable: response.ok,
      callable,
      httpStatus: response.status,
      elapsedMs: response.elapsedMs,
      reason: response.ok ? callable ? "Response exposes an agent card or protocol/task signal." : "HTTP response was reachable but did not prove a callable task surface." : response.error || `HTTP ${response.status}`,
      responseHash: contentHashes(response.rawText).sha256,
      card: response.body?.skills ? response.body : undefined,
    };
  }

  async discover({ chainId = 97, perQuery = 3, maxDeep = 12, evidenceStore } = {}) {
    const observedAt = nowIso();
    const queryResults = [];
    const candidates = new Map();
    const addCandidate = (item, source) => {
      const key = item.agent_id || `${item.chain_id}:${item.token_id}`;
      const existing = candidates.get(key) || { listItem: item, foundBy: [] };
      if (!existing.foundBy.includes(source)) existing.foundBy.push(source);
      candidates.set(key, existing);
    };
    const latest = await this.get("/agents", { chain_id: chainId, is_testnet: true, is_registered: "true", limit: 10, offset: 0 });
    const latestItems = latest.body?.items || latest.body?.agents || latest.body?.data?.items || [];
    queryResults.push({ category: "latest_bsc_testnet", query: null, requestPath: "/agents", responseStatus: latest.status, responseHash: contentHashes(latest.rawText).sha256, itemsReturned: Array.isArray(latestItems) ? latestItems.length : 0 });
    for (const item of Array.isArray(latestItems) ? latestItems : []) addCandidate(item, "latest_bsc_testnet");
    for (const [category, queries] of Object.entries(CATEGORY_QUERY_VARIANTS)) {
      for (const query of queries) {
        const result = await this.search(query, { chainId, limit: perQuery });
        queryResults.push({ category, query, requestPath: "/agents/search/semantic", responseStatus: result.response.status, responseHash: contentHashes(result.response.rawText).sha256, itemsReturned: result.items.length });
        for (const item of result.items) addCandidate(item, category);
      }
    }
    const selected = [...candidates.values()].slice(0, maxDeep);
    const normalized = [];
    for (const entry of selected) {
      const detailResponse = await this.detail(chainId, entry.listItem.token_id);
      if (!detailResponse.ok || !detailResponse.body) {
        normalized.push({
          identity: entry.listItem.agent_id,
          chainId,
          tokenId: String(entry.listItem.token_id),
          name: entry.listItem.name || null,
          categoryHypotheses: [],
          services: [],
          probes: [],
          rejectedReasons: [`detail_unavailable:${detailResponse.error || `HTTP ${detailResponse.status}`}`],
          source: { detailUrl: `${this.baseUrl}/agents/${chainId}/${entry.listItem.token_id}`, observedAt, detailResponseHash: contentHashes(detailResponse.rawText).sha256 },
        });
        continue;
      }
      const detail = detailResponse.body;
      const services = extractServices(detail);
      const probes = [];
      for (const service of services.slice(0, 3)) probes.push(await this.probeService(service));
      const cards = probes.filter((probe) => probe.card).map((probe) => probe.card);
      const categoryHypotheses = classifyCategories(detail);
      const supports = supportsFrom(detail, services, cards);
      const liveServices = probes.filter((probe) => probe.reachable);
      const callableServices = probes.filter((probe) => probe.callable);
      const gate = {
        identityOnBsc: detail.chain_id === chainId && detail.is_testnet === true,
        liveService: liveServices.length > 0,
        genuinelyCallable: callableServices.length > 0,
        categoryFit: categoryHypotheses.length > 0,
        safeBoundedExecution: supports.erc8183 && Boolean(detail.agent_wallet || detail.owner_address) && callableServices.length > 0,
        benchmarkable: "pending_real_run",
        controlAvailable: categoryHypotheses.length > 0,
        allGatesPassed: false,
      };
      const rejectedReasons = [];
      if (!gate.identityOnBsc) rejectedReasons.push("not_bsc_testnet_identity");
      if (!gate.liveService) rejectedReasons.push("no_reachable_service");
      if (!gate.genuinelyCallable) rejectedReasons.push("reachable_service_did_not_prove_callable_task");
      if (!gate.categoryFit) rejectedReasons.push("no_category_fit_from_metadata");
      if (!gate.safeBoundedExecution) rejectedReasons.push("no_proven_erc8183_bounded_hire_surface");
      let sourceEvidence;
      if (evidenceStore) {
        sourceEvidence = await evidenceStore.saveEvidence({ source: "8004scan", observedAt, detailUrl: `${this.baseUrl}/agents/${chainId}/${entry.listItem.token_id}`, rawDetail: detail, services, probes });
      }
      normalized.push({
        identity: detail.agent_id,
        chainId: detail.chain_id,
        network: detail.is_testnet ? "bsc-testnet" : "bsc-mainnet",
        registry: detail.contract_address,
        tokenId: String(detail.token_id),
        ownerAddress: detail.owner_address || null,
        agentWallet: detail.agent_wallet || null,
        name: detail.name || null,
        description: detail.description || null,
        active: detail.is_active === true,
        categoryHypotheses,
        services,
        probes,
        supports,
        hiring: {
          mechanism: supports.erc8183 && supports.a2a ? "A2A negotiation + ERC-8183 buyer job" : supports.x402 ? "x402 if live capability is independently verified" : "undetermined",
          price: null,
          currency: null,
        },
        selectionGate: gate,
        rejectedReasons,
        foundBy: entry.foundBy,
        source: {
          listQueries: entry.foundBy,
          detailUrl: `${this.baseUrl}/agents/${chainId}/${detail.token_id}`,
          createdTxHash: detail.created_tx_hash || null,
          offchainUri: detail.raw_metadata?.offchain_uri || null,
          observedAt,
          detailResponseHash: contentHashes(detailResponse.rawText).sha256,
          rawEvidence: sourceEvidence || null,
        },
      });
    }
    const report = {
      schemaVersion: 1,
      kind: "verified_candidate_inventory",
      observedAt,
      source: "8004scan_official_api",
      apiBase: this.baseUrl,
      network: "bsc-testnet",
      queries: queryResults,
      searchedCount: queryResults.reduce((sum, query) => sum + query.itemsReturned, 0),
      deeplyExaminedCount: normalized.length,
      reachableServiceCount: normalized.filter((candidate) => candidate.probes.some((probe) => probe.reachable)).length,
      callableCandidateCount: normalized.filter((candidate) => candidate.probes.some((probe) => probe.callable)).length,
      candidates: normalized,
      categorySummary: Object.fromEntries(Object.entries(CATEGORY_QUERIES).map(([category]) => [category, {
        label: CATEGORY_LABELS[category],
        candidates: normalized.filter((candidate) => candidate.categoryHypotheses.some((hypothesis) => hypothesis.category === category)).length,
        reachable: normalized.filter((candidate) => candidate.categoryHypotheses.some((hypothesis) => hypothesis.category === category) && candidate.probes.some((probe) => probe.reachable)).length,
      }])),
      notes: [
        "A candidate is not marketplace-qualified until a real bounded hire and benchmark run are persisted.",
        "Reachable metadata-only endpoints remain excluded from callable counts.",
        "Raw source responses are content-addressed locally when an evidence store is supplied.",
      ],
    };
    return report;
  }
}

export function candidateByIdentity(report, identity) {
  return report.candidates.find((candidate) => candidate.identity === identity) || null;
}

export function summarizeCandidate(candidate) {
  return {
    identity: candidate.identity,
    name: candidate.name,
    categories: candidate.categoryHypotheses.map((item) => item.category),
    reachable: candidate.probes.filter((probe) => probe.reachable).length,
    callable: candidate.probes.filter((probe) => probe.callable).length,
    mechanism: candidate.hiring.mechanism,
    rejectedReasons: candidate.rejectedReasons,
  };
}
