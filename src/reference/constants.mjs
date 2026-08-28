import { CATEGORIES } from "../domain.mjs";

export const REFERENCE_ORIGIN = "CANNED_REFERENCE";
export const REFERENCE_NETWORK = "bsc-testnet";
export const REFERENCE_CHAIN_ID = 97;
export const REFERENCE_PAYMENT_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
export const REFERENCE_PAYMENT_DECIMALS = 18;
export const REFERENCE_ERC8183_COMMERCE_PROXY = "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE";
export const VENUS_TESTNET_CORE = Object.freeze({
  comptroller: "0x94d1820b2D1c7c7452A163983Dc888CEC546b77D",
  oracle: "0x3cD69251D04A28d887Ac14cbe2E14c52F3D57823",
  vBNB: "0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c",
  vUSDT: "0xb7526572FFE56AB9D7489838Bf2E18e3323b441A",
  usdt: "0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c",
  poolRegistry: "0xC85491616Fa949E048F3aAc39fbf5b0703800667",
  source: "https://raw.githubusercontent.com/VenusProtocol/venus-protocol-documentation/main/deployed-contracts/markets.md",
});

const baseService = (endpoint, description, { implemented = false } = {}) => ({
  type: "HTTP task API",
  endpoint,
  description,
  advertised: true,
  cannedVerified: implemented,
  successfullyUsed: false,
  status: implemented ? "local_endpoint_verified" : "planned",
});

export const REFERENCE_AGENT_SPECS = Object.freeze([
  {
    key: "health-factor",
    identity: "CANNED_REFERENCE_HEALTH_FACTOR_V1",
    name: "Canned Health Guard",
    category: CATEGORIES.HEALTH_FACTOR_MONITORING,
    description: "Reads an authoritative Venus position snapshot, explains liquidation proximity and changes, and returns a bounded recommendation.",
    problem: "Watch this lending position. Tell me how close I am to liquidation, what changed, and what bounded action would restore my safety margin.",
    endpointPath: "/api/reference/health-factor",
    implemented: true,
    serviceVersion: "health-guard-service-v1",
    protocols: ["ERC-8183"],
    priceRaw: "1000000000000000",
    capabilities: ["venus_authoritative_position_read", "liquidation_proximity_assessment", "change_explanation", "bounded_recommendation"],
    executionPolicy: { readOnlyByDefault: true, capitalMovement: false, automaticIntervention: false },
  },
  {
    key: "yield",
    identity: "CANNED_REFERENCE_YIELD_V1",
    name: "Canned Yield Scout",
    category: CATEGORIES.YIELD_OPTIMISATION,
    description: "Planned reference module for comparing executable BNB-chain yield routes under declared risk and spend limits.",
    problem: "Compare the available yield routes for this capital, show the assumptions, and recommend only a bounded next step.",
    endpointPath: "/api/reference/yield",
    implemented: false,
    protocols: ["ERC-8183"],
    priceRaw: "1000000000000000",
    capabilities: ["route_comparison", "risk_disclosure", "bounded_recommendation"],
    executionPolicy: { readOnlyByDefault: true, capitalMovement: false, automaticIntervention: false },
  },
  {
    key: "rebalancing",
    identity: "CANNED_REFERENCE_REBALANCING_V1",
    name: "Canned Range Keeper",
    category: CATEGORIES.REBALANCING,
    description: "Reads an authoritative PancakeSwap V3 pool and position, reports whether the range is still active and how close price is to an edge, and recommends holding or a bounded replacement range.",
    problem: "My PancakeSwap liquidity is sitting in this range. Is it still healthy, is price drifting toward an edge, and should I leave it alone or rebalance?",
    endpointPath: "/api/reference/rebalancing",
    implemented: true,
    serviceVersion: "range-keeper-service-v1",
    venue: "PancakeSwap",
    protocols: ["ERC-8183"],
    priceRaw: "1000000000000000",
    capabilities: [
      "pancakeswap_v3_authoritative_pool_read",
      "concentrated_liquidity_range_classification",
      "range_edge_proximity",
      "oracle_drift_observation",
      "rebalance_justification",
      "bounded_range_proposal",
    ],
    executionPolicy: { readOnlyByDefault: true, capitalMovement: false, automaticIntervention: false },
  },
  {
    key: "grid",
    identity: "CANNED_REFERENCE_GRID_V1",
    name: "Canned Grid Keeper",
    category: CATEGORIES.GRID_TRADING,
    description: "Planned reference module for a fixed, bounded grid strategy with explicit inventory and execution limits.",
    problem: "Operate this declared grid within its inventory and price-impact limits, then show every fill and cost.",
    endpointPath: "/api/reference/grid",
    implemented: false,
    protocols: ["ERC-8183"],
    priceRaw: "1000000000000000",
    capabilities: ["fixed_grid", "inventory_limits", "bounded_execution"],
    executionPolicy: { readOnlyByDefault: false, capitalMovement: true, automaticIntervention: false },
  },
]);

export function referenceSpec(key) {
  return REFERENCE_AGENT_SPECS.find((spec) => spec.key === key) || null;
}

/**
 * Hire readiness for a reference agent is derived, never asserted. Every
 * condition is something the caller has separately observed: an onchain
 * identity, a configured provider, verified public readiness, a verified fresh
 * quote, and a sealed human baseline so the agent can never answer first.
 */
