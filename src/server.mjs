import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { nowIso } from "./core.mjs";
import { FileStore } from "./persistence/file-store.mjs";
import { publicMetrics } from "./domain.mjs";
import { buildMarketplaceSnapshot, compareAgents } from "./marketplace/model.mjs";
import { deriveMarketplaceMetrics } from "./marketplace/metrics.mjs";
import { schedulerStatus } from "./scheduler/policy.mjs";
import { buildHealthFactorDeliverable, manualHealthFactorBaselinePacket } from "./reference/health-factor.mjs";
import { ReferenceAgentRuntime } from "./reference/foundation.mjs";
import { implementedReferenceAgentCandidates, REFERENCE_PAYMENT_TOKEN, referenceFleetCatalog, referenceSpec } from "./reference/constants.mjs";
import { altanaAvailability, buildAltanaSessionPolicy, officialErc8183Addresses } from "./reference/altana.mjs";
import { completeHumanBaseline, createHumanBaselineAttempt, publicHealthBenchPacket, publicHealthBenchSource } from "./reference/health-benchmark.mjs";
import { buildRangeKeeperDeliverable } from "./reference/range-keeper.mjs";
import { completeRebalanceBaseline, createRebalanceBaselineAttempt, publicRebalanceBenchPacket, publicRebalanceBenchSource, rebalanceContainsSecretAnswer, REBALANCE_BENCHMARK_ID } from "./reference/rebalance-benchmark.mjs";
import { summarizeRangeTrackRecord } from "./reference/range-track-record.mjs";
import { buildYieldScoutDeliverable } from "./reference/yield-scout.mjs";
import { completeYieldBaseline, createYieldBaselineAttempt, publicYieldBenchPacket, publicYieldBenchSource, yieldContainsSecretAnswer, YIELD_BENCHMARK_ID } from "./reference/yield-benchmark.mjs";
import { summarizeYieldTrackRecord } from "./reference/yield-track-record.mjs";
import { contentHashes } from "./core.mjs";
import { buildHomepageEvidence, buildMarketplace, buildPublicAgent, publicRunsOnly } from "./marketplace/public-api.mjs";
import { assessBnbEligibility } from "./marketplace/eligibility.mjs";
import { createListing, LISTING_STATES, updateListing, validateListingSubmission } from "./marketplace/listings.mjs";
import { challengeState, consumeChallenge, createChallenge, isAddress, ownershipRecord, verifyOwnership } from "./marketplace/ownership.mjs";
import { SlidingWindowLimiter, clientKey } from "./net/rate-limit.mjs";
import { buildGridKeeperDeliverable, planGridStrategy, GRID_EXECUTION_MODEL, GRID_TESTNET_VENUE } from "./reference/grid-keeper.mjs";
import { buildGridBenchmarkDefinition, publicGridBenchPacket } from "./reference/grid-benchmark.mjs";
import { computeGridGroundTruth, gradeGridBenchResponse } from "./reference/grid-evaluator.mjs";
import { buildGridTrackRecord } from "./reference/grid-track-record.mjs";
import { buildLeash, buildLeashProposal, LEASH_STATES } from "./marketplace/leash.mjs";
import { createHealthFactorX402Seller } from "./reference/health-factor-x402.mjs";

const store = await new FileStore().init();
const html = await readFile(path.resolve(process.cwd(), "web/inspection.html"), "utf8");
const baselineHtml = await readFile(path.resolve(process.cwd(), "web/health-baseline.html"), "utf8");
const rebalanceBaselineHtml = await readFile(path.resolve(process.cwd(), "web/rebalance-baseline.html"), "utf8");
const homeHtml = await readFile(path.resolve(process.cwd(), "web/home.html"), "utf8");
const marketplaceHtml = await readFile(path.resolve(process.cwd(), "web/marketplace.html"), "utf8");
const agentHtml = await readFile(path.resolve(process.cwd(), "web/agent.html"), "utf8");
const listHtml = await readFile(path.resolve(process.cwd(), "web/list.html"), "utf8");
const leashHtml = await readFile(path.resolve(process.cwd(), "web/leash.html"), "utf8");
const cannedCss = await readFile(path.resolve(process.cwd(), "web/canned.css"), "utf8");

// Ownership challenges are short lived and single use, so they live in memory
// rather than on disk. A restart invalidates them, which is the safe direction.
const ownershipChallenges = new Map();
const verifiedSessions = new Map();
// Public write endpoints are counted per client and per target. See
// src/net/rate-limit.mjs for why both boundaries are needed.
const publicWriteLimiter = new SlidingWindowLimiter();

/** Refuse a rate-limited request with the wait, not with a bare error. */
function refuseRateLimited(response, refused) {
  json(response, 429, {
    error: "rate_limited",
    reason: "Too many attempts. Wait a moment and try again.",
    retryAfterSeconds: refused.retryAfterSeconds ?? 60,
  });
}

async function agentListings() {
  return (await store.loadJson("state/agent-listings.json", { listings: {} })).listings || {};
}

async function saveAgentListings(listings) {
  await store.saveJson("state/agent-listings.json", { schemaVersion: 1, kind: "canned_agent_listings", updatedAt: nowIso(), listings });
}

/** Candidates the public marketplace draws from: discovered plus first-party. */
async function marketplaceCandidates() {
  const current = await snapshot();
  return current.report?.candidates || [];
}

async function publicMarketplace() {
  const [candidates, runs, listings] = await Promise.all([marketplaceCandidates(), store.loadRuns(), agentListings()]);
  return buildMarketplace({ candidates, runs: publicRunsOnly(runs), listings });
}
const yieldBaselineHtml = await readFile(path.resolve(process.cwd(), "web/yield-baseline.html"), "utf8");
const port = Number(process.env.PORT || 8787);
const healthFactorRuntime = new ReferenceAgentRuntime({
  spec: referenceSpec("health-factor"),
  taskHandler: ({ jobId, task, previousSnapshot }) => buildHealthFactorDeliverable({ jobId, task, previousSnapshot }),
});
const rangeKeeperRuntime = new ReferenceAgentRuntime({
  spec: referenceSpec("rebalancing"),
  taskHandler: ({ jobId, task }) => buildRangeKeeperDeliverable({ jobId, task }),
});
const yieldScoutRuntime = new ReferenceAgentRuntime({
  spec: referenceSpec("yield"),
  taskHandler: ({ jobId, task }) => buildYieldScoutDeliverable({ jobId, task }),
});
const gridKeeperRuntime = new ReferenceAgentRuntime({
  spec: referenceSpec("grid"),
  taskHandler: ({ jobId, task, strategy, observation, fills, authority }) =>
    buildGridKeeperDeliverable({ jobId, task, strategy, observation, fills, authority }),
});

