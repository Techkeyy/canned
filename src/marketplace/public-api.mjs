import { CATEGORIES, CATEGORY_LABELS, RUN_TYPES } from "../domain.mjs";
import { deriveAgentRecord } from "./model.mjs";
import { selectHiringAdapter } from "./adapters.mjs";
import { assessBnbEligibility, ELIGIBILITY } from "./eligibility.mjs";
import { applyListing, listingStateFor, LISTING_STATES } from "./listings.mjs";
import { GRID_EXECUTION_MODEL } from "../reference/grid-keeper.mjs";

/**
 * The public marketplace view.
 *
 * Every factual field here is derived from observed evidence: registry reads,
 * endpoint probes, verified quotes, funded jobs, observed deliveries, graded
 * benchmarks. Nothing a developer typed becomes a fact, and nothing missing
 * becomes a zero. Product copy lives in the pages; facts live here.
 */
const UNKNOWN = null;

function priceFrom(record) {
  // A price is only real if it came from a signed quote Canned verified.
  const quote = record.cannedObservations?.quote;
  if (quote?.priceRaw && quote?.signatureValid === true) {
    return { raw: String(quote.priceRaw), token: quote.currency || null, decimals: 18, verified: true, expiresAt: quote.expiresAt ?? null, source: "verified_signed_quote" };
  }
  if (record.trust?.states?.QUOTE_VERIFIED && record.advertised?.price) {
    return { raw: String(record.advertised.price), token: record.advertised.currency || null, decimals: 18, verified: true, expiresAt: null, source: "verified_quote_readiness" };
  }
  return { raw: UNKNOWN, token: record.advertised?.currency || null, decimals: 18, verified: false, expiresAt: null, source: "no_verified_quote" };
}

function trackRecordFrom(record) {
  const benchmarks = record.trust?.benchmarkCount ?? 0;
  return {
    deliveriesObserved: record.trust?.deliveryCount ?? 0,
    qualifyingBenchmarks: benchmarks,
    hireAttempts: record.trust?.paidAttempts ?? 0,
    // A win rate from zero or one observation is not a rate. Report the counts
    // and say plainly that there is not enough to summarise.
    wins: benchmarks > 0 ? record.trackRecord?.wins ?? 0 : UNKNOWN,
    losses: benchmarks > 0 ? record.trackRecord?.losses ?? 0 : UNKNOWN,
    sampleSize: benchmarks,
    hasEnoughForRate: benchmarks >= 2,
    summary: benchmarks === 0 ? "not_enough_data" : benchmarks === 1 ? "single_observation" : "observed",
  };
}

function capabilityFrom(record) {
  const claimed = record.categoryHypotheses?.[0] || null;
  const benchmarked = record.benchmarkRuns?.filter((run) => run.status === "completed") || [];
  return {
    claimedCategory: claimed?.category || record.ownerListing?.claimedCategory || null,
    claimedCategoryLabel: claimed?.label || record.ownerListing?.claimedCategoryLabel || null,
    claimedCategoryIsUnverified: true,
    verifiedCategories: [...new Set(benchmarked.map((run) => run.benchmarkId).filter(Boolean))],
    cannedVerifiedCapability: benchmarked.length > 0,
  };
}

/** What the agent is allowed to do, stated in user terms rather than protocol terms. */
function permissionsFrom(candidate) {
  const policy = candidate?.referenceFleet?.executionPolicy || null;
  if (!policy) return { known: false, canMoveFunds: UNKNOWN, readOnly: UNKNOWN, summary: "Not published by this agent." };
  return {
    known: true,
    canMoveFunds: policy.capitalMovement === true,
    readOnly: policy.readOnlyByDefault === true,
    automaticIntervention: policy.automaticIntervention === true,
    summary: policy.capitalMovement === false ? "Reads your position and gives an answer. It cannot move your funds." : "This agent can move funds. Review its permissions before hiring.",
  };
}

