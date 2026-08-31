/**
 * Directive #17 tests: the egress guard, the claim limiter, the grid engine,
 * The Leash, GridBench, and the grid track record.
 *
 * Nothing here touches the network or spends anything. The DNS resolver and
 * the request path are injected, so the rebinding defence is tested without a
 * rebinding server, and every grid decision is pure arithmetic over frozen
 * inputs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isPrivateAddress, isPrivateHostname, assertPublicUrl,
  resolvePublicAddresses, checkEgressTarget, safeFetch, EGRESS_ERRORS,
} from "../src/net/egress-guard.mjs";
import { SlidingWindowLimiter, RATE_LIMITS, clientKey } from "../src/net/rate-limit.mjs";
import {
  createStrategy, buildGridLevels, allocateCapital, evaluateLevel, evaluateStrategy,
  deriveLedger, minimumOut, transitionStrategy, STRATEGY_STATES, SIDES, GRID_REFUSALS,
} from "../src/reference/grid-engine.mjs";
import {
  buildLeash, buildLeashProposal, proposeSessionPermissions, describeCallPermission,
  worstCaseSpend, smallestCoveringPeriod, LEASH_STATES,
} from "../src/marketplace/leash.mjs";
import { buildGridBenchmarkDefinition, publicGridBenchPacket, GRID_FROZEN_MARKET } from "../src/reference/grid-benchmark.mjs";
import { computeGridGroundTruth, gradeGridBenchResponse, groundTruthLevels } from "../src/reference/grid-evaluator.mjs";
import { summarizeGridSession, buildGridTrackRecord, EXECUTION_KINDS, MIN_SESSIONS_FOR_RATE } from "../src/reference/grid-track-record.mjs";
import { buildGridKeeperDeliverable, planGridStrategy, GRID_EXECUTION_MODEL, GRID_TESTNET_VENUE } from "../src/reference/grid-keeper.mjs";
import { REFERENCE_NAMESPACES, REFERENCE_WALLET_PATHS, REFERENCE_IDENTITY_FILES, REFERENCE_AGENT_SPECS } from "../src/reference/constants.mjs";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const U = (whole) => BigInt(whole) * 10n ** 18n;

function strategy(overrides = {}) {
  return createStrategy({
    strategyId: "T1",
    chainId: 97,
    pair: { baseToken: "0xAAA", quoteToken: "0xBBB", baseSymbol: "WBNB", quoteSymbol: "USDT" },
    lowerPriceMinor: U(600), upperPriceMinor: U(800), levelCount: 9,
    totalCapitalMinor: U(400), maxPerLevelMinor: U(100),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    // The full signature, as production uses: a bare name has no selector.
    allowedContracts: ["0xrouter"], allowedMethods: ["exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))"],
    createdAt: new Date(NOW).toISOString(),
    ...overrides,
  });
}

const active = (overrides) => ({ ...strategy(overrides), state: STRATEGY_STATES.ACTIVE });

function observation(price, { ageMs = 0, chainId = 97, baseToken = "0xaaa", quoteToken = "0xbbb" } = {}) {
  return { priceMinor: U(price), observedAt: new Date(NOW - ageMs).toISOString(), chainId, baseToken, quoteToken };
}

function buyFill(levelId, spend, received, agoMs = 300_000) {
  return { strategyId: "T1", levelId, state: "FILLED", side: SIDES.BUY, quoteSpentMinor: String(U(spend)), baseReceivedMinor: String(received), filledAt: new Date(NOW - agoMs).toISOString() };
}

/* ------------------------------------------------------------ egress guard */

test("every address that reaches something other than the public internet is refused", () => {
  for (const address of [
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1",
    // An IPv4-mapped IPv6 address reaches the same metadata service.
    "::ffff:169.254.169.254", "::ffff:127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} must be refused`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `${address} must be allowed`);
  }
});

test("internal hostnames and bare names are refused before any lookup", () => {
  for (const host of ["localhost", "app.localhost", "printer.local", "svc.internal", "db.lan", "host.corp", "intranet", "wiki"]) {
    assert.equal(isPrivateHostname(host), true, `${host} must be refused`);
  }
  assert.equal(isPrivateHostname("example.com"), false);
  // A trailing dot is the same name, and must not slip past the rule.
  assert.equal(isPrivateHostname("localhost."), true);
});

test("only http and https survive the scheme check", () => {
  assert.equal(assertPublicUrl("https://example.com/a").ok, true);
  assert.equal(assertPublicUrl("http://example.com/a").ok, true);
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "gopher://example.com"]) {
    assert.equal(assertPublicUrl(url).error, EGRESS_ERRORS.BAD_SCHEME, url);
  }
  assert.equal(assertPublicUrl("not a url").error, EGRESS_ERRORS.BAD_URL);
});