const healthFactorProviderAddress = await referenceProviderAddress();
const healthFactorX402Recipient = process.env.CANNED_X402_PAY_TO || healthFactorProviderAddress;
const x402PublicBase = (process.env.CANNED_X402_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/u, "");
const healthFactorX402 = await createHealthFactorX402Seller({
  walletAddress: healthFactorX402Recipient,
  expectedRecipient: healthFactorProviderAddress || "",
  priceUsd: process.env.CANNED_X402_PRICE_USD || "0.0005",
  resourceUrl: `${x402PublicBase}/x402`,
});

async function referenceProviderAddress() {
  if (process.env.CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS) return process.env.CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS;
  try {
    const directory = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"), "state", "reference-provider-wallets");
    const names = (await readdir(directory)).filter((name) => /^0x[0-9a-fA-F]{40}\.json$/.test(name));
    return names.length === 1 ? names[0].slice(0, -5) : null;
  } catch { return null; }
}

async function referenceIdentityRecord() {
  return store.loadJson("state/reference-health-identity.json", null);
}

async function healthBenchDefinition() {
  return store.loadJson("state/healthbench-v1.json", null);
}

async function rebalanceBenchDefinition() {
  return store.loadJson("state/rebalancebench-v1.json", null);
}

async function rebalanceBaseline() {
  return store.loadJson("state/rebalance-baseline.json", null);
}

async function rangeIdentityRecord() {
  return store.loadJson("state/reference-range-identity.json", null);
}

async function yieldBenchDefinition() {
  return store.loadJson("state/yieldbench-v1.json", null);
}

async function yieldBaseline() {
  return store.loadJson("state/yield-baseline.json", null);
}

async function yieldIdentityRecord() {
  return store.loadJson("state/reference-yield-identity.json", null);
}

async function gridIdentityRecord() {
  return store.loadJson("state/reference-grid-identity.json", null);
}

/** The live grid strategy and its granted session, if either exists yet. */
async function gridStrategyRecord() {
  return store.loadJson("state/grid-strategy.json", null);
}

async function gridSessionRecord() {
  return store.loadJson("state/grid-session.json", null);
}

/** The graded outcome of the most recent YieldBench run, or null before one exists. */
async function latestYieldResult() {
  const runs = await store.loadRuns();
  const latest = runs
    .filter((item) => item?.benchmark?.id === YIELD_BENCHMARK_ID && item?.grading)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
  if (!latest) return null;
  const grading = await store.loadJson(`state/yieldbench-grading-${latest.runId}.json`, null);
  const runRecord = await store.loadJson(`state/yieldbench-run-${latest.runId}.json`, null);
  if (!grading) return null;
  return {
    runId: latest.runId,
    jobId: grading.jobId,
    identity: grading.identity,
    evaluatorVersion: grading.evaluatorVersion,
    policyVersion: grading.policyVersion,
    recommendation: grading.agent.rawOutput?.decision?.action ?? null,
    moveRecommended: grading.agent.rawOutput?.decision?.moveRecommended ?? null,
    recommendedAsset: grading.agent.rawOutput?.decision?.recommendedAsset ?? null,
    highestAdvertisedYield: grading.agent.rawOutput?.decision?.highestAdvertisedYield ?? null,
    rejectedCandidates: grading.agent.rawOutput?.decision?.rejectedCandidates ?? [],
    breakEvenDays: grading.agent.rawOutput?.decision?.breakEvenDays ?? null,
    expectedNetBenefit: grading.agent.rawOutput?.decision?.expectedNetBenefit ?? null,
    humanQualityScore: grading.human.score.qualityScore,
    agentQualityScore: grading.agent.score.qualityScore,
    humanElapsedMs: grading.human.elapsedMs,
    agentElapsedMs: grading.agent.elapsedMs,
    agentAdvantage: grading.pair.comparison.agentAdvantage,
    serviceFeeRaw: runRecord?.economics?.serviceFeeRaw ?? null,
    buyerGasWei: runRecord?.economics?.buyerGasWei ?? null,
    deliverableCid: grading.agent.deliverableCid,
    termix: grading.termix,
    verifiedRun: grading.verifiedRun,
    gradedAt: grading.gradedAt,
  };
}

async function yieldDecisions() {
  return (await store.loadJson("state/yield-decisions.json", { decisions: [] })).decisions || [];
}

async function rangeDecisions() {
  return (await store.loadJson("state/range-decisions.json", { decisions: [] })).decisions || [];
}

async function humanBaseline() {
  return store.loadJson("state/health-baseline.json", null);
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

function requestHeaders(request) {
  return Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : value || ""]));
}

async function snapshot() {
  const [report, runs] = await Promise.all([
    store.loadJson("inventory/verified-candidates.json", { candidates: [], categorySummary: {} }),
    store.loadRuns(),
  ]);
  const [identityRecord, rangeRecord, yieldRecord, gridRecord, baseline, rangeBaselineRecord, yieldBaselineRecord] = await Promise.all([referenceIdentityRecord(), rangeIdentityRecord(), yieldIdentityRecord(), gridIdentityRecord(), humanBaseline(), rebalanceBaseline(), yieldBaseline()]);
  const candidates = [...(report.candidates || []), ...implementedReferenceAgentCandidates({
    endpointBase: `http://127.0.0.1:${port}`,
    providerAddress: await referenceProviderAddress(),
    allowLocalProbe: false,
    identityRecords: { "health-factor": identityRecord, rebalancing: rangeRecord, yield: yieldRecord, grid: gridRecord },
    // GridBench needs no human baseline: TermiX is already satisfied by the
    // other three pairs, so this gate stays false and Grid Keeper is simply
    // shown at the evidence level it has.
    baselineSealedByKey: { "health-factor": baseline?.status === "submitted", rebalancing: rangeBaselineRecord?.status === "submitted", yield: yieldBaselineRecord?.status === "submitted" },
  })];
  const marketplace = buildMarketplaceSnapshot({ report: { ...report, candidates }, runs });
  return { report: { ...report, candidates }, runs, marketplace, metrics: deriveMarketplaceMetrics({ candidates, runs }) };
}

