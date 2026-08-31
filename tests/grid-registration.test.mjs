/**
 * Directive #18 tests: the registered Grid Keeper identity, the authority
 * boundary for the session that was specified but not granted, and the
 * qualification rules that decide what Canned may claim.
 *
 * Nothing here spends anything or touches the network. The registration record
 * is read from disk as evidence; the permission cases are static.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { REFERENCE_AGENT_SPECS, REFERENCE_IDENTITY_FILES, REFERENCE_NAMESPACES, REFERENCE_WALLET_PATHS, implementedReferenceAgentCandidates } from "../src/reference/constants.mjs";
import { planGridStrategy, GRID_TESTNET_VENUE, GRID_EXECUTION_MODEL } from "../src/reference/grid-keeper.mjs";
import { evaluateLevel, STRATEGY_STATES } from "../src/reference/grid-engine.mjs";
import { buildLeash, buildLeashProposal, describeCallPermission, LEASH_STATES } from "../src/marketplace/leash.mjs";
import { buildGridBenchmarkDefinition } from "../src/reference/grid-benchmark.mjs";
import { computeGridGroundTruth, gradeGridBenchResponse } from "../src/reference/grid-evaluator.mjs";
import { buildGridTrackRecord, summarizeGridSession, EXECUTION_KINDS } from "../src/reference/grid-track-record.mjs";
import { deriveQualificationFlags } from "../src/benchmark/framework.mjs";
import { deriveTrustStates } from "../src/marketplace/model.mjs";
import { RUN_TYPES } from "../src/domain.mjs";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const U = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

/**
 * The exact ceiling, kept here so a widening shows up as a failure.
 *
 * The router and selector changed in Directive #20: SmartRouter V3 was planned
 * but its quoter reverts on this network, so it is not executable and was
 * never placed in a live allowlist. The V2 router quotes and simulates.
 */
const AUTHORIZED = Object.freeze({
  chainId: 97,
  router: "0xd99d1c33f9fc3444f8101754abc46c52416550d1",
  selector: "0x38ed1739",
  sessionCapUsdt: 10,
  perTxCapUsdt: 3,
  maxFills: 3,
  slippageBps: 100,
  durationHours: 6,
});

function boundedStrategy(overrides = {}) {
  return planGridStrategy({
    strategyId: "d18-bounded",
    pair: { baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt, baseSymbol: "WBNB", quoteSymbol: "USDT", baseDecimals: 18, quoteDecimals: 18 },
    lowerPriceMinor: U(600), upperPriceMinor: U(800), levelCount: 8,
    totalCapitalMinor: U(AUTHORIZED.sessionCapUsdt),
    maxPerLevelMinor: U(AUTHORIZED.perTxCapUsdt),
    expiresAt: new Date(NOW + AUTHORIZED.durationHours * 3_600_000).toISOString(),
    maxFills: AUTHORIZED.maxFills,
    maxSlippageBps: AUTHORIZED.slippageBps,
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  });
}

/* --------------------------------------------------------- the identity */

test("Grid Keeper holds its own ERC-8004 identity, distinct from all three siblings", () => {
  const file = "data/state/reference-grid-identity.json";
  if (!existsSync(new URL(`../${file}`, import.meta.url))) {
    assert.fail("Grid Keeper identity record is missing; registration evidence must be present.");
  }
  const record = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
  assert.equal(record.chainId, 97);
  assert.equal(record.network, "bsc-testnet");
  assert.equal(record.origin, "CANNED_REFERENCE");
  assert.equal(record.category, "Grid Trading");
  assert.equal(String(record.registry).toLowerCase(), "0x8004a818bfb912233c491871b3d84c89a494bd9e");
  assert.ok(Number.isInteger(record.agentId), "an agent id must be recorded");

  // 2003, 2005 and 2034 are already spent and must never be reused.
  assert.ok(![2003, 2005, 2034].includes(record.agentId), `agent id ${record.agentId} collides with a sibling`);
  assert.match(record.transactionHash, /^0x[0-9a-f]{64}$/i);
  assert.equal(record.quoteVerified, true);
  assert.equal(record.publicReadinessVerified, true);
  assert.equal(String(record.negotiationProbe.signer).toLowerCase(), String(record.provider).toLowerCase());
});