test("a public name that resolves to a private address is refused", async () => {
  // This is the DNS rebinding case the old hostname-only check let through.
  const resolver = async () => [{ address: "169.254.169.254", family: 4 }];
  const result = await checkEgressTarget("https://totally-normal.example.com/", { resolver });
  assert.equal(result.ok, false);
  assert.equal(result.error, EGRESS_ERRORS.PRIVATE_ADDRESS);
  assert.equal(result.offending, "169.254.169.254");
});

test("one private answer among several rejects the whole name", async () => {
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
  const result = await resolvePublicAddresses("mixed.example.com", { resolver });
  assert.equal(result.ok, false);
  assert.equal(result.offending, "10.0.0.5");
});

test("a host that does not resolve is refused rather than attempted", async () => {
  const resolver = async () => { throw new Error("NXDOMAIN"); };
  const result = await checkEgressTarget("https://nowhere.example.com/", { resolver });
  assert.equal(result.error, EGRESS_ERRORS.UNRESOLVABLE);
});

test("a redirect into a private address is refused at the hop that redirects", async () => {
  const resolver = async (host) => host === "hop1.example.com"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "169.254.169.254", family: 4 }];
  let reachedMetadata = false;
  const requestImpl = async (url) => {
    if (url.hostname === "hop1.example.com") {
      return { status: 302, headers: { get: (name) => (name === "location" ? "http://169.254.169.254/latest/meta-data/" : null) }, text: async () => "" };
    }
    reachedMetadata = true;
    return { status: 200, headers: { get: () => null }, text: async () => "secrets" };
  };
  const result = await safeFetch("https://hop1.example.com/", { resolver, requestImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, EGRESS_ERRORS.REDIRECT_BLOCKED);
  // The important assertion: the second request never happened.
  assert.equal(reachedMetadata, false);
});

test("the connection is pinned to the address that was checked", async () => {
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  let pinned = null;
  const requestImpl = async (_url, options) => {
    pinned = options.pinnedAddress;
    return { status: 200, headers: { get: () => null }, text: async () => "ok" };
  };
  const result = await safeFetch("https://example.com/", { resolver, requestImpl });
  assert.equal(result.ok, true);
  // Without this the name would be resolved a second time by the socket.
  assert.equal(pinned, "93.184.216.34");
});

/* -------------------------------------------------------------- rate limit */

test("claim challenges are limited per address and per client", () => {
  const limiter = new SlidingWindowLimiter();
  const limit = RATE_LIMITS.challengePerAddress.limit;
  let refusedAt = null;
  for (let attempt = 1; attempt <= limit + 3; attempt += 1) {
    const result = limiter.check([["challengePerAddress", "0xabc"]], NOW);
    if (!result.allowed && refusedAt === null) refusedAt = attempt;
  }
  assert.equal(refusedAt, limit + 1);
});

test("a rotating client cannot escape the per-target limit", () => {
  const limiter = new SlidingWindowLimiter();
  const limit = RATE_LIMITS.challengePerIdentity.limit;
  let refused = false;
  for (let attempt = 1; attempt <= limit + 2; attempt += 1) {
    // A different IP every time, which is what a proxy pool looks like.
    const result = limiter.check([["challengePerIp", `10.0.0.${attempt}`], ["challengePerIdentity", "97:0xreg:1"]], NOW);
    if (!result.allowed) refused = true;
  }
  assert.equal(refused, true);
});

test("verification is capped harder than issuance, because a challenge is single use", () => {
  assert.ok(RATE_LIMITS.verifyPerIdentity.limit < RATE_LIMITS.challengePerIdentity.limit);
});

test("the window slides, so an honest user is not locked out forever", () => {
  const limiter = new SlidingWindowLimiter();
  const rule = RATE_LIMITS.challengePerAddress;
  for (let attempt = 0; attempt <= rule.limit; attempt += 1) limiter.check([["challengePerAddress", "0xabc"]], NOW);
  assert.equal(limiter.check([["challengePerAddress", "0xabc"]], NOW).allowed, false);
  assert.equal(limiter.check([["challengePerAddress", "0xabc"]], NOW + rule.windowMs + 1).allowed, true);
});

test("the limiter is bounded and refuses rather than growing without limit", () => {
  const limiter = new SlidingWindowLimiter({ maxKeys: 4 });
  for (let index = 0; index < 4; index += 1) limiter.hit("challengePerIp", `10.0.0.${index}`, NOW);
  const result = limiter.hit("challengePerIp", "10.0.0.99", NOW);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "limiter_saturated");
});