/** A fault in what the caller sent, which is a 400 rather than a 500. */
class BadRequestError extends Error {}

/** Anything a listing may legitimately carry fits well inside this. */
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

async function readRawBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // Refuse before buffering more: a public write endpoint must not let an
    // unbounded body accumulate in memory.
    if (size > MAX_REQUEST_BODY_BYTES) throw new BadRequestError("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse a request body as a JSON object. A JSON array or scalar would make
 * every `body?.field` read silently undefined, so the object shape the
 * handlers assume is required rather than hoped for.
 */
function parseJsonObject(raw) {
  let body;
  try { body = JSON.parse(raw); } catch { throw new BadRequestError("Request body must be valid JSON."); }
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new BadRequestError("Request body must be a JSON object.");
  return body;
}

async function readBody(request) {
  const raw = await readRawBody(request);
  if (!raw) return {};
  return parseJsonObject(raw);
}

/** The raw text is kept alongside the parsed body so it can be content addressed. */
async function readJsonBody(request) {
  const raw = await readRawBody(request);
  if (!raw) return { body: {}, raw: "{}" };
  return { body: parseJsonObject(raw), raw };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/canned.css") {
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
      response.end(cannedCss);
      return;
    }
    if (request.url === "/" || url.pathname === "/home") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(homeHtml);
      return;
    }
    if (url.pathname === "/marketplace" || url.pathname === "/compare") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(marketplaceHtml);
      return;
    }
    if (url.pathname.startsWith("/agent/")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(agentHtml);
      return;
    }
    if (url.pathname === "/list") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(listHtml);
      return;
    }
    if (request.url === "/inspection") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.url === "/baseline/yield") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(yieldBaselineHtml);
      return;
    }
    if (request.url === "/baseline/rebalance") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(rebalanceBaselineHtml);
      return;
    }
    if (request.url === "/baseline/health-factor") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(baselineHtml);
      return;
    }
    if (url.pathname === "/api/health") { json(response, 200, { ok: true, network: "bsc-testnet", chainId: 97, mode: process.env.CANNED_MODE || "live", mainnetWrites: false }); return; }
    if (url.pathname === "/x402") {
      if (!healthFactorX402.seller) {
        json(response, 503, { error: "x402_unavailable", service: "health-factor", x402: healthFactorX402.status });
        return;
      }
      const out = await healthFactorX402.seller.handle({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: requestHeaders(request),
        body: await readRawBody(request),
      });
      response.writeHead(out.status, out.headers);
      response.end(out.body);
      return;
    }
    if (url.pathname === "/api/inventory") { json(response, 200, await store.loadJson("inventory/verified-candidates.json", { candidates: [], categorySummary: {} })); return; }
    if (url.pathname === "/api/runs") { const runs = await store.loadRuns(); json(response, 200, { runs, publicMetrics: publicMetrics(runs) }); return; }
    if (url.pathname === "/api/marketplace") {
      const current = await snapshot();
      const category = url.searchParams.get("category");
      const agents = category ? current.marketplace.categories.find((item) => item.category === category)?.agents || [] : current.marketplace.agents;
      json(response, 200, { ...current.marketplace, agents, metrics: current.metrics });
      return;
    }
    if (url.pathname === "/api/metrics") { const current = await snapshot(); json(response, 200, current.metrics); return; }
    if (url.pathname === "/api/reference/fleet") { json(response, 200, { origin: "CANNED_REFERENCE", network: "bsc-testnet", chainId: 97, agents: referenceFleetCatalog() }); return; }
    if (url.pathname === "/api/reference/health-factor" && request.method === "GET") { json(response, 200, { ...healthFactorRuntime.health(), x402: healthFactorX402.status }); return; }
    if (url.pathname === "/api/reference/health-factor/x402" && request.method === "GET") { json(response, 200, healthFactorX402.status); return; }
    if (url.pathname === "/api/reference/health-factor/readiness") { json(response, 200, healthFactorRuntime.readiness()); return; }
    if (url.pathname === "/api/reference/health-factor/metrics") { json(response, 200, healthFactorRuntime.metrics()); return; }
    if (url.pathname === "/api/reference/health-factor/negotiate") {
      const body = request.method === "POST" ? await readBody(request) : Object.fromEntries(url.searchParams.entries());
      json(response, 200, healthFactorRuntime.negotiate({ request: body, providerAddress: await referenceProviderAddress(), paymentToken: REFERENCE_PAYMENT_TOKEN }));
      return;
    }
    if (url.pathname === "/api/reference/health-factor/task" && request.method === "POST") {
      const frozenDefinition = await healthBenchDefinition();
      const baseline = await humanBaseline();
      if (frozenDefinition && baseline?.status !== "submitted") {
        json(response, 403, { status: "blocked", reason: "HealthBench human baseline must be submitted before any benchmark-bound agent result is exposed." });
        return;
      }
      const body = await readBody(request);
      const result = await healthFactorRuntime.work({ jobId: body.jobId || null, task: body.task || body, previousSnapshot: body.previousSnapshot || null });
      json(response, result.ok ? 200 : 422, result);
      return;
    }
    if (url.pathname === "/api/reference/health-factor/manual-baseline") {
      json(response, 200, manualHealthFactorBaselinePacket({ task: { account: url.searchParams.get("account") || null, poolType: url.searchParams.get("poolType") || null } }));
      return;
    }
    if (url.pathname === "/api/altana/status") { json(response, 200, await altanaAvailability()); return; }
    if (url.pathname === "/api/altana/policy") {
      try {
        const official = await officialErc8183Addresses();
        const commerceAddress = process.env.CANNED_ERC8183_COMMERCE_ADDRESS || official.commerceAddress;
        const routerAddress = process.env.CANNED_ERC8183_ROUTER_ADDRESS || official.routerAddress;
        const expiry = Math.floor(Date.now() / 1000) + 900;
        json(response, 200, { status: "policy_ready", officialDeployments: official, policy: buildAltanaSessionPolicy({ commerceAddress, routerAddress, expiry, maxSpendRaw: process.env.CANNED_REFERENCE_MAX_SPEND_RAW || "1000000000000000" }) });
      } catch (error) { json(response, 422, { status: "blocked", reason: error.message }); }
      return;
    }
    if (url.pathname === "/api/reference/yield" && request.method === "GET") { json(response, 200, yieldScoutRuntime.health()); return; }
    if (url.pathname === "/api/reference/yield/readiness") { json(response, 200, yieldScoutRuntime.readiness()); return; }
    if (url.pathname === "/api/reference/yield/metrics") { json(response, 200, yieldScoutRuntime.metrics()); return; }
    if (url.pathname === "/api/reference/yield/track-record") {
      const definition = await yieldBenchDefinition();
      json(response, 200, {
        agent: "Canned Yield Scout",
        venue: "Venus",
        benchmark: definition ? { id: definition.benchmarkId, version: definition.version, positionAsset: definition.position.assetSymbol, positionAmount: definition.position.amount, horizonDays: definition.horizonDays, marketsCompared: definition.frozenEvidence.snapshot.markets.length, referenceBlock: definition.referenceBlock, marketDataChain: definition.executionBoundary.marketDataChain, marketDataAccess: definition.executionBoundary.marketDataAccess } : null,
        latestResult: await latestYieldResult(),
        ...summarizeYieldTrackRecord({ decisions: await yieldDecisions() }),
      });
      return;
    }
    if (url.pathname === "/api/baseline/yield" && request.method === "GET") {
      const definition = await yieldBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "YieldBench v1 has not been frozen." }); return; }
      const current = await yieldBaseline();
      const packet = publicYieldBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: current?.status || "not_started", attemptId: current?.attemptId || null, startedAt: current?.startedAt || null, sourceAvailable: current?.status === "started" };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/yield/start" && request.method === "POST") {
      const definition = await yieldBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "YieldBench v1 has not been frozen." }); return; }
      const current = await yieldBaseline();
      if (current?.status === "submitted") { json(response, 409, { status: "already_submitted", attemptId: current.attemptId }); return; }
      const attempt = current?.status === "started" ? current : createYieldBaselineAttempt({ benchmarkId: definition.benchmarkId });
      if (!current || current.status !== "started") await store.saveJson("state/yield-baseline.json", attempt);
      const packet = publicYieldBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: "started", attemptId: attempt.attemptId, startedAt: attempt.startedAt, sourceAvailable: true };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/yield/source" && request.method === "GET") {
      const definition = await yieldBenchDefinition();
      const current = await yieldBaseline();
      if (!definition || current?.status !== "started") { json(response, 403, { status: "blocked", reason: "Start the baseline before requesting the frozen source packet." }); return; }
      const source = publicYieldBenchSource(definition);
      if (yieldContainsSecretAnswer(source)) { json(response, 500, { status: "blocked", reason: "The source packet failed its contamination check." }); return; }
      json(response, 200, source);
      return;
    }
    if (url.pathname === "/api/baseline/yield/submit" && request.method === "POST") {
      const definition = await yieldBenchDefinition();
      const current = await yieldBaseline();
      if (!definition || current?.status !== "started") { json(response, 403, { status: "blocked", reason: "A started YieldBench baseline is required." }); return; }
      const incoming = await readJsonBody(request);
      const completed = completeYieldBaseline({ attempt: current, submission: incoming.body, submittedAt: nowIso(), elapsedMs: Math.max(0, Date.now() - Date.parse(current.startedAt)) });
      completed.rawSubmissionJson = incoming.raw;
      completed.groundTruth = null;
      completed.agentOutput = null;
      const hashes = contentHashes(incoming.raw);
      completed.evidence = { sha256: hashes.sha256, keccak256: hashes.keccak256, preservationStatus: "exact_raw_response_preserved_content_addressed" };
      await store.saveJson("state/yield-baseline.json", completed);
      await store.saveEvidence({ kind: "yieldbench_human_baseline", benchmarkId: YIELD_BENCHMARK_ID, attemptId: completed.attemptId, precommit: definition.precommit, startedAt: completed.startedAt, submittedAt: completed.submittedAt, elapsedMs: completed.elapsedMs, rawSubmissionJson: completed.rawSubmissionJson, rawSubmissionSha256: hashes.sha256, rawSubmissionKeccak256: hashes.keccak256, agentOutputBeforeSubmission: false, groundTruthBeforeSubmission: false });
      json(response, 200, { status: "submitted", attemptId: completed.attemptId, benchmarkId: completed.benchmarkId, submittedAt: completed.submittedAt, elapsedMs: completed.elapsedMs, evidenceSha256: hashes.sha256, preserved: true, evaluated: false, agentRun: "not_started" });
      return;
    }
    if (url.pathname === "/leash") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(leashHtml);
      return;
    }
    if (url.pathname === "/api/reference/grid" && request.method === "GET") { json(response, 200, gridKeeperRuntime.health()); return; }
    if (url.pathname === "/api/reference/grid/readiness") { json(response, 200, gridKeeperRuntime.readiness()); return; }
    if (url.pathname === "/api/reference/grid/metrics") { json(response, 200, gridKeeperRuntime.metrics()); return; }
    /** How Grid Keeper executes, stated in one place so no surface can drift. */
    if (url.pathname === "/api/grid/execution-model") { json(response, 200, { ...GRID_EXECUTION_MODEL, venueContracts: GRID_TESTNET_VENUE }); return; }
    if (url.pathname === "/api/grid/benchmark") {
      json(response, 200, publicGridBenchPacket(buildGridBenchmarkDefinition()));
      return;
    }
    if (url.pathname === "/api/grid/track-record") {
      const stored = await store.loadJson("state/grid-track-record.json", { sessions: [] });
      json(response, 200, buildGridTrackRecord({ sessions: stored.sessions || [] }));
      return;
    }
    /**
     * The Leash. Derived from the granted session, or NOT_CONFIGURED when no
     * session exists. It never describes an authority that was not granted.
     */
    if (url.pathname === "/api/grid/leash") {
      const [strategyRecord, sessionRecord] = await Promise.all([gridStrategyRecord(), gridSessionRecord()]);
      const { BNB_TESTNET } = await import("@altananetwork/sdk");
      // The stored record names the key `sessionPublicKey`; The Leash reads
      // `publicKey`. Mapping it here keeps the on-chain identifier visible so a
      // reader can check the session against the KeyStore themselves.
      const session = sessionRecord?.session
        ? { ...sessionRecord.session, publicKey: sessionRecord.session.sessionPublicKey ?? sessionRecord.session.publicKey ?? null }
        : null;
      json(response, 200, {
        ...buildLeash({ strategy: strategyRecord?.strategy ?? null, session, network: BNB_TESTNET, revoked: sessionRecord?.revoked === true }),
        // Transactions a reader can verify without trusting this page.
        grantTransactionHash: sessionRecord?.session?.grantTransactionHash ?? null,
        revocationTransactionHash: sessionRecord?.session?.revocationTransactionHash ?? null,
        executions: sessionRecord?.session?.executions ?? [],
      });
      return;
    }
    /** Preview the exact permission a user would be asked to grant. */
    if (url.pathname === "/api/grid/leash/proposal" && request.method === "POST") {
      const incoming = await readJsonBody(request);
      const spec = incoming.body?.strategy;
      if (!spec) { json(response, 400, { error: "strategy_required", reason: "Describe the grid you want before reviewing permissions." }); return; }
      const { BNB_TESTNET } = await import("@altananetwork/sdk");
      try {
        const strategy = planGridStrategy(spec);
        const proposal = buildLeashProposal({ strategy, network: BNB_TESTNET });
        // The permissions object carries BigInt limits, which JSON cannot hold.
        json(response, 200, { ...proposal, permissions: undefined, strategy: { strategyId: strategy.strategyId, levels: strategy.levels, range: strategy.range, capital: strategy.capital, guards: strategy.guards, pair: strategy.pair, hash: strategy.hashes.sha256 } });
      } catch (error) { json(response, 400, { error: "strategy_rejected", reason: error.message }); }
      return;
    }
    if (url.pathname === "/api/reference/rebalancing" && request.method === "GET") { json(response, 200, rangeKeeperRuntime.health()); return; }
    if (url.pathname === "/api/reference/rebalancing/readiness") { json(response, 200, rangeKeeperRuntime.readiness()); return; }
    if (url.pathname === "/api/reference/rebalancing/metrics") { json(response, 200, rangeKeeperRuntime.metrics()); return; }
    if (url.pathname === "/api/reference/rebalancing/track-record") {
      const definition = await rebalanceBenchDefinition();
      const runs = await store.loadRuns();
      const latest = runs.filter((item) => item?.benchmark?.id === REBALANCE_BENCHMARK_ID && item?.grading).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] || null;
      const grading = latest ? await store.loadJson(`state/rebalancebench-grading-${latest.runId}.json`, null) : null;
      const runRecord = latest ? await store.loadJson(`state/rebalancebench-run-${latest.runId}.json`, null) : null;
      json(response, 200, {
        agent: "Canned Range Keeper",
        venue: "PancakeSwap",
        benchmark: definition ? { id: definition.benchmarkId, version: definition.version, pool: definition.pool.address, pair: `${definition.pool.token0.symbol}/${definition.pool.token1.symbol}`, feeTier: definition.pool.fee, tickSpacing: definition.pool.tickSpacing, positionTokenId: definition.position.tokenId, tickLower: definition.position.tickLower, tickUpper: definition.position.tickUpper, referenceBlock: definition.referenceBlock, marketDataChain: definition.executionBoundary.marketDataChain, marketDataAccess: definition.executionBoundary.marketDataAccess } : null,
        latestResult: grading ? {
          runId: latest.runId,
          jobId: grading.jobId,
          identity: grading.identity,
          evaluatorVersion: grading.evaluatorVersion,
          recommendation: grading.agent.rawOutput?.decision?.action ?? null,
          rebalanceRecommended: grading.agent.rawOutput?.decision?.rebalanceRecommended ?? null,
          proposedRange: grading.agent.rawOutput?.proposedRange ?? null,
          humanQualityScore: grading.human.score.qualityScore,
          agentQualityScore: grading.agent.score.qualityScore,
          humanElapsedMs: grading.human.elapsedMs,
          agentElapsedMs: grading.agent.elapsedMs,
          agentAdvantage: grading.pair.comparison.agentAdvantage,
          serviceFeeRaw: runRecord?.economics?.serviceFeeRaw ?? null,
          buyerGasWei: runRecord?.economics?.buyerGasWei ?? null,
          deliverableCid: grading.agent.deliverableCid,
          termix: grading.termix,
          verifiedRun: grading.verifiedRun,
          gradedAt: grading.gradedAt,
        } : null,
        ...summarizeRangeTrackRecord({ decisions: await rangeDecisions() }),
      });
      return;
    }
    if (url.pathname === "/api/baseline/rebalance" && request.method === "GET") {
      const definition = await rebalanceBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "RebalanceBench v1 has not been frozen." }); return; }
      const current = await rebalanceBaseline();
      const packet = publicRebalanceBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: current?.status || "not_started", attemptId: current?.attemptId || null, startedAt: current?.startedAt || null, sourceAvailable: current?.status === "started" };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/rebalance/start" && request.method === "POST") {
      const definition = await rebalanceBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "RebalanceBench v1 has not been frozen." }); return; }
      const current = await rebalanceBaseline();
      if (current?.status === "submitted") { json(response, 409, { status: "already_submitted", attemptId: current.attemptId }); return; }
      const attempt = current?.status === "started" ? current : createRebalanceBaselineAttempt({ benchmarkId: definition.benchmarkId });
      if (!current || current.status !== "started") await store.saveJson("state/rebalance-baseline.json", attempt);
      const packet = publicRebalanceBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: "started", attemptId: attempt.attemptId, startedAt: attempt.startedAt, sourceAvailable: true };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/rebalance/source" && request.method === "GET") {
      const definition = await rebalanceBenchDefinition();
      const current = await rebalanceBaseline();
      if (!definition || current?.status !== "started") { json(response, 403, { status: "blocked", reason: "Start the baseline before requesting the frozen source packet." }); return; }
      const source = publicRebalanceBenchSource(definition);
      // Fail closed rather than serve a packet that could carry an answer.
      if (rebalanceContainsSecretAnswer(source)) { json(response, 500, { status: "blocked", reason: "The source packet failed its contamination check." }); return; }
      json(response, 200, source);
      return;
    }
    if (url.pathname === "/api/baseline/rebalance/submit" && request.method === "POST") {
      const definition = await rebalanceBenchDefinition();
      const current = await rebalanceBaseline();
      if (!definition || current?.status !== "started") { json(response, 403, { status: "blocked", reason: "A started RebalanceBench baseline is required." }); return; }
      const incoming = await readJsonBody(request);
      const completed = completeRebalanceBaseline({ attempt: current, submission: incoming.body, submittedAt: nowIso(), elapsedMs: Math.max(0, Date.now() - Date.parse(current.startedAt)) });
      completed.rawSubmissionJson = incoming.raw;
      completed.groundTruth = null;
      completed.agentOutput = null;
      const hashes = contentHashes(incoming.raw);
      completed.evidence = { sha256: hashes.sha256, keccak256: hashes.keccak256, preservationStatus: "exact_raw_response_preserved_content_addressed" };
      await store.saveJson("state/rebalance-baseline.json", completed);
      await store.saveEvidence({ kind: "rebalancebench_human_baseline", benchmarkId: REBALANCE_BENCHMARK_ID, attemptId: completed.attemptId, precommit: definition.precommit, startedAt: completed.startedAt, submittedAt: completed.submittedAt, elapsedMs: completed.elapsedMs, rawSubmissionJson: completed.rawSubmissionJson, rawSubmissionSha256: hashes.sha256, rawSubmissionKeccak256: hashes.keccak256, agentOutputBeforeSubmission: false, groundTruthBeforeSubmission: false });
      json(response, 200, { status: "submitted", attemptId: completed.attemptId, benchmarkId: completed.benchmarkId, submittedAt: completed.submittedAt, elapsedMs: completed.elapsedMs, evidenceSha256: hashes.sha256, preserved: true, evaluated: false, agentRun: "not_started" });
      return;
    }
    if (url.pathname === "/api/agents") {
      const market = await publicMarketplace();
      const category = url.searchParams.get("category");
      const search = (url.searchParams.get("q") || "").trim().toLowerCase();
      const sort = url.searchParams.get("sort") || "evidence";
      let agents = market.agents;
      if (category && category !== "all") agents = agents.filter((agent) => agent.category.claimedCategory === category);
      if (search) agents = agents.filter((agent) => [agent.name, agent.description, agent.purpose, agent.identity].filter(Boolean).some((field) => String(field).toLowerCase().includes(search)));
      const rank = (agent) => agent.trust.reached.length * 100 + agent.trackRecord.qualifyingBenchmarks * 10 + (agent.availability.reachable ? 1 : 0);
      const sorters = {
        evidence: (left, right) => rank(right) - rank(left),
        recent: (left, right) => Date.parse(right.trust.lastTested || 0) - Date.parse(left.trust.lastTested || 0),
        name: (left, right) => String(left.name).localeCompare(String(right.name)),
      };
      agents = [...agents].sort(sorters[sort] || sorters.evidence);
      json(response, 200, { agents, categories: market.categories, pendingEligibilityCount: market.pendingEligibility.length, total: agents.length, sort, appliedCategory: category || "all", query: search || null });
      return;
    }
    if (url.pathname === "/api/homepage") {
      const [market, runs, current, storedPairs] = await Promise.all([publicMarketplace(), store.loadRuns(), snapshot(), store.loadJson("state/agent-advantage-pairs.json", { pairs: [] })]);
      json(response, 200, buildHomepageEvidence({ agents: market.agents, runs: publicRunsOnly(runs), metrics: current.metrics, pairs: storedPairs.pairs || [] }));
      return;
    }
    if (url.pathname.startsWith("/api/agent/")) {
      const identity = decodeURIComponent(url.pathname.slice("/api/agent/".length));
      const [candidates, runs, listings] = await Promise.all([marketplaceCandidates(), store.loadRuns(), agentListings()]);
      const candidate = candidates.find((item) => item.identity === identity);
      if (!candidate) { json(response, 404, { error: "not_found", reason: "Canned has no record of this agent." }); return; }
      const agent = buildPublicAgent({ candidate, runs: publicRunsOnly(runs), listing: listings[identity] || null });
      const storedPairs = await store.loadJson("state/agent-advantage-pairs.json", { pairs: [] });
      agent.agentAdvantage = (storedPairs.pairs || []).filter((entry) => entry.identity === identity);
      json(response, 200, agent);
      return;
    }
    if (url.pathname === "/api/listings") {
      const listings = await agentListings();
      json(response, 200, { count: Object.keys(listings).length, listings: Object.values(listings).map((entry) => ({ identity: entry.identity, state: entry.state, claimedBy: entry.claimedBy, claimedAt: entry.claimedAt, listing: entry.listing })) });
      return;
    }
    if (url.pathname === "/api/list/resolve" && request.method === "GET") {
      const identity = (url.searchParams.get("identity") || "").trim();
      if (!identity) { json(response, 400, { error: "identity_required", reason: "Enter the agent identity you want to list." }); return; }
      const [candidates, listings] = await Promise.all([marketplaceCandidates(), agentListings()]);
      const candidate = candidates.find((item) => item.identity === identity) || null;
      const eligibility = assessBnbEligibility(candidate || { identity });
      const existing = listings[identity] || null;
      json(response, 200, {
        identity,
        found: Boolean(candidate),
        eligibility,
        alreadyClaimed: existing?.state === LISTING_STATES.CLAIMED,
        claimedBy: existing?.claimedBy || null,
        resolved: candidate ? { name: candidate.name, description: candidate.description, owner: candidate.ownerAddress, endpoint: candidate.services?.[0]?.endpoint || null, chainId: candidate.chainId, network: candidate.network, origin: candidate.origin } : null,
        reason: candidate ? null : "Canned has not discovered this identity yet. Run discovery, or check the identity is on BNB Chain.",
      });
      return;
    }
    if (url.pathname === "/api/claim/challenge" && request.method === "POST") {
      const incoming = await readJsonBody(request);
      const identity = String(incoming.body?.identity || "").trim();
      const address = String(incoming.body?.address || "").trim();
      if (!identity || !isAddress(address)) { json(response, 400, { error: "identity_and_address_required", reason: "Connect a wallet and choose the agent you want to claim." }); return; }
      const challengeLimit = publicWriteLimiter.check([
        ["challengePerIp", clientKey(request)],
        ["challengePerAddress", address],
        ["challengePerIdentity", identity],
      ]);
      if (!challengeLimit.allowed) { refuseRateLimited(response, challengeLimit.refused); return; }
      const candidates = await marketplaceCandidates();
      const candidate = candidates.find((item) => item.identity === identity);
      if (!candidate) { json(response, 404, { error: "unknown_identity", reason: "Canned has no record of this agent." }); return; }
      for (const [key, value] of ownershipChallenges) { if (Date.parse(value.expiresAt) <= Date.now()) ownershipChallenges.delete(key); }
      const challenge = createChallenge({ identity, address });
      ownershipChallenges.set(challenge.nonce, challenge);
      json(response, 200, { nonce: challenge.nonce, message: challenge.message, expiresAt: challenge.expiresAt, identity, address: challenge.address, onchainOwner: candidate.ownerAddress || null });
      return;
    }
    if (url.pathname === "/api/claim/verify" && request.method === "POST") {
      const incoming = await readJsonBody(request);
      const nonce = String(incoming.body?.nonce || "");
      const signature = String(incoming.body?.signature || "");
      const identity = String(incoming.body?.identity || "");
      const verifyLimit = publicWriteLimiter.check([
        ["verifyPerIp", clientKey(request)],
        ["verifyPerIdentity", identity || nonce],
      ]);
      if (!verifyLimit.allowed) { refuseRateLimited(response, verifyLimit.refused); return; }
      const challenge = ownershipChallenges.get(nonce) || null;
      const state = challengeState(challenge);
      if (!state.valid) { json(response, 400, { verified: false, error: state.error, reason: "This verification request is no longer valid. Start again." }); return; }
      const candidates = await marketplaceCandidates();
      const candidate = candidates.find((item) => item.identity === challenge.identity);
      if (!candidate) { json(response, 404, { verified: false, error: "unknown_identity" }); return; }
      const { recoverMessageAddress } = await import("viem");
      const result = await verifyOwnership({
        challenge, signature, identity: identity || challenge.identity,
        onchainOwner: candidate.ownerAddress,
        recoverAddress: ({ message, signature: sig }) => recoverMessageAddress({ message, signature: sig }),
      });
      // Single use either way: a failed attempt burns the challenge too.
      ownershipChallenges.set(nonce, consumeChallenge(challenge));
      if (!result.verified) { json(response, 401, { verified: false, error: result.error, reason: "That wallet does not control this agent onchain." }); return; }
      const proof = ownershipRecord({ verification: result, identity: challenge.identity });
      verifiedSessions.set(nonce, { ...result, identity: challenge.identity, proof });
      json(response, 200, { verified: true, sessionToken: nonce, identity: challenge.identity, owner: result.onchainOwner, expiresAt: result.sessionExpiresAt, proof });
      return;
    }
    if (url.pathname === "/api/list/submit" && request.method === "POST") {
      const incoming = await readJsonBody(request);
      const submitLimit = publicWriteLimiter.check([["submitPerIp", clientKey(request)]]);
      if (!submitLimit.allowed) { refuseRateLimited(response, submitLimit.refused); return; }
      const sessionToken = String(incoming.body?.sessionToken || "");
      const session = verifiedSessions.get(sessionToken) || null;
      if (!session || Date.parse(session.sessionExpiresAt) <= Date.now()) { json(response, 401, { error: "verification_required", reason: "Verify wallet ownership before submitting a listing." }); return; }
      const submission = incoming.body?.listing || {};
      const validation = validateListingSubmission(submission);
      if (!validation.valid) { json(response, 400, { error: "listing_rejected", errors: validation.errors, reason: "Some of that information is set by Canned from evidence and cannot be supplied here." }); return; }
      const [listings, candidates] = await Promise.all([agentListings(), marketplaceCandidates()]);
      const candidate = candidates.find((item) => item.identity === session.identity);
      try {
        const existing = listings[session.identity] || null;
        const record = existing
          ? updateListing({ existing, submission, ownership: session.proof })
          : createListing({ identity: session.identity, submission, ownership: session.proof, discoveredAt: candidate?.probes?.[0]?.observedAt || null });
        listings[session.identity] = record;
        await saveAgentListings(listings);
        await store.saveEvidence({ kind: "agent_listing", identity: session.identity, listing: record });
        const agent = buildPublicAgent({ candidate, runs: publicRunsOnly(await store.loadRuns()), listing: record });
        json(response, 200, { status: "listed", identity: session.identity, state: record.state, trust: agent.trust, note: "Your agent is listed at the evidence level Canned has actually observed. Trust states advance only when Canned verifies them." });
      } catch (error) { json(response, 400, { error: "listing_rejected", reason: error.message }); }
      return;
    }
    if (url.pathname === "/api/agent-advantage") {
      const stored = await store.loadJson("state/agent-advantage-pairs.json", { pairs: [] });
      const runs = await store.loadRuns();
      const pairs = await Promise.all((stored.pairs || []).map(async (entry) => {
        const grading = await store.loadJson(`state/healthbench-grading-${entry.runId}.json`, null);
        const run = runs.find((item) => item.runId === entry.runId) || null;
        return {
          runId: entry.runId,
          jobId: entry.jobId,
          benchmarkId: entry.benchmarkId,
          category: entry.category,
          task: entry.task,
          agent: { identity: entry.identity, name: run?.agent?.name || null, provider: grading?.provider || null },
          referenceBlock: grading?.referenceBlock || null,
          evaluatorVersion: entry.pair?.evaluatorVersion || null,
          groundTruthHash: entry.pair?.groundTruthHash || null,
          withoutAgent: { ...entry.pair.withoutAgent, rawOutput: grading?.human?.rawSubmission ?? null, dimensions: grading?.human?.score?.dimensions ?? null },
          withAgent: { ...entry.pair.withAgent, rawOutput: grading?.agent?.rawOutput ?? null, dimensions: grading?.agent?.score?.dimensions ?? null, deliverableUrl: grading?.agent?.deliverableUrl ?? null },
          comparison: entry.pair.comparison,
          termix: entry.termix,
          verifiedRun: entry.verifiedRun,
          protocol: run ? { chainState: run.protocolJob?.currentState || null, transactions: (run.protocolJob?.events || []).filter((event) => event.tx?.transactionHash).map((event) => ({ event: event.event, transactionHash: event.tx.transactionHash })) } : null,
          reconciliation: run?.reconciliation || null,
          gradedAt: entry.gradedAt,
        };
      }));
      json(response, 200, { schemaVersion: 1, network: "bsc-testnet", chainId: 97, pairCount: pairs.length, requiredForTermix: 3, pairs, note: "Time, cost, and quality are reported on both sides. A pair where the human wins a dimension is shown as a loss for the agent." });
      return;
    }
    if (url.pathname === "/api/compare") {
      const current = await snapshot();
      const ids = (url.searchParams.get("ids") || "").split("|").map((item) => decodeURIComponent(item)).filter(Boolean);
      json(response, 200, compareAgents(current.marketplace.agents, ids, url.searchParams.get("category") || null));
      return;
    }
    if (url.pathname === "/api/operator") {
      const current = await snapshot();
      const attempts = current.runs.filter((run) => run?.protocolJob?.funded === true).map((run) => ({ provider: run.agent?.identity, agentIdentity: run.agent?.identity, status: run.terminalState || run.protocolJob?.currentState?.toLowerCase() || "pending", costU: null, createdAt: run.createdAt }));
      json(response, 200, { network: "bsc-testnet", chainId: 97, scheduler: schedulerStatus({ attempts }), candidates: current.marketplace.agents.map((agent) => ({ identity: agent.identity, name: agent.name, status: agent.status, quarantine: agent.quarantine, trust: agent.trust })) });
      return;
    }
    if (url.pathname === "/api/hire/prepare") {
      const current = await snapshot();
      const identity = url.searchParams.get("identity");
      const agent = current.marketplace.agents.find((item) => item.identity === identity);
      if (!agent) { json(response, 404, { error: "Agent not found." }); return; }
      json(response, 200, { agent: { identity: agent.identity, name: agent.name }, review: agent.activation, status: agent.status, trust: agent.trust, note: agent.activation.selection.status === "ready" ? "This is a review step. A separate explicit confirmation is required before any testnet write." : agent.activation.selection.reason });
      return;
    }
    if (url.pathname === "/api/baseline/health-factor" && request.method === "GET") {
      const definition = await healthBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "HealthBench v1 has not been frozen." }); return; }
      const baseline = await humanBaseline();
      const packet = publicHealthBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: baseline?.status || "not_started", attemptId: baseline?.attemptId || null, sourceAvailable: baseline?.status === "started" };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/health-factor/start" && request.method === "POST") {
      const definition = await healthBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "HealthBench v1 has not been frozen." }); return; }
      const current = await humanBaseline();
      if (current?.status === "submitted") { json(response, 409, { status: "already_submitted", attemptId: current.attemptId }); return; }
      const attempt = current?.status === "started" ? current : createHumanBaselineAttempt({ benchmarkId: definition.benchmarkId });
      if (!current || current.status !== "started") await store.saveJson("state/health-baseline.json", attempt);
      const packet = publicHealthBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: "started", attemptId: attempt.attemptId, startedAt: attempt.startedAt, sourceAvailable: true };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/health-factor/source" && request.method === "GET") {
      const definition = await healthBenchDefinition();
      const baseline = await humanBaseline();
      if (!definition || baseline?.status !== "started") { json(response, 403, { status: "blocked", reason: "Start the human baseline before requesting the frozen raw source packet." }); return; }
      json(response, 200, publicHealthBenchSource(definition));
      return;
    }
    if (url.pathname === "/api/baseline/health-factor/submit" && request.method === "POST") {
      const definition = await healthBenchDefinition();
      const baseline = await humanBaseline();
      if (!definition || baseline?.status !== "started") { json(response, 403, { status: "blocked", reason: "A started human baseline is required." }); return; }
      const incoming = await readJsonBody(request);
      const completed = completeHumanBaseline({ attempt: baseline, submission: incoming.body, submittedAt: nowIso(), elapsedMs: Math.max(0, Date.now() - Date.parse(baseline.startedAt)) });
      completed.rawSubmissionJson = incoming.raw;
      completed.groundTruth = null;
      completed.agentOutput = null;
      await store.saveJson("state/health-baseline.json", completed);
      json(response, 200, { status: "submitted", attemptId: completed.attemptId, benchmarkId: completed.benchmarkId, submittedAt: completed.submittedAt, elapsedMs: completed.elapsedMs, preserved: true, evaluated: false, agentRun: "not_started" });
      return;
    }
    if (url.pathname.startsWith("/api/agents/")) {
      const current = await snapshot();
      const identity = decodeURIComponent(url.pathname.slice("/api/agents/".length));
      const agent = current.marketplace.agents.find((item) => item.identity === identity);
      if (!agent) { json(response, 404, { error: "Agent not found." }); return; }
      json(response, 200, agent);
      return;
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    if (error instanceof BadRequestError) {
      json(response, 400, { error: "bad_request", reason: error.message });
      return;
    }
    json(response, 500, { error: "The inspection data could not be loaded.", detail: error.message });
  }
});

server.listen(port, () => console.log(`Canned inspection server listening on http://localhost:${port}`));
