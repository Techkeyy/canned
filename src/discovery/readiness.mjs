import { nowIso } from "../core.mjs";
import { RUN_TYPES } from "../domain.mjs";

export const DEFAULT_PROVIDER_COOLDOWN_SECONDS = 24 * 60 * 60;
export const SUPPORTED_A2A_PROTOCOL_VERSION = "0.3.0";
export const ERC8183_CAPABILITIES = Object.freeze({
  ONCHAIN_WATCHER: "ERC8183_ONCHAIN_WATCHER",
  NOTIFY_FUNDED: "ERC8183_NOTIFY_FUNDED",
  BUYER_RELAY_DELIVERY: "ERC8183_BUYER_RELAY_DELIVERY",
  PROVIDER_STORAGE_DELIVERY: "ERC8183_PROVIDER_STORAGE_DELIVERY",
});

const REQUIRED_READINESS_CHECKS = Object.freeze([
  "agentCardReachable",
  "quoteEndpointReachable",
  "signedQuoteValid",
  "providerMatchesIdentity",
  "quoteExpirySufficient",
  "notificationRouteExists",
  "notificationSchemaSupported",
  "taskCapabilityDeclared",
  "erc8183VersionMatches",
]);

const OPTIONAL_READINESS_CHECKS = Object.freeze(["healthStatusRoute", "recentObservableActivity"]);

function check(name, pass, details, required = true) {
  return {
    name,
    required,
    status: pass === true ? "pass" : pass === false ? "fail" : "not_observed",
    pass: pass === true,
    details: details || null,
  };
}

function cardSkills(card) {
  return Array.isArray(card?.skills) ? card.skills : [];
}

function skillById(card, id) {
  return cardSkills(card).find((skill) => String(skill?.id || "").toLowerCase() === id);
}

export function inferErc8183Capabilities({ card = null, candidate = null } = {}) {
  const text = `${JSON.stringify(card || {})} ${JSON.stringify(candidate || {})}`.toLowerCase();
  const skills = cardSkills(card).map((skill) => String(skill?.id || "").toLowerCase());
  const capabilities = [];
  const evidence = {};
  if (skills.includes("notify_funded") || text.includes("notify_funded")) {
    capabilities.push(ERC8183_CAPABILITIES.NOTIFY_FUNDED);
    evidence[ERC8183_CAPABILITIES.NOTIFY_FUNDED] = "card skill declares notify_funded";
  }
  if (/funded_job_watcher|funded job watcher|submit_result|submitresult|job watcher/.test(text)) {
    capabilities.push(ERC8183_CAPABILITIES.ONCHAIN_WATCHER);
    evidence[ERC8183_CAPABILITIES.ONCHAIN_WATCHER] = "card or published metadata mentions a funded-job watcher or submit_result";
  }
  if (/buyer.?relay|callback.?url|delivery.?context|relay authorization/.test(text)) {
    capabilities.push(ERC8183_CAPABILITIES.BUYER_RELAY_DELIVERY);
    evidence[ERC8183_CAPABILITIES.BUYER_RELAY_DELIVERY] = "card or metadata declares buyer relay/delivery context";
  }
  if (/ipfs|storage|deliverable_url|deliverable url|upload.*deliverable/.test(text)) {
    capabilities.push(ERC8183_CAPABILITIES.PROVIDER_STORAGE_DELIVERY);
    evidence[ERC8183_CAPABILITIES.PROVIDER_STORAGE_DELIVERY] = "card or metadata declares provider storage/deliverable URL behavior";
  }
  return { capabilities: [...new Set(capabilities)], evidence };
}

function cardText(card) {
  return JSON.stringify(card || {}).toLowerCase();
}

function categoryTaskSignal(candidate, category) {
  const text = `${candidate?.name || ""} ${candidate?.description || ""} ${JSON.stringify(candidate?.categoryHypotheses || [])}`.toLowerCase();
  const signals = {
    rebalancing: ["rebalance", "range", "liquidity", "pancakeswap"],
    grid_trading: ["grid", "ladder", "rungs", "spread"],
    yield_optimisation: ["yield", "apr", "apy", "stablecoin", "venus"],
    health_factor_monitoring: ["health", "liquidation", "collateral", "alert"],
  }[category] || [];
  return signals.some((signal) => text.includes(signal));
}