test("a forwarded header is only believed when the deployment says so", () => {
  const request = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.7" } };
  assert.equal(clientKey(request, { trustProxy: false }), "10.0.0.7");
  assert.equal(clientKey(request, { trustProxy: true }), "1.2.3.4");
});

/* ------------------------------------------------------------ grid maths */

test("grid levels are strictly increasing and split at the reference price", () => {
  const levels = buildGridLevels({ strategyId: "T1", lowerPriceMinor: U(600), upperPriceMinor: U(800), levelCount: 9, referencePriceMinor: U(700) });
  assert.equal(levels.length, 9);
  assert.deepEqual(levels.map((level) => Number(level.priceMinor / 10n ** 18n)), [600, 625, 650, 675, 700, 725, 750, 775, 800]);
  for (let index = 1; index < levels.length; index += 1) {
    assert.ok(levels[index].priceMinor > levels[index - 1].priceMinor, "levels must strictly increase");
  }
  assert.deepEqual(levels.filter((level) => level.side === SIDES.BUY).map((level) => level.index), [0, 1, 2, 3]);
  // Level ids are stable, which is what makes a fill non-repeatable.
  assert.equal(levels[0].levelId, "T1:L00");
});

test("geometric spacing keeps equal ratios and still never collapses", () => {
  const levels = buildGridLevels({ strategyId: "T1", lowerPriceMinor: U(100), upperPriceMinor: U(800), levelCount: 4, spacing: "geometric", referencePriceMinor: U(400) });
  assert.equal(levels.length, 4);
  assert.equal(levels[0].priceMinor, U(100));
  assert.equal(levels[3].priceMinor, U(800));
  for (let index = 1; index < levels.length; index += 1) assert.ok(levels[index].priceMinor > levels[index - 1].priceMinor);
});

test("a grid that would collapse is refused instead of producing duplicate levels", () => {
  assert.throws(() => buildGridLevels({ strategyId: "T1", lowerPriceMinor: 100n, upperPriceMinor: 103n, levelCount: 50 }), /collapsed/);
  assert.throws(() => buildGridLevels({ strategyId: "T1", lowerPriceMinor: U(800), upperPriceMinor: U(600), levelCount: 4 }), /above/);
  assert.throws(() => buildGridLevels({ strategyId: "T1", lowerPriceMinor: U(1), upperPriceMinor: U(2), levelCount: 1 }), /between/);
});

test("allocations never sum above the total cap", () => {
  const levels = allocateCapital({
    levels: buildGridLevels({ strategyId: "T1", lowerPriceMinor: U(600), upperPriceMinor: U(800), levelCount: 9, referencePriceMinor: U(700) }),
    totalCapitalMinor: U(400), maxPerLevelMinor: U(100),
  });
  const total = levels.reduce((sum, level) => sum + level.allocationMinor, 0n);
  assert.ok(total <= U(400), `${total} must not exceed the cap`);
  // Sell levels deploy no quote capital.
  assert.ok(levels.filter((level) => level.side === SIDES.SELL).every((level) => level.allocationMinor === 0n));
});

test("a strategy is content addressed, so it cannot be widened after approval", () => {
  const first = strategy();
  const second = strategy();
  assert.equal(first.hashes.sha256, second.hashes.sha256);
  const wider = strategy({ totalCapitalMinor: U(4000) });
  assert.notEqual(wider.hashes.sha256, first.hashes.sha256);
});

test("a strategy must name the contracts and methods it may call", () => {
  assert.throws(() => strategy({ allowedContracts: [] }), /contracts it may call/);
  assert.throws(() => strategy({ allowedMethods: [] }), /methods it may call/);
  assert.throws(() => strategy({ maxSlippageBps: 5000 }), /maxSlippageBps/);
});

/* ------------------------------------------------------- the refusal paths */

test("a level executes only when the market actually reached it", () => {
  const grid = active();
  const level = { levelId: "T1:L02" }; // 650, a buy level
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(649), now: NOW }).allowed, true);
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(650), now: NOW }).allowed, true, "reaching the level counts");
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(660), now: NOW }).reason, GRID_REFUSALS.NOT_TRIGGERED);
});

test("a level cannot fill twice", () => {
  const grid = active();
  const fills = [buyFill("T1:L02", 100, "153000000000000000")];
  const decision = evaluateLevel({ strategy: grid, level: { levelId: "T1:L02" }, observation: observation(649), fills, now: NOW });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, GRID_REFUSALS.ALREADY_FILLED);
});

