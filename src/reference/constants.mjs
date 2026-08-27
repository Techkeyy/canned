import { CATEGORIES } from "../domain.mjs";

export const REFERENCE_ORIGIN = "CANNED_REFERENCE";
export const REFERENCE_NETWORK = "bsc-testnet";
export const REFERENCE_CHAIN_ID = 97;
export const REFERENCE_PAYMENT_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
export const REFERENCE_PAYMENT_DECIMALS = 18;

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
    description: "Planned reference module for PancakeSwap position-range observation and bounded rebalancing.",
    problem: "Watch this LP position, explain range and inventory drift, and propose a bounded rebalance.",
    endpointPath: "/api/reference/rebalancing",
    implemented: false,
    protocols: ["ERC-8183"],
    priceRaw: "1000000000000000",
    capabilities: ["position_observation", "range_analysis", "bounded_recommendation"],
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

export function referenceAgentCandidate(spec, { providerAddress = null, endpointBase = "http://127.0.0.1:8787" } = {}) {
  if (!spec) throw new Error("A reference-agent spec is required.");
  const endpoint = `${endpointBase}${spec.endpointPath}`;
  const configured = Boolean(providerAddress);
  return {
    identity: spec.identity,
    name: spec.name,
    description: spec.description,
    network: REFERENCE_NETWORK,
    chainId: REFERENCE_CHAIN_ID,
    ownerAddress: providerAddress,
    agentWallet: providerAddress,
    origin: REFERENCE_ORIGIN,
    reference: true,
    referenceKey: spec.key,
    erc8004: { status: "not_registered", tokenId: null, registrationRequired: true },
    categoryHypotheses: [{ category: spec.category, confidence: "high", signals: ["Canned Reference Agent specification", ...spec.capabilities] }],
    services: [baseService(endpoint, spec.problem, { implemented: spec.implemented })],
    probes: spec.implemented ? [{ type: "HTTP task API", endpoint, reachable: true, callable: true, observedAt: new Date().toISOString(), origin: REFERENCE_ORIGIN }] : [],
    supports: { a2a: false, erc8183: true, x402: false, b402: false, mcp: false, httpTaskApi: spec.implemented },
    selectionGate: { readiness: { ready: false, quoteVerified: false, protocolCompatibility: true, providerConfigured: configured, reason: configured ? "A fresh quote and explicit operator confirmation are still required." : "Reference provider wallet is not configured." } },
    hiring: { price: spec.priceRaw, currency: REFERENCE_PAYMENT_TOKEN, mechanism: "ERC-8183 funded seller job", quoteVerified: false },
    referenceFleet: { origin: REFERENCE_ORIGIN, fleetVersion: "1.0.0", implementationStatus: spec.implemented ? "implemented" : "planned", executionPolicy: spec.executionPolicy },
  };
}

export function implementedReferenceAgentCandidates(options = {}) {
  return REFERENCE_AGENT_SPECS.filter((spec) => spec.implemented).map((spec) => referenceAgentCandidate(spec, options));
}

export function referenceFleetCatalog() {
  return REFERENCE_AGENT_SPECS.map((spec) => ({
    key: spec.key,
    identity: spec.identity,
    name: spec.name,
    category: spec.category,
    implementationStatus: spec.implemented ? "implemented" : "planned",
    protocols: spec.protocols,
    capabilities: spec.capabilities,
    executionPolicy: spec.executionPolicy,
  }));
}