function runTime(run) {
  const created = Date.parse(run?.createdAt || "");
  return Number.isFinite(created) ? Math.floor(created / 1000) : 0;
}

function paidAttempt(run) {
  return run?.runType !== RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL && run?.protocolJob?.funded === true && run?.protocolJob?.jobId !== undefined && run?.protocolJob?.jobId !== null;
}

function hasObservedDeliverable(run) {
  return run?.qualification?.hasActualDeliverable === true || run?.agentExecution?.deliverableValidation?.valid === true;
}

function failureKind(run) {
  if (!paidAttempt(run) || hasObservedDeliverable(run)) return null;
  if (run?.terminalState === "timeout" || run?.executionStatus === "timeout") return "timeout";
  if (run?.terminalState === "rejected" || run?.protocolJob?.currentState === "REJECTED") return "rejection";
  if (run?.terminalState === "expired" || run?.protocolJob?.currentState === "EXPIRED") return "expiry";
  if (run?.terminalState === "error") return "error";
  return null;
}

function failurePhase(run) {
  if (!paidAttempt(run) || hasObservedDeliverable(run)) return null;
  const events = run?.protocolJob?.events || [];
  const notify = events.find((event) => event.event === "notify_funded");
  const submitted = events.some((event) => event.event === "deliverable_observed" || ["SUBMITTED", "COMPLETED"].includes(event.snapshot?.status));
  if (notify?.accepted === true && !submitted && ["EXPIRED", "FUNDED"].includes(run?.protocolJob?.currentState)) {
    return "accepted_notification_no_submission";
  }
  if (notify?.accepted === false) return "notification_rejected";
  return failureKind(run) ? "other_paid_failure" : null;
}

export function buildProviderHistory(runs = [], { cooldownSeconds = DEFAULT_PROVIDER_COOLDOWN_SECONDS } = {}) {
  const histories = new Map();
  const ordered = [...runs].filter(paidAttempt).sort((a, b) => runTime(a) - runTime(b));
  for (const run of ordered) {
    const identity = run?.agent?.identity;
    if (!identity) continue;
    const at = runTime(run) || Math.floor(Date.now() / 1000);
    const entry = histories.get(identity) || {
      identity,
      paidAttempts: 0,
      lastPaidAttempt: null,
      lastSuccessfulDeliverable: null,
      lastTimeout: null,
      lastRejection: null,
      consecutiveFailures: 0,
      cooldownUntil: null,
      failurePhases: [],
    };
    entry.paidAttempts += 1;
    entry.lastPaidAttempt = { runId: run.runId || null, at, jobId: run.protocolJob?.jobId ?? null };
    if (hasObservedDeliverable(run)) {
      entry.lastSuccessfulDeliverable = { runId: run.runId || null, at, jobId: run.protocolJob?.jobId ?? null };
      entry.consecutiveFailures = 0;
    } else {
      entry.consecutiveFailures += 1;
      const kind = failureKind(run);
      if (kind === "timeout" || kind === "expiry") entry.lastTimeout = { runId: run.runId || null, at, jobId: run.protocolJob?.jobId ?? null };
      if (kind === "rejection") entry.lastRejection = { runId: run.runId || null, at, jobId: run.protocolJob?.jobId ?? null };
      const phase = failurePhase(run);
      if (phase) entry.failurePhases.push({ phase, runId: run.runId || null, at, provider: run.protocolJob?.provider || null });
      entry.cooldownUntil = at + cooldownSeconds;
    }
    histories.set(identity, entry);
  }
  return Object.fromEntries([...histories.entries()].map(([identity, value]) => [identity, value]));
}