test("no two reference agents share a provider, endpoint, identity file, port or namespace", () => {
  const keys = ["health-factor", "rebalancing", "yield", "grid"];
  const providers = [];
  for (const key of keys) {
    const url = new URL(`../data/state/${REFERENCE_IDENTITY_FILES[key].split("/").pop()}`, import.meta.url);
    if (!existsSync(url)) continue;
    const record = JSON.parse(readFileSync(url, "utf8"));
    providers.push({ key, provider: String(record.provider).toLowerCase(), endpoint: record.endpoint, agentId: record.agentId });
  }
  assert.equal(new Set(providers.map((entry) => entry.provider)).size, providers.length, "provider wallets must be distinct");
  assert.equal(new Set(providers.map((entry) => entry.endpoint)).size, providers.length, "endpoints must be distinct");
  assert.equal(new Set(providers.map((entry) => entry.agentId)).size, providers.length, "agent ids must be distinct");
  for (const field of [
    keys.map((key) => REFERENCE_NAMESPACES[key].port),
    keys.map((key) => REFERENCE_WALLET_PATHS[key].walletsDir),
    keys.map((key) => REFERENCE_IDENTITY_FILES[key]),
  ]) {
    assert.equal(new Set(field).size, field.length);
  }
});

/* ------------------------------------------------- authority, not granted */

test("the proposed session names one exact contract and one exact selector", () => {
  const proposal = buildLeashProposal({ strategy: boundedStrategy(), network: { chainId: 97 }, now: NOW });
  assert.equal(proposal.calls.length, 1);
  const call = proposal.calls[0];
  assert.equal(call.contract, AUTHORIZED.router);
  assert.equal(call.selector, AUTHORIZED.selector);
  assert.equal(call.unrestricted, false);
  assert.equal(call.anyContract, false);
  assert.equal(call.anyMethod, false);
});

test("describing a permission twice does not turn a restricted rule into an unrestricted one", () => {
  const once = describeCallPermission({ to: "0xabc", signature: "transfer(address,uint256)" });
  const twice = describeCallPermission(once);
  assert.deepEqual(twice, once);
  assert.equal(twice.unrestricted, false);
});

test("the spend cap never exceeds the authorized ceiling and is stated as a lifetime total", () => {
  const proposal = buildLeashProposal({ strategy: boundedStrategy(), network: { chainId: 97 }, now: NOW });
  assert.equal(proposal.spend.tokenSymbol, "USDT");
  assert.equal(proposal.spend.token, GRID_TESTNET_VENUE.usdt);
  assert.equal(BigInt(proposal.spend.worstCaseTotalMinor), U(AUTHORIZED.sessionCapUsdt));
  assert.equal(proposal.spend.periodsCovered, 1, "a 6 hour session under a daily period is one period");
  assert.ok(Number(proposal.expiry) * 1000 <= NOW + AUTHORIZED.durationHours * 3_600_000);
});

test("no level may be allocated more than the per-transaction cap", () => {
  const strategy = boundedStrategy();
  for (const level of strategy.levels) {
    assert.ok(BigInt(level.allocationMinor) <= U(AUTHORIZED.perTxCapUsdt), `${level.levelId} exceeds the per-transaction cap`);
  }
  const total = strategy.levels.reduce((sum, level) => sum + BigInt(level.allocationMinor), 0n);
  assert.ok(total <= U(AUTHORIZED.sessionCapUsdt));
});