function executionModelFrom(candidate) {
  const modelId = candidate?.referenceFleet?.executionModel || (candidate?.referenceKey === "grid" ? GRID_EXECUTION_MODEL.id : null);
  if (modelId !== GRID_EXECUTION_MODEL.id) return null;
  return {
    id: GRID_EXECUTION_MODEL.id,
    label: GRID_EXECUTION_MODEL.label,
    venue: GRID_EXECUTION_MODEL.venue,
    routerVersion: GRID_EXECUTION_MODEL.routerVersion,
    isNativeLimitOrder: GRID_EXECUTION_MODEL.isNativeLimitOrder,
    summary: GRID_EXECUTION_MODEL.summary,
    source: "/api/grid/execution-model",
  };
}

export function buildPublicAgent({ candidate, runs, listing = null }) {
  const withListing = applyListing(candidate, listing);
  const record = deriveAgentRecord(withListing, runs);
  const eligibility = assessBnbEligibility(withListing);
  const adapter = selectHiringAdapter(withListing, { chainId: 97 });
  const price = priceFrom(record);
  const lastFailure = record.status?.lastFailure || null;

  return {
    identity: record.identity,
    name: record.name,
    description: record.description,
    purpose: withListing.ownerListing?.capabilityStatement || withListing.services?.[0]?.description || record.description,
    origin: record.origin,
    isReferenceAgent: record.reference === true,
    venue: record.venue,
    listingState: listingStateFor(withListing, listing),
    claimed: listing?.state === LISTING_STATES.CLAIMED || record.reference === true,
    claimedBy: listing?.claimedBy || null,
    developer: withListing.ownerListing ? { name: withListing.ownerListing.developerName, url: withListing.ownerListing.developerUrl, contactUrl: withListing.ownerListing.contactUrl, documentationUrl: withListing.ownerListing.documentationUrl } : null,
    category: capabilityFrom({ ...record, ownerListing: withListing.ownerListing }),
    executionModel: executionModelFrom(withListing),
    eligibility,
    chain: { network: record.network, chainId: record.chainId },
    erc8004: record.erc8004,
    owner: record.ownerAddress,
    provider: record.agentWallet,
    endpoint: record.services?.[0]?.endpoint || null,
    availability: {
      state: record.currentAvailability,
      reachable: record.currentAvailability === "reachable",
      lastCheckedAt: record.cannedObservations?.endpointChecks?.[0]?.observedAt || UNKNOWN,
      lastFailureReason: lastFailure,
    },
    price,
    permissions: permissionsFrom(withListing),
    trust: { states: record.trust.states, reached: record.trust.reached, label: record.status.label, lastTested: record.status.lastTested },
    trackRecord: trackRecordFrom(record),
    hire: { status: adapter.status, protocol: adapter.protocol || null, reason: adapter.reason || null, ready: adapter.status === "ready" },
    quarantine: record.quarantine,
    failures: record.trust.failures || [],
    runHistory: record.runHistory || [],
    benchmarkRuns: record.benchmarkRuns || [],
  };
}

/**
 * The public shelf. Ineligible chains never appear; eligible agents without an
 * endpoint observation stay in a separate discovery shelf. Endpoint evidence
 * is the minimum threshold for the default judge-facing shelf.
 */
export function buildMarketplace({ candidates = [], runs = [], listings = {} } = {}) {
  const verifiedAgents = [];
  const discoveredAgents = [];
  const pending = [];
  for (const candidate of candidates) {
    const agent = buildPublicAgent({ candidate, runs, listing: listings[candidate.identity] || null });
    if (agent.eligibility.status === ELIGIBILITY.ELIGIBLE && agent.trust.states.ENDPOINT_VERIFIED) verifiedAgents.push(agent);
    else if (agent.eligibility.status === ELIGIBILITY.ELIGIBLE) discoveredAgents.push(agent);
    else if (agent.eligibility.status === ELIGIBILITY.UNVERIFIED) pending.push(agent);
  }
  return {
    // `agents` is the safe default for a public consumer. Keep the explicit
    // names below so callers cannot accidentally confuse the two shelves.
    agents: verifiedAgents,
    verifiedAgents,
    discoveredAgents,
    allEligibleAgents: [...verifiedAgents, ...discoveredAgents],
    pendingEligibility: pending,
    categories: categorySummary(verifiedAgents),
    discoveredCategories: categorySummary(discoveredAgents),
    counts: {
      verified: verifiedAgents.length,
      discovered: discoveredAgents.length,
      pendingEligibility: pending.length,
    },
  };
}