test("the total capital cap is enforced against what was actually spent", () => {
  const grid = active({ totalCapitalMinor: U(350) });
  const fills = ["T1:L01", "T1:L02", "T1:L03"].map((levelId) => buyFill(levelId, 100, "150000000000000000"));
  const decision = evaluateLevel({ strategy: grid, level: { levelId: "T1:L00" }, observation: observation(599), fills, now: NOW });
  assert.equal(decision.reason, GRID_REFUSALS.TOTAL_CAP);
});

test("expiry, revocation and an inactive strategy each stop execution", () => {
  const level = { levelId: "T1:L02" };
  const obs = observation(649);
  assert.equal(evaluateLevel({ strategy: strategy(), level, observation: obs, now: NOW }).reason, GRID_REFUSALS.NOT_ACTIVE);
  assert.equal(evaluateLevel({ strategy: active(), level, observation: obs, now: NOW + 7_200_000 }).reason, GRID_REFUSALS.EXPIRED);
  assert.equal(evaluateLevel({ strategy: active(), level, observation: obs, now: NOW, authority: { revoked: true } }).reason, GRID_REFUSALS.REVOKED);
  // An authority that expired independently of the strategy also stops it.
  assert.equal(evaluateLevel({ strategy: active(), level, observation: obs, now: NOW, authority: { expiresAtMs: NOW - 1 } }).reason, GRID_REFUSALS.EXPIRED);
});

test("a stale, missing, wrong-chain or wrong-pair price stops execution", () => {
  const grid = active();
  const level = { levelId: "T1:L02" };
  assert.equal(evaluateLevel({ strategy: grid, level, observation: null, now: NOW }).reason, GRID_REFUSALS.NO_PRICE);
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(649, { ageMs: 600_000 }), now: NOW }).reason, GRID_REFUSALS.STALE_PRICE);
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(649, { chainId: 56 }), now: NOW }).reason, GRID_REFUSALS.WRONG_CHAIN);
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(649, { baseToken: "0xzzz" }), now: NOW }).reason, GRID_REFUSALS.WRONG_PAIR);
  // A price observation from the future is not fresh, it is wrong.
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(649, { ageMs: -60_000 }), now: NOW }).reason, GRID_REFUSALS.STALE_PRICE);
});

test("the call itself must match the allowlist and the slippage floor", () => {
  const grid = active();
  const level = { levelId: "T1:L02" };
  const obs = observation(649);
  const base = { to: "0xrouter", method: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))" };
  assert.equal(evaluateLevel({ strategy: grid, level, observation: obs, now: NOW, intendedCall: { ...base, to: "0xevil" } }).reason, GRID_REFUSALS.WRONG_CONTRACT);
  assert.equal(evaluateLevel({ strategy: grid, level, observation: obs, now: NOW, intendedCall: { ...base, method: "transferFrom" } }).reason, GRID_REFUSALS.WRONG_METHOD);
  assert.equal(evaluateLevel({ strategy: grid, level, observation: obs, now: NOW, intendedCall: { ...base, side: SIDES.SELL } }).reason, GRID_REFUSALS.WRONG_DIRECTION);
  assert.equal(evaluateLevel({ strategy: grid, level, observation: obs, now: NOW, intendedCall: { ...base, quotedOutMinor: 90n, minOutMinor: 100n } }).reason, GRID_REFUSALS.SLIPPAGE);
});

test("a sell needs inventory, so the grid cannot open a short", () => {
  const grid = active();
  const level = { levelId: "T1:L08" }; // 800, a sell level
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(801), now: NOW }).reason, GRID_REFUSALS.INSUFFICIENT_INVENTORY);
  const fills = [buyFill("T1:L02", 100, "153000000000000000")];
  assert.equal(evaluateLevel({ strategy: grid, level, observation: observation(801), fills, now: NOW }).allowed, true);
});

test("fill count and cooldown limits are honoured", () => {
  const fills = [buyFill("T1:L02", 100, "153000000000000000", 10_000)];
  const level = { levelId: "T1:L01" };
  const obs = observation(624);
  assert.equal(evaluateLevel({ strategy: active({ maxFills: 1 }), level, observation: obs, fills, now: NOW }).reason, GRID_REFUSALS.MAX_FILLS);
  assert.equal(evaluateLevel({ strategy: active({ cooldownMs: 60_000 }), level, observation: obs, fills, now: NOW }).reason, GRID_REFUSALS.COOLDOWN);
});

test("an unknown level is refused rather than invented", () => {
  assert.equal(evaluateLevel({ strategy: active(), level: { levelId: "T1:L99" }, observation: observation(649), now: NOW }).reason, GRID_REFUSALS.LEVEL_UNKNOWN);
});