function hireReadiness({ registered, configured, publicReadinessVerified, quoteVerified, baselineSealed }) {
  const conditions = { identityRegistered: Boolean(registered), providerConfigured: Boolean(configured), publicReadinessVerified: Boolean(publicReadinessVerified), quoteVerified: Boolean(quoteVerified), humanBaselineSealed: Boolean(baselineSealed) };
  const unmet = Object.entries(conditions).filter(([, value]) => !value).map(([key]) => key);
  return {
    ready: unmet.length === 0,
    quoteVerified: conditions.quoteVerified,
    protocolCompatibility: true,
    providerConfigured: conditions.providerConfigured,
    conditions,
    reason: unmet.length === 0
      ? "Identity, provider, public readiness, and a verified fresh quote are all observed, and the human baseline is sealed."
      : `Hire is blocked until these are observed: ${unmet.join(", ")}.`,
  };
}

export function referenceAgentCandidate(spec, { providerAddress = null, endpointBase = "http://127.0.0.1:8787", identityRecord = null, allowLocalProbe = true, publicReadinessVerified = Boolean(identityRecord?.publicReadinessVerified), baselineSealed = false } = {}) {
  if (!spec) throw new Error("A reference-agent spec is required.");
  const endpoint = identityRecord?.endpoint || `${endpointBase}${spec.endpointPath}`;
  const configured = Boolean(providerAddress);
  const registered = Number.isInteger(Number(identityRecord?.agentId)) && Boolean(identityRecord?.registry);
  const endpointVerified = spec.implemented && (allowLocalProbe || publicReadinessVerified);
  const identity = registered ? `${REFERENCE_CHAIN_ID}:${String(identityRecord.registry).toLowerCase()}:${identityRecord.agentId}` : spec.identity;
  return {
    identity,
    name: spec.name,
    description: spec.description,
    network: REFERENCE_NETWORK,
    chainId: REFERENCE_CHAIN_ID,
    ownerAddress: providerAddress,
    agentWallet: providerAddress,
    origin: REFERENCE_ORIGIN,
    reference: true,
    referenceKey: spec.key,
    erc8004: registered ? { status: "onchain_registered", tokenId: Number(identityRecord.agentId), registry: identityRecord.registry, transactionHash: identityRecord.transactionHash, agentUri: identityRecord.agentUri, indexed: identityRecord.indexer === "indexed" } : { status: "not_registered", tokenId: null, registrationRequired: true },
    venue: spec.venue || null,
    categoryHypotheses: [{ category: spec.category, confidence: "high", signals: ["Canned Reference Agent specification", ...spec.capabilities] }],
    services: [baseService(endpoint, spec.problem, { implemented: endpointVerified })],
    probes: endpointVerified ? [{ type: "HTTP task API", endpoint, reachable: true, callable: true, observedAt: new Date().toISOString(), origin: REFERENCE_ORIGIN, scope: publicReadinessVerified ? "public" : "local_development" }] : [],
    supports: { a2a: false, erc8183: true, x402: false, b402: false, mcp: false, httpTaskApi: endpointVerified },
    selectionGate: { readiness: hireReadiness({ registered, configured, publicReadinessVerified, quoteVerified: Boolean(identityRecord?.quoteVerified), baselineSealed }) },
    hiring: { price: spec.priceRaw, currency: REFERENCE_PAYMENT_TOKEN, mechanism: "ERC-8183 funded seller job", quoteVerified: Boolean(identityRecord?.quoteVerified), negotiationProbe: identityRecord?.negotiationProbe || null },
    referenceFleet: { origin: REFERENCE_ORIGIN, fleetVersion: "1.0.0", implementationStatus: spec.implemented ? "implemented" : "planned", executionPolicy: spec.executionPolicy },
  };
}

/**
 * `identityRecords` is keyed by reference-agent key, so each implemented agent
 * resolves its own ERC-8004 identity, endpoint, and readiness. Passing a single
 * record would make two distinct agents share one identity.
 */
export function implementedReferenceAgentCandidates({ identityRecords = {}, baselineSealedByKey = {}, ...options } = {}) {
  return REFERENCE_AGENT_SPECS.filter((spec) => spec.implemented).map((spec) => referenceAgentCandidate(spec, {
    ...options,
    identityRecord: identityRecords[spec.key] ?? null,
    providerAddress: identityRecords[spec.key]?.provider ?? options.providerAddress ?? null,
    publicReadinessVerified: identityRecords[spec.key]?.publicReadinessVerified === true,
    baselineSealed: baselineSealedByKey[spec.key] === true,
  }));
}

export const REFERENCE_IDENTITY_FILES = Object.freeze({
  "health-factor": "state/reference-health-identity.json",
  rebalancing: "state/reference-range-identity.json",
});

/** Each reference agent signs with its own keystore; none of them are shared. */
export const REFERENCE_WALLET_PATHS = Object.freeze({
  "health-factor": { walletsDir: "reference-provider-wallets", passwordFile: "reference-provider-wallet-password.txt", passwordEnv: "CANNED_REFERENCE_PROVIDER_PASSWORD" },
  rebalancing: { walletsDir: "range-provider-wallets", passwordFile: "range-provider-wallet-password.txt", passwordEnv: "CANNED_RANGE_PROVIDER_PASSWORD" },
});

export function referenceFleetCatalog() {
  return REFERENCE_AGENT_SPECS.map((spec) => ({
    key: spec.key,
    identity: spec.identity,
    name: spec.name,
    category: spec.category,
    implementationStatus: spec.implemented ? "implemented" : "planned",
    venue: spec.venue || null,
    protocols: spec.protocols,
    capabilities: spec.capabilities,
    executionPolicy: spec.executionPolicy,
  }));
}