export function providerCooldownStatus(history, identity, nowSeconds = Math.floor(Date.now() / 1000)) {
  const entry = history?.[identity] || null;
  const cooldownUntil = entry?.cooldownUntil || null;
  return {
    active: Boolean(cooldownUntil && nowSeconds < cooldownUntil),
    cooldownUntil,
    reason: cooldownUntil && nowSeconds < cooldownUntil ? "recent_paid_failure" : null,
    history: entry,
  };
}

export function detectSystemicFailure(runs = [], { phase = "accepted_notification_no_submission", minimumIndependentProviders = 2 } = {}) {
  const matching = runs.filter((run) => failurePhase(run) === phase);
  const providers = [...new Set(matching.map((run) => run?.agent?.identity).filter(Boolean))];
  return {
    triggered: providers.length >= minimumIndependentProviders,
    phase,
    count: matching.length,
    independentProviders: providers,
    runIds: matching.map((run) => run.runId).filter(Boolean),
  };
}

export function buildReadinessChecklist({ candidate, probe, quoteProbe, quoteVerification, chainId = 97, nowSeconds = Math.floor(Date.now() / 1000), minQuoteLeadSeconds = 120, supportedProtocolVersion = SUPPORTED_A2A_PROTOCOL_VERSION, expectedCategory = null, healthStatus = null, recentActivity = null, history = null } = {}) {
  const card = probe?.card || null;
  const negotiateSkill = skillById(card, "negotiate");
  const notifySkill = skillById(card, "notify_funded");
  const cardLower = cardText(card);
  const quote = quoteProbe?.quote?.terms || quoteProbe?.quote || null;
  const quoteExpiresAt = Number(quoteProbe?.quote?.quote_expires_at || quote?.quote_expires_at || 0) || null;
  const provider = candidate?.agentWallet || candidate?.ownerAddress || null;
  const expectedTask = expectedCategory || candidate?.categoryHypotheses?.[0]?.category || null;
  const capabilityModel = inferErc8183Capabilities({ card, candidate });
  const checks = [
    check("agentCardReachable", probe?.reachable === true, probe?.reachable === true ? `HTTP ${probe.httpStatus || 200}` : probe?.reason || "agent card was not reachable"),
    check("quoteEndpointReachable", quoteProbe?.ok === true, quoteProbe?.ok === true ? "negotiation endpoint returned a response" : quoteProbe?.error || "fresh quote was not observed"),
    check("quoteAccepted", quoteProbe?.accepted === true, quoteProbe?.accepted === true ? "provider accepted the negotiated terms" : "provider did not accept a fresh quote"),
    check("signedQuoteValid", quoteVerification?.valid === true, quoteVerification?.valid === true ? "official SDK signature verification passed" : quoteVerification?.reason || "quote signature was not verified"),
    check("providerMatchesIdentity", Boolean(provider) && quoteVerification?.valid === true && (!quoteVerification?.signer || quoteVerification.signer.toLowerCase() === provider.toLowerCase()), provider ? "fresh provider address matches the verified identity record" : "provider address is missing"),
    check("quoteExpirySufficient", Boolean(quoteExpiresAt && quoteExpiresAt - nowSeconds >= minQuoteLeadSeconds), quoteExpiresAt ? `quote lead seconds=${quoteExpiresAt - nowSeconds}` : "quote expiry is missing or invalid"),
    check("notificationRouteExists", Boolean(probe?.reachable && notifySkill), notifySkill ? "card declares notify_funded" : "card does not declare notify_funded"),
    check("notificationSchemaSupported", Boolean(notifySkill && /notify_funded/.test(JSON.stringify(notifySkill)) && /job_id/.test(JSON.stringify(notifySkill))), notifySkill ? "notify_funded skill documents skill and job_id fields" : "notification schema was not documented"),
    check("taskCapabilityDeclared", Boolean(negotiateSkill && expectedTask && categoryTaskSignal(candidate, expectedTask)), negotiateSkill ? `negotiate skill and ${expectedTask} metadata observed` : "required task capability was not declared"),
    check("erc8183VersionMatches", Boolean(card && card.protocolVersion === supportedProtocolVersion && /erc.?8183/.test(cardLower)), card ? `protocol=${card.protocolVersion || "missing"}` : "ERC-8183 card was not observed"),
    check("healthStatusRoute", healthStatus === true ? true : healthStatus === false ? false : null, healthStatus === null ? "no documented health/status route" : healthStatus ? "documented health/status route passed" : "documented health/status route failed", false),
    check("recentObservableActivity", recentActivity === true ? true : recentActivity === false ? false : null, recentActivity === null ? "no recent activity signal was available" : recentActivity ? "recent activity observed" : "no recent activity observed", false),
  ];
  const required = checks.filter((item) => item.required);
  const passedRequired = required.filter((item) => item.pass).length;
  const quoteVerified = quoteVerification?.valid === true;
  const protocolCompatibility = checks.find((item) => item.name === "erc8183VersionMatches")?.pass === true;
  const deliveryHistory = history?.lastSuccessfulDeliverable ? "observed_success" : history?.paidAttempts ? "paid_failure" : "unverified";
  return {
    observedAt: nowIso(),
    score: Math.round((passedRequired / required.length) * 100),
    scoreMeaning: "discovery_and_preflight_only; not a delivery-success prediction",
    discoveryConfidence: passedRequired === required.length ? "high" : passedRequired >= Math.ceil(required.length / 2) ? "medium" : "low",
    quoteVerified,
    protocolCompatibility,
    deliveryHistory,
    cannedLastResult: history?.lastSuccessfulDeliverable ? "deliverable_observed" : history?.paidAttempts ? "paid_failure" : "never_paid",
    capabilities: capabilityModel.capabilities,
    capabilityEvidence: capabilityModel.evidence,
    ready: required.every((item) => item.pass),
    requiredPassed: passedRequired,
    requiredTotal: required.length,
    checks,
    quote: { price: quote?.price || null, currency: quote?.currency || null, quoteExpiresAt, estimatedCompletionSeconds: quoteProbe?.quote?.estimated_completion_seconds || null },
  };
}