test("one price observation produces at most one action", () => {
  // Price collapses below every buy level at once. A grid that fired them all
  // would turn a single move into a cascade of trades.
  const evaluation = evaluateStrategy({ strategy: active(), observation: observation(500), now: NOW });
  assert.ok(evaluation.eligible.length > 1, "several levels are genuinely eligible");
  assert.equal(evaluation.nextAction.levelId, "T1:L00");
  assert.ok(Array.isArray(evaluation.refused));
});

test("the ledger is derived from fills, and a sell reduces inventory", () => {
  const grid = active();
  const fills = [
    buyFill("T1:L02", 100, "153000000000000000"),
    { strategyId: "T1", levelId: "T1:L08", state: "FILLED", side: SIDES.SELL, quoteReceivedMinor: String(U(120)), baseSoldMinor: "153000000000000000", filledAt: new Date(NOW - 1000).toISOString() },
  ];
  const ledger = deriveLedger(grid, fills);
  assert.equal(ledger.fillCount, 2);
  assert.equal(ledger.baseInventoryMinor, 0n);
  // Sold for more than it cost, so net deployed capital is negative.
  assert.equal(ledger.netQuoteSpentMinor, U(100) - U(120));
});

test("minimum output falls with the slippage allowance", () => {
  assert.equal(minimumOut(1000n, 0), 1000n);
  assert.equal(minimumOut(1000n, 100), 990n);   // 1%
  assert.equal(minimumOut(1000n, 50), 995n);
});

test("a terminal strategy never returns to active", () => {
  const revoked = transitionStrategy(active(), STRATEGY_STATES.REVOKED);
  assert.equal(revoked.state, STRATEGY_STATES.REVOKED);
  assert.throws(() => transitionStrategy(revoked, STRATEGY_STATES.ACTIVE), /cannot move/);
  assert.throws(() => transitionStrategy(revoked, STRATEGY_STATES.ARMED), /cannot move/);
});

/* ---------------------------------------------------------------- The Leash */

test("no session means NOT_CONFIGURED, never an empty permission", () => {
  const leash = buildLeash({ strategy: strategy(), session: null });
  assert.equal(leash.state, LEASH_STATES.NOT_CONFIGURED);
  assert.equal(leash.contracts.length, 0);
  assert.equal(leash.spend, null);
  assert.equal(leash.revocable, false);
  assert.match(leash.summary, /no permission to act/);
});

test("the proposed permission names one exact contract and one exact method", () => {
  const proposed = proposeSessionPermissions({ strategy: strategy(), now: NOW });
  assert.equal(proposed.permissions.calls.length, 1);
  assert.equal(proposed.permissions.calls[0].to, "0xrouter");
  assert.equal(proposed.permissions.calls[0].signature, "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))");
  assert.equal(proposed.permissions.spend.length, 1);
  assert.equal(proposed.permissions.spend[0].token, "0xbbb");
  // Never wider than the strategy it came from.
  assert.equal(proposed.permissions.spend[0].limit, U(400));
});

test("a permission with no contract or no method is reported as unrestricted", () => {
  assert.equal(describeCallPermission({ to: "0xabc" }).unrestricted, true, "any method");
  // A signature that cannot be resolved to a selector fails closed: it is not
  // provably narrow, so it is reported as unrestricted rather than throwing.
  const unresolvable = describeCallPermission({ to: "0xabc", signature: "notASignature" });
  assert.equal(unresolvable.selectorResolved, false);
  assert.equal(unresolvable.unrestricted, true);
  assert.equal(describeCallPermission({ signature: "transfer(address,uint256)" }).unrestricted, true, "any contract");
  const exact = describeCallPermission({ to: "0xabc", signature: "transfer(address,uint256)" });
  assert.equal(exact.unrestricted, false);
  assert.equal(exact.selector, "0xa9059cbb");
});

test("a rolling spend cap is reported as what it really allows over the session", () => {
  // The number a user needs is the lifetime ceiling, not the per-period one.
  const overThreeDays = worstCaseSpend({ limit: 10n, period: "day" }, { durationMs: 3 * 86_400_000 });
  assert.equal(overThreeDays.periods, 3);
  assert.equal(overThreeDays.worstCaseTotalMinor, 30n);
  // Choosing a period that covers the session makes one cap one total.
  assert.equal(smallestCoveringPeriod(6 * 3_600_000), "day");
  assert.equal(smallestCoveringPeriod(3 * 86_400_000), "week");
});