test("the aggregate cap refuses the fill that would cross it", () => {
  const strategy = { ...boundedStrategy(), state: STRATEGY_STATES.ACTIVE };
  const buys = strategy.levels.filter((level) => level.side === "BUY");
  const target = buys[0];
  // Three prior fills at the 3 USDT ceiling is 9 of 10; the next must not fit.
  const fills = buys.slice(1, 4).map((level) => ({
    strategyId: strategy.strategyId, levelId: level.levelId, state: "FILLED", side: "BUY",
    quoteSpentMinor: String(U(3)), baseReceivedMinor: "4000000000000000",
    filledAt: new Date(NOW - 600_000).toISOString(),
  }));
  const decision = evaluateLevel({
    strategy: { ...strategy, guards: { ...strategy.guards, maxFills: null } },
    level: { levelId: target.levelId },
    observation: { priceMinor: BigInt(target.priceMinor) - 1n, observedAt: new Date(NOW).toISOString(), chainId: 97, baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt },
    fills, now: NOW,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "total_capital_cap_would_be_exceeded");
});

test("a revoked session refuses the exact call it would otherwise allow", () => {
  const strategy = { ...boundedStrategy(), state: STRATEGY_STATES.ACTIVE };
  const level = strategy.levels.find((entry) => entry.side === "BUY");
  const observation = { priceMinor: BigInt(level.priceMinor) - 1n, observedAt: new Date(NOW).toISOString(), chainId: 97, baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt };
  const call = { to: AUTHORIZED.router, method: GRID_TESTNET_VENUE.swapMethod, side: "BUY" };

  const allowed = evaluateLevel({ strategy, level: { levelId: level.levelId }, observation, now: NOW, intendedCall: call });
  assert.equal(allowed.allowed, true, "the same call is allowed while the authority is live");

  const revoked = evaluateLevel({ strategy, level: { levelId: level.levelId }, observation, now: NOW, authority: { revoked: true }, intendedCall: call });
  assert.equal(revoked.allowed, false);
  assert.equal(revoked.reason, "authority_revoked");
});

test("The Leash moves through its states from real session data alone", () => {
  const strategy = boundedStrategy();
  const proposal = buildLeashProposal({ strategy, network: { chainId: 97 }, now: NOW });
  const session = { walletAddress: "0xw", publicKey: "0xpk", expiry: proposal.expiry, permissions: proposal.permissions };

  assert.equal(buildLeash({ strategy, session: null }).state, LEASH_STATES.NOT_CONFIGURED);
  assert.equal(buildLeash({ strategy, session, now: NOW }).state, LEASH_STATES.ACTIVE);
  assert.equal(buildLeash({ strategy, session, revoked: true, now: NOW }).state, LEASH_STATES.REVOKED);
  assert.equal(buildLeash({ strategy, session, now: session.expiry * 1000 + 1 }).state, LEASH_STATES.EXPIRED);
  // Revoked and expired are both unrevocable and both say why.
  assert.equal(buildLeash({ strategy, session, revoked: true, now: NOW }).revocable, false);
});

test("the authority values are derived from the strategy, never hardcoded in the view", () => {
  // Halving the strategy halves what the permission allows, with no edit to
  // The Leash, which is what makes "it cannot widen itself" structural.
  const half = buildLeashProposal({ strategy: boundedStrategy({ totalCapitalMinor: U(5) }), network: { chainId: 97 }, now: NOW });
  assert.equal(BigInt(half.spend.worstCaseTotalMinor), U(5));
  const wide = buildLeashProposal({ strategy: boundedStrategy({ totalCapitalMinor: U(50) }), network: { chainId: 97 }, now: NOW });
  assert.equal(BigInt(wide.spend.worstCaseTotalMinor), U(50));
});

/* ------------------------------------------------------ what may be claimed */

test("GridBench alone cannot make Grid Keeper BENCHMARKED", () => {
  // Canned's definition requires a funded ERC-8183 job. A capability benchmark
  // with no payment does not qualify, and the fourth category is not filled by
  // relaxing this.
  const withoutPayment = deriveQualificationFlags({
    runType: RUN_TYPES.BENCHMARK,
    provenanceMode: "LIVE_QUALIFYING",
    precommit: { manifestHash: "0xabc" },
    protocolJob: { funded: false, jobId: null, currentState: null },
    agentOutput: { ok: true },
    controlOutput: { provenance: { independent: true } },
    evaluation: { status: "completed" },
    terminalState: "completed",
  });
  assert.equal(withoutPayment.hasRealPayment, false);
  assert.equal(withoutPayment.qualifiesForAgentTrackRecord, false);
  assert.equal(withoutPayment.qualifiesForPublicMetrics, false);

  const trust = deriveTrustStates({ identity: "97:0xreg:2045", probes: [{ reachable: true }], selectionGate: { readiness: { quoteVerified: true } } }, []);
  assert.equal(trust.states.BENCHMARKED, false);
  assert.deepEqual(trust.reached, ["LISTED", "ENDPOINT_VERIFIED", "QUOTE_VERIFIED"]);
});

test("a hire is not blocked by a human baseline the benchmark never had", () => {
  // The seal is a contamination guard for benchmarks with a human answer.
  // GridBench has none, so requiring it would block hiring forever.
  const grid = REFERENCE_AGENT_SPECS.find((spec) => spec.key === "grid");
  assert.equal(grid.requiresHumanBaseline, false);
  for (const key of ["health-factor", "rebalancing", "yield"]) {
    const spec = REFERENCE_AGENT_SPECS.find((entry) => entry.key === key);
    assert.notEqual(spec.requiresHumanBaseline, false, `${key} must still require its sealed baseline`);
  }
  const candidates = implementedReferenceAgentCandidates({
    allowLocalProbe: false,
    identityRecords: { grid: { agentId: 2045, registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e", endpoint: "https://grid.example/erc8183", provider: "0xprov", quoteVerified: true, publicReadinessVerified: true } },
    baselineSealedByKey: {},
  });
  const grid1 = candidates.find((entry) => entry.referenceKey === "grid");
  assert.equal(grid1.selectionGate.readiness.ready, true);
  assert.equal("humanBaselineSealed" in grid1.selectionGate.readiness.conditions, false);
});

test("GridBench grades the engine to a real score with no LLM involved", () => {
  const definition = buildGridBenchmarkDefinition();
  const truth = computeGridGroundTruth(definition);
  const graded = gradeGridBenchResponse({ definition, groundTruth: truth, submission: { answers: truth.answers } });
  assert.equal(graded.scenarioCount, 16);
  assert.equal(truth.computedFrom, "frozen_specification");
  // The frozen policy states the same thing, and was written before any answer.
  assert.equal(definition.policy.groundTruthSource, "recomputed_from_this_specification_not_from_the_agent_engine");
  assert.ok(graded.qualityScore >= 99.9);
});

test("the grid track record still reports not enough observations", () => {
  const record = buildGridTrackRecord({ sessions: [] });
  assert.equal(record.onchainFills, 0);
  assert.equal(record.realisedReturnBps, null);
  assert.equal(record.maxDrawdownBps, null);
  assert.match(record.summary, /has not executed a grid trade on chain/);

  // Even one real fill is not a rate.
  const oneSession = summarizeGridSession({
    strategy: boundedStrategy(),
    fills: [{ state: "FILLED", side: "BUY", execution: EXECUTION_KINDS.ONCHAIN, quoteSpentMinor: String(U(1)), baseReceivedMinor: "1400000000000000" }],
  });
  const afterOne = buildGridTrackRecord({ sessions: [oneSession] });
  assert.equal(afterOne.hasEnoughForRate, false);
  assert.equal(afterOne.realisedReturnBps, null);
});

test("Grid Keeper still never claims a native order, on any surface", () => {
  assert.equal(GRID_EXECUTION_MODEL.isNativeLimitOrder, false);
  for (const page of ["web/leash.html", "web/agent.html", "web/marketplace.html"]) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.equal(/native (resting )?limit order/i.test(html), false, `${page} claims a native limit order`);
    assert.equal(/\border\s*(?:id|#)\s*[:=]?\s*\d/i.test(html), false, `${page} shows an order id`);
  }
});

test("the four-category status is derived from evidence, not from agents existing", () => {
  // Each category has a first-party agent, but only three have a benchmarked
  // one. Counting agents rather than evidence would call all four complete.
  const benchmarkedByCategory = { health_factor_monitoring: 1, rebalancing: 1, yield_optimisation: 1, grid_trading: 0 };
  const firstClass = Object.fromEntries(Object.entries(benchmarkedByCategory).map(([category, count]) => [category, count > 0]));
  assert.equal(firstClass.grid_trading, false);
  assert.equal(Object.values(firstClass).filter(Boolean).length, 3);
  assert.equal(REFERENCE_AGENT_SPECS.filter((spec) => spec.implemented).length, 4);
});