export function deriveDeadlinePlan({ nowSeconds = Math.floor(Date.now() / 1000), estimatedCompletionSeconds = null, observationWindowSeconds = 300, disputeWindowSeconds = 0, providerSlackSeconds = 120, protocolSafetyBufferSeconds = 600 } = {}) {
  const estimated = Number(estimatedCompletionSeconds);
  const serviceSeconds = Number.isFinite(estimated) && estimated > 0 ? estimated : 300;
  const providerDeliveryDeadlineSeconds = Math.max(serviceSeconds + providerSlackSeconds, Number(disputeWindowSeconds) + protocolSafetyBufferSeconds);
  return {
    chosenAtUnixSeconds: nowSeconds,
    providerDeliveryDeadlineSeconds,
    providerDeliveryDeadlineAtUnixSeconds: nowSeconds + providerDeliveryDeadlineSeconds,
    benchmarkObservationWindowSeconds: Number(observationWindowSeconds) || 0,
    benchmarkObservationWindowAtUnixSeconds: nowSeconds + (Number(observationWindowSeconds) || 0),
    basis: { quotedCompletionSeconds: Number.isFinite(estimated) ? estimated : null, providerSlackSeconds, disputeWindowSeconds: Number(disputeWindowSeconds) || 0, protocolSafetyBufferSeconds },
  };
}

function categoryRank(category) {
  return { rebalancing: 4, grid_trading: 4, health_factor_monitoring: 3, yield_optimisation: 2 }[category] || 0;
}