test("the leash reads ACTIVE, EXPIRED and REVOKED from the real session", () => {
  const grid = strategy();
  const proposal = buildLeashProposal({ strategy: grid, network: { chainId: 97, keyStore: "0xks", explorer: "https://x" }, now: NOW });
  const session = { walletAddress: "0xw", publicKey: "0xpk", expiry: proposal.expiry, permissions: proposal.permissions };

  const live = buildLeash({ strategy: grid, session, now: NOW });
  assert.equal(live.state, LEASH_STATES.ACTIVE);
  assert.equal(live.revocable, true);
  assert.equal(live.unrestrictedRules.length, 0);
  assert.ok(live.cannot.some((line) => /Raise its own spending cap/.test(line)));
  assert.ok(live.cannot.some((line) => /Extend its own expiry/.test(line)));

  assert.equal(buildLeash({ strategy: grid, session, now: session.expiry * 1000 + 1 }).state, LEASH_STATES.EXPIRED);
  assert.equal(buildLeash({ strategy: grid, session, revoked: true, now: NOW }).state, LEASH_STATES.REVOKED);
  assert.equal(buildLeash({ strategy: grid, session, revoked: true, now: NOW }).revocable, false);
});

test("a leash proposal is hashed, so what was approved can be checked later", () => {
  const grid = strategy();
  const first = buildLeashProposal({ strategy: grid, network: { chainId: 97 }, now: NOW });
  const second = buildLeashProposal({ strategy: grid, network: { chainId: 97 }, now: NOW });
  assert.equal(first.hashes.sha256, second.hashes.sha256);
  const wider = buildLeashProposal({ strategy: strategy({ totalCapitalMinor: U(4000) }), network: { chainId: 97 }, now: NOW });
  assert.notEqual(wider.hashes.sha256, first.hashes.sha256);
});

/* ---------------------------------------------------------------- GridBench */

test("GridBench freezes a real market read and keeps answers out of the public packet", () => {
  const definition = buildGridBenchmarkDefinition();
  assert.equal(definition.precommit.sha256, buildGridBenchmarkDefinition().precommit.sha256, "definition is deterministic");
  assert.equal(GRID_FROZEN_MARKET.readOnly, true);
  assert.equal(GRID_FROZEN_MARKET.chainId, 56, "market data is a mainnet read");
  assert.equal(definition.strategy.chainId, 97, "execution stays on testnet");

  const packet = publicGridBenchPacket(definition);
  const serialised = JSON.stringify(packet);
  assert.ok(!serialised.includes("\"expect\""), "the answer key must not reach the public packet");
  assert.equal(packet.scenarios.length, definition.scenarios.length);
});

test("ground truth is recomputed from the specification and matches its stated intent", () => {
  const definition = buildGridBenchmarkDefinition();
  const truth = computeGridGroundTruth(definition);
  for (const scenario of definition.scenarios) {
    if (scenario.asks !== "decision") continue;
    const answer = truth.answers[scenario.id];
    assert.equal(answer.allowed, scenario.expect.allowed, `${scenario.id} verdict`);
    if (!scenario.expect.allowed) assert.equal(answer.reason, scenario.expect.reason, `${scenario.id} reason`);
  }
});

test("the independent evaluator agrees with the engine on every decision scenario", () => {
  // Two implementations of the same rules, written separately. Agreement is
  // evidence; a disagreement would be a finding rather than a rounding error.
  const definition = buildGridBenchmarkDefinition();
  const truth = computeGridGroundTruth(definition);
  const nowMs = Date.parse("2026-08-30T12:00:00.000Z");
  for (const scenario of definition.scenarios) {
    if (scenario.asks !== "decision") continue;
    const merged = { ...definition.strategy, ...(scenario.strategyOverride ?? {}) };
    const built = createStrategy({
      ...merged,
      lowerPriceMinor: BigInt(merged.lowerPriceMinor), upperPriceMinor: BigInt(merged.upperPriceMinor),
      totalCapitalMinor: BigInt(merged.totalCapitalMinor), maxPerLevelMinor: BigInt(merged.maxPerLevelMinor),
      referencePriceMinor: BigInt(merged.referencePriceMinor),
    });
    const decision = evaluateLevel({
      strategy: { ...built, state: STRATEGY_STATES.ACTIVE },
      level: { levelId: scenario.levelId }, observation: scenario.observation,
      fills: scenario.fills ?? [], now: nowMs,
      authority: scenario.authority ?? null, intendedCall: scenario.intendedCall ?? null,
    });
    const expected = truth.answers[scenario.id];
    assert.equal(decision.allowed, expected.allowed, `${scenario.id} verdict`);
    if (!expected.allowed) assert.equal(decision.reason, expected.reason, `${scenario.id} reason`);
  }
});