export function categorySummary(agents = []) {
  return Object.values(CATEGORIES).map((category) => {
    const inCategory = agents.filter((agent) => agent.category.claimedCategory === category);
    const benchmarked = inCategory.filter((agent) => agent.trust.states.BENCHMARKED);
    return {
      category,
      label: CATEGORY_LABELS[category],
      listed: inCategory.length,
      reachable: inCategory.filter((agent) => agent.availability.reachable).length,
      hireable: inCategory.filter((agent) => agent.hire.ready).length,
      benchmarked: benchmarked.length,
      // A category with no benchmarked agent is incomplete, and the shelf says so.
      complete: benchmarked.length > 0,
    };
  });
}

/**
 * Homepage figures. These are the same derivations the marketplace uses, so the
 * homepage can never drift from the shelf or show a number nothing produced.
 */
export function buildHomepageEvidence({ agents = [], runs = [], metrics = {}, pairs = [], discoveredCount = 0, verifiedMppPayments = UNKNOWN } = {}) {
  const qualifying = pairs.filter((entry) => entry.termix?.termixCandidatePair === true);
  const verified = runs
    .filter((run) => run?.qualification?.isVerifiedRun === true)
    .sort((left, right) => (left.qualification.verifiedRunNumber ?? 0) - (right.qualification.verifiedRunNumber ?? 0))
    .map((run) => {
      const pairEntry = pairs.find((entry) => entry.runId === run.runId) || null;
      const agent = agents.find((item) => item.identity === run.agent?.identity) || null;
      return {
        runNumber: run.qualification.verifiedRunNumber,
        runId: run.runId,
        agentName: run.agent?.name || agent?.name || null,
        agentIdentity: run.agent?.identity || null,
        benchmarkId: run.benchmark?.id || null,
        category: run.benchmark?.category || null,
        categoryLabel: CATEGORY_LABELS[run.benchmark?.category] || null,
        jobId: run.protocolJob?.jobId ?? null,
        chainState: run.protocolJob?.currentState || null,
        humanQualityScore: run.evaluation?.metrics?.humanQualityScore ?? UNKNOWN,
        agentQualityScore: run.evaluation?.metrics?.agentQualityScore ?? UNKNOWN,
        humanElapsedMs: run.evaluation?.metrics?.humanElapsedMs ?? UNKNOWN,
        agentElapsedMs: run.evaluation?.metrics?.agentElapsedMs ?? UNKNOWN,
        agentAdvantage: run.evaluation?.metrics?.agentAdvantage ?? UNKNOWN,
        serviceFeeRaw: pairEntry?.pair?.withAgent?.cost?.serviceFeeRaw ?? UNKNOWN,
        gasWei: pairEntry?.pair?.withAgent?.cost?.networkGasWei ?? UNKNOWN,
        deliverableCid: pairEntry?.pair?.withAgent?.evidence?.deliverableCid ?? UNKNOWN,
      };
    });

  return {
    totals: {
      agentsListed: agents.length,
      discoveredAgents: discoveredCount,
      agentsBenchmarked: agents.filter((agent) => agent.trust.states.BENCHMARKED).length,
      jobsPaidForAndGraded: metrics.jobsPaidForAndGraded ?? UNKNOWN,
      deliveries: metrics.deliveries ?? UNKNOWN,
      wins: metrics.wins ?? UNKNOWN,
      losses: metrics.losses ?? UNKNOWN,
      timeouts: metrics.timeouts ?? UNKNOWN,
      verifiedMppPayments,
    },
    verifiedRuns: verified,
    pairedComparisons: { count: qualifying.length, required: 3 },
    categories: categorySummary(agents),
    note: "Every figure on this page is derived from the same evidence records the marketplace uses. Nothing here is written by hand.",
  };
}

/** Fixture and infrastructure-control runs never reach a public surface. */
export function publicRunsOnly(runs = []) {
  return runs.filter((run) => run?.runType !== RUN_TYPES.FIXTURE && run?.runType !== RUN_TYPES.INFRASTRUCTURE_SMOKE_TEST && run?.runType !== RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL);
}