export function buildCandidateMatrix({ candidates = [], observations = {}, providerHistory = {}, runs = [], nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const systemic = detectSystemicFailure(runs);
  return candidates.map((candidate) => {
    const observation = observations[candidate.identity] || {};
    const category = candidate.categoryHypotheses?.[0]?.category || null;
    const cooldown = providerCooldownStatus(providerHistory, candidate.identity, nowSeconds);
    const readiness = observation.readiness || buildReadinessChecklist({ candidate, probe: observation.probe, quoteProbe: observation.quoteProbe, quoteVerification: observation.quoteVerification, expectedCategory: category, nowSeconds, history: cooldown.history });
    const quote = readiness.quote || {};
    const matrix = {
      identity: candidate.identity,
      tokenId: candidate.tokenId,
      name: candidate.name,
      category,
      categories: candidate.categoryHypotheses || [],
      endpoint: observation.probe?.endpoint || candidate.services?.[0]?.endpoint || null,
      provider: candidate.agentWallet || candidate.ownerAddress || null,
      identityOnBsc: candidate.chainId === 97 && (candidate.network === "bsc-testnet" || candidate.is_testnet === true),
      liveness: observation.probe ? { reachable: observation.probe.reachable === true, callable: observation.probe.callable === true, status: observation.probe.status, elapsedMs: observation.probe.elapsedMs || null } : { reachable: false, callable: false, status: "not_observed", elapsedMs: null },
      quote: { accepted: observation.quoteProbe?.accepted === true, price: quote.price || null, currency: quote.currency || null, quoteExpiresAt: quote.quoteExpiresAt || null, estimatedCompletionSeconds: quote.estimatedCompletionSeconds || null, signatureVerified: observation.quoteVerification?.valid === true },
      quoteVerification: observation.quoteVerification || null,
      erc8183Support: readiness.checks.find((item) => item.name === "erc8183VersionMatches")?.status === "pass",
      expectedTaskType: category,
      expectedResponseFormat: candidate.description?.toLowerCase().includes("json") ? "JSON" : "structured output from benchmark schema",
      readiness,
      readinessScore: readiness.score,
      discoveryConfidence: readiness.discoveryConfidence,
      quoteVerified: readiness.quoteVerified,
      protocolCompatibility: readiness.protocolCompatibility,
      deliveryHistory: readiness.deliveryHistory,
      capabilities: readiness.capabilities,
      priorCannedExecutionHistory: cooldown.history || null,
      cooldown,
      benchmarkFeasibility: Boolean(category && candidate.chainId === 97 && (candidate.network === "bsc-testnet" || candidate.is_testnet === true) && readiness.ready && quote.price && quote.currency),
      controlFeasibility: Boolean(category),
      estimatedTimeToResultSeconds: quote.estimatedCompletionSeconds || null,
      termixUsefulness: ["rebalancing", "grid_trading", "health_factor_monitoring"].includes(category) ? "high" : "medium",
      pancakeSwapUsefulness: /pancakeswap/i.test(candidate.description || "") ? "high" : "unknown",
      systemicGuard: systemic,
      rankScore: (readiness.score * 100) + categoryRank(category) - (cooldown.active ? 10_000 : 0),
    };
    return matrix;
  });
}

export function rankCandidateMatrix(matrix = []) {
  return [...matrix].sort((left, right) => {
    const leftEligible = left.readiness?.ready && !left.cooldown?.active && left.benchmarkFeasibility && !left.systemicGuard?.triggered;
    const rightEligible = right.readiness?.ready && !right.cooldown?.active && right.benchmarkFeasibility && !right.systemicGuard?.triggered;
    return Number(rightEligible) - Number(leftEligible) || right.rankScore - left.rankScore || String(left.identity).localeCompare(String(right.identity));
  }).map((candidate, index) => ({ ...candidate, rank: index + 1, eligible: Boolean(candidate.readiness?.ready && !candidate.cooldown?.active && candidate.benchmarkFeasibility && !candidate.systemicGuard?.triggered) }));
}

export function summarizeProviderHistory(history = {}) {
  return Object.values(history).map((entry) => ({
    identity: entry.identity,
    paidAttempts: entry.paidAttempts,
    lastPaidAttempt: entry.lastPaidAttempt,
    lastSuccessfulDeliverable: entry.lastSuccessfulDeliverable,
    lastTimeout: entry.lastTimeout,
    lastRejection: entry.lastRejection,
    consecutiveFailures: entry.consecutiveFailures,
    cooldownUntil: entry.cooldownUntil,
  }));
}