test("a right answer for the wrong reason scores nothing", () => {
  const definition = buildGridBenchmarkDefinition();
  const truth = computeGridGroundTruth(definition);
  const answers = {};
  for (const [id, answer] of Object.entries(truth.answers)) {
    // Refuse everything, always citing expiry. Most verdicts are right.
    answers[id] = answer.asks === "decision" ? { allowed: false, reason: "strategy_expired" } : {};
  }
  const graded = gradeGridBenchResponse({ definition, groundTruth: truth, submission: { answers } });
  const decisionScenarios = definition.scenarios.filter((scenario) => scenario.asks === "decision");
  const genuinelyExpired = decisionScenarios.filter((scenario) => truth.answers[scenario.id].reason === "strategy_expired").length;
  assert.equal(graded.passedCount, genuinelyExpired);
  assert.ok(graded.qualityScore < 20, `blanket refusal scored ${graded.qualityScore}`);
});

test("a perfect submission scores 100 and an empty one scores zero", () => {
  const definition = buildGridBenchmarkDefinition();
  const truth = computeGridGroundTruth(definition);
  const perfect = gradeGridBenchResponse({ definition, groundTruth: truth, submission: { answers: truth.answers } });
  assert.equal(perfect.passedCount, definition.scenarios.length);
  assert.ok(perfect.qualityScore >= 99.9, `scored ${perfect.qualityScore}`);

  const empty = gradeGridBenchResponse({ definition, groundTruth: truth, submission: { answers: {} } });
  assert.equal(empty.qualityScore, 0);
  assert.equal(empty.passedCount, 0);
});

test("the graded grid must be ordered, not merely the right set of prices", () => {
  const definition = buildGridBenchmarkDefinition();
  const truth = computeGridGroundTruth(definition);
  const shuffled = { ...truth.answers, "S01-construction": { asks: "grid_construction", levels: [...truth.answers["S01-construction"].levels].reverse() } };
  const graded = gradeGridBenchResponse({ definition, groundTruth: truth, submission: { answers: shuffled } });
  const construction = graded.results.find((result) => result.scenarioId === "S01-construction");
  assert.equal(construction.passed, false);
});

test("the evaluator's own level arithmetic is independent and correct", () => {
  const levels = groundTruthLevels(buildGridBenchmarkDefinition().strategy);
  assert.equal(levels.length, 9);
  assert.deepEqual(levels.map((level) => Number(level.priceMinor / 10n ** 18n)), [600, 625, 650, 675, 700, 725, 750, 775, 800]);
});

/* ------------------------------------------------------------ track record */

test("a simulated fill is never counted as a real one", () => {
  const grid = strategy();
  const session = summarizeGridSession({
    strategy: grid,
    fills: [
      { state: "FILLED", side: SIDES.BUY, execution: EXECUTION_KINDS.SIMULATED, quoteSpentMinor: String(U(100)), baseReceivedMinor: "150000000000000000" },
      { state: "FILLED", side: SIDES.BUY, execution: EXECUTION_KINDS.ONCHAIN, quoteSpentMinor: String(U(50)), baseReceivedMinor: "70000000000000000" },
    ],
  });
  assert.equal(session.fills.onchain, 1);
  assert.equal(session.fills.simulated, 1);
  // Only the on-chain fill reaches the realised figures.
  assert.equal(session.realised.quoteSpentMinor, String(U(50)));
});

test("no rate is published before there are enough real sessions", () => {
  const grid = strategy();
  const oneSession = summarizeGridSession({
    strategy: grid,
    fills: [{ state: "FILLED", side: SIDES.BUY, execution: EXECUTION_KINDS.ONCHAIN, quoteSpentMinor: String(U(50)), baseReceivedMinor: "70000000000000000" }],
  });
  const record = buildGridTrackRecord({ sessions: [oneSession] });
  assert.equal(record.sessionsWithOnchainFills, 1);
  assert.equal(record.hasEnoughForRate, false);
  assert.equal(record.realisedReturnBps, null, "a rate from one session is not a rate");
  assert.equal(record.maxDrawdownBps, null);
  assert.ok(MIN_SESSIONS_FOR_RATE >= 3);
});

test("an agent that never executed reports nothing rather than zero performance", () => {
  const record = buildGridTrackRecord({ sessions: [] });
  assert.equal(record.onchainFills, 0);
  assert.equal(record.realisedReturnBps, null);
  assert.match(record.summary, /has not executed a grid trade on chain/);
});

/* -------------------------------------------------------- the agent itself */

test("Grid Keeper never claims a native limit order and invents no order id", () => {
  assert.equal(GRID_EXECUTION_MODEL.isNativeLimitOrder, false);
  assert.match(GRID_EXECUTION_MODEL.summary, /no order id/i);
  const grid = active();
  const deliverable = buildGridKeeperDeliverable({ jobId: 1, task: "run the grid", strategy: grid, observation: observation(649), now: NOW });
  const serialised = JSON.stringify(deliverable);
  assert.ok(!/orderId|order_id/i.test(serialised), "no order id may appear anywhere in a deliverable");
  assert.equal(deliverable.executionModel.isNativeLimitOrder, false);
});

test("a deliverable publishes the refusals, not only the action", () => {
  // 690 sits above every buy level and below every sell level, so nothing is
  // eligible and the deliverable is nothing but reasons.
  const deliverable = buildGridKeeperDeliverable({ jobId: 1, strategy: active(), observation: observation(690), now: NOW });
  assert.equal(deliverable.status, "completed");
  assert.equal(deliverable.decision.nextAction, null);
  assert.ok(deliverable.decision.refusals.length > 0, "a refusal must be visible with its reason");
  assert.ok(deliverable.decision.refusals.every((entry) => typeof entry.reason === "string"));
});

test("with no granted session a deliverable says so rather than implying authority", () => {
  const deliverable = buildGridKeeperDeliverable({ jobId: 1, strategy: active(), observation: observation(649), now: NOW });
  assert.equal(deliverable.authority.granted, false);
  assert.match(deliverable.authority.note, /cannot execute/);
});

test("missing input produces insufficient_data, never a guessed grid", () => {
  const deliverable = buildGridKeeperDeliverable({ jobId: 1, strategy: null });
  assert.equal(deliverable.status, "insufficient_data");
  assert.match(deliverable.reason, /Nothing was executed/);
});

test("the agent fixes its own allowlist rather than accepting one from a caller", () => {
  const planned = planGridStrategy({
    strategyId: "P1",
    pair: { baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt, baseSymbol: "WBNB", quoteSymbol: "USDT" },
    lowerPriceMinor: U(600), upperPriceMinor: U(800), levelCount: 8,
    totalCapitalMinor: U(400), maxPerLevelMinor: U(100),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    // A caller trying to widen the scope has nowhere to put it.
    allowedContracts: ["0xevil"], allowedMethods: ["transferFrom"],
  });
  assert.deepEqual(planned.authority.allowedContracts, [GRID_TESTNET_VENUE.router]);
  assert.deepEqual(planned.authority.allowedMethods, [GRID_TESTNET_VENUE.swapMethod]);
  // The route that was planned but proved unquotable must never appear in a
  // live allowlist, only in the record of what was rejected and why.
  assert.equal(planned.authority.allowedContracts.includes(GRID_TESTNET_VENUE.notExecutable.smartRouterV3), false);
  assert.equal(GRID_TESTNET_VENUE.notExecutable.reason, "quoter_reverts_on_bsc_testnet");
  assert.equal(planned.chainId, 97);
});

test("Grid Keeper shares no namespace, wallet, port or identity with the other three", () => {
  const keys = ["health-factor", "rebalancing", "yield", "grid"];
  const fields = [
    keys.map((key) => REFERENCE_NAMESPACES[key].deliverables),
    keys.map((key) => REFERENCE_NAMESPACES[key].benchmarkFile),
    keys.map((key) => REFERENCE_NAMESPACES[key].port),
    keys.map((key) => REFERENCE_WALLET_PATHS[key].walletsDir),
    keys.map((key) => REFERENCE_IDENTITY_FILES[key]),
    REFERENCE_AGENT_SPECS.map((spec) => spec.identity),
    REFERENCE_AGENT_SPECS.map((spec) => spec.endpointPath),
    REFERENCE_AGENT_SPECS.map((spec) => spec.category),
  ];
  for (const values of fields) {
    assert.equal(new Set(values).size, values.length, `collision in ${JSON.stringify(values)}`);
  }
  // The one agent that can move capital declares it, which is what makes the
  // marketplace show the warning without anyone remembering to.
  const grid = REFERENCE_AGENT_SPECS.find((spec) => spec.key === "grid");
  assert.equal(grid.executionPolicy.capitalMovement, true);
  assert.equal(grid.executionPolicy.requiresBoundedAuthority, true);
});

/* ------------------------------------------------------------ no fake stats */

test("the Leash page states no grid figures of its own", () => {
  const html = readFileSync(new URL("../web/leash.html", import.meta.url), "utf8");
  for (const pattern of [
    /\b\d+\s*(?:fills|trades|orders)\s+(?:executed|completed|filled)/i,
    /\b\d{1,3}(?:\.\d+)?%\s*(?:return|profit|win|success)/i,
    /\border\s*(?:id|#)\s*[:=]?\s*\d/i,
  ]) {
    assert.equal(pattern.test(html), false, `leash.html contains a hand-written figure matching ${pattern}`);
  }
  // It must not promise native limit orders either.
  assert.equal(/resting (limit )?order/i.test(html.replace(/no resting order/gi, "")), false);
});
