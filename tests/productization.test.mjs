/**
 * Directive #16 productization tests.
 *
 * These cover the public surface: what a stranger can see, what a developer is
 * allowed to write, and what has to stay unknown. The rule under test
 * throughout is that facts come from observed evidence and copy comes from the
 * pages, so nothing a developer types can become a marketplace fact.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assessBnbEligibility,
  partitionByEligibility,
  ELIGIBILITY,
  TESTNET_CONFIRMATION_FLAG,
} from "../src/marketplace/eligibility.mjs";
import {
  createChallenge,
  challengeMessage,
  challengeState,
  consumeChallenge,
  verifyOwnership,
  verifiedSessionActive,
  ownershipRecord,
  CHALLENGE_TTL_MS,
  OWNERSHIP_ERRORS,
} from "../src/marketplace/ownership.mjs";
import {
  sanitizeText,
  sanitizeUrl,
  isPrivateHost,
  validateListingSubmission,
  createListing,
  updateListing,
  applyListing,
  listingStateFor,
  LISTING_STATES,
  LISTING_FORBIDDEN_FIELDS,
} from "../src/marketplace/listings.mjs";
import {
  buildPublicAgent,
  buildMarketplace,
  buildHomepageEvidence,
  categorySummary,
  publicRunsOnly,
} from "../src/marketplace/public-api.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";

const REGISTRY = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

function candidateAt(tokenId, overrides = {}) {
  return {
    identity: `97:${REGISTRY}:${tokenId}`,
    chainId: 97,
    network: "bsc-testnet",
    name: `Discovered Agent ${tokenId}`,
    description: "Discovered on chain.",
    ownerAddress: OWNER,
    services: [{ type: "A2A", endpoint: "https://agent.example/a2a" }],
    probes: [],
    ...overrides,
  };
}

/* ---------------------------------------------------------------- eligibility */

test("BNB eligibility is read from the chain the identity resolves to, never from its name", () => {
  const bnbTestnet = assessBnbEligibility(candidateAt("2001"));
  assert.equal(bnbTestnet.status, ELIGIBILITY.ELIGIBLE);
  assert.equal(bnbTestnet.network, "bsc-testnet");
  assert.equal(bnbTestnet.confirmationRequired, null);
  assert.equal(TESTNET_CONFIRMATION_FLAG, "FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED");

  const bnbMainnet = assessBnbEligibility({ identity: `56:${REGISTRY}:7` });
  assert.equal(bnbMainnet.status, ELIGIBILITY.ELIGIBLE);
  assert.equal(bnbMainnet.confirmationRequired, null);

  // A name that says BNB proves nothing. The chain is what decides.
  const impostor = assessBnbEligibility({ identity: `1:${REGISTRY}:7`, name: "BNB Chain Yield Agent" });
  assert.equal(impostor.status, ELIGIBILITY.INELIGIBLE);
  assert.deepEqual(impostor.reasons, ["chain_1_is_not_bnb"]);
});

test("an unresolved chain stays unverified rather than being called ineligible", () => {
  const unknown = assessBnbEligibility({ name: "No identity yet" });
  assert.equal(unknown.status, ELIGIBILITY.UNVERIFIED);
  assert.equal(unknown.chainId, null);
  assert.equal(unknown.eligibleForPublicShelf, false);
  // Unknown is not zero and not a verdict: Canned has not looked.
  assert.deepEqual(unknown.reasons, ["chain_not_resolved"]);

  const strangeRegistry = assessBnbEligibility({ identity: "97:0xdeadbeef:4" });
  assert.equal(strangeRegistry.status, ELIGIBILITY.UNVERIFIED);
  assert.ok(strangeRegistry.reasons.includes("registry_not_recognised"));
});

test("only eligible BNB agents reach the public shelf", () => {
  const { counts } = partitionByEligibility([
    candidateAt("2001"),
    { identity: `1:${REGISTRY}:9` },
    { name: "unresolved" },
  ]);
  assert.deepEqual(counts, { eligible: 1, unverified: 1, ineligible: 1 });
});

/* ----------------------------------------------------------------- ownership */

test("the signed challenge names the product, the agent, the wallet and an expiry", () => {
  const challenge = createChallenge({ identity: `97:${REGISTRY}:2001`, address: OWNER, now: 0, nonce: "abc" });
  assert.match(challenge.message, /^Canned agent ownership verification/);
  assert.ok(challenge.message.includes(`Agent: 97:${REGISTRY}:2001`));
  assert.ok(challenge.message.includes(`Wallet: ${OWNER.toLowerCase()}`));
  assert.ok(challenge.message.includes("Nonce: abc"));
  assert.ok(challenge.message.includes("Expires: "));
  // The wallet is told plainly that nothing is being spent.
  assert.ok(challenge.message.includes("does not move funds"));
  assert.equal(Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt), CHALLENGE_TTL_MS);

  // Signing for one agent cannot be reused for another: the text differs.
  const other = challengeMessage({ identity: `97:${REGISTRY}:2002`, address: OWNER.toLowerCase(), nonce: "abc", issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt });
  assert.notEqual(other, challenge.message);
});

test("a signature is accepted only when the signer is the owner the registry reports", async () => {
  const identity = `97:${REGISTRY}:2001`;
  const challenge = createChallenge({ identity, address: OWNER, now: 1000, nonce: "n1" });
  const recoverAddress = async () => OWNER;

  const ok = await verifyOwnership({ challenge, signature: "0xsig", identity, onchainOwner: OWNER, recoverAddress, now: 2000 });
  assert.equal(ok.verified, true);
  assert.equal(ok.signer, OWNER.toLowerCase());
  assert.equal(ok.method, "wallet_signature_matched_onchain_owner");
  assert.ok(verifiedSessionActive({ ...ok }, { now: 2000 }));

  const record = ownershipRecord({ verification: ok, identity });
  assert.equal(record.owner, OWNER.toLowerCase());
  assert.equal(record.entity, "AgentOwnershipProof");
});

test("a valid signature from the wrong wallet does not claim the agent", async () => {
  const identity = `97:${REGISTRY}:2001`;
  // The challenge was issued for OTHER, and OTHER really did sign it, but the
  // registry says OWNER holds the agent. A real signature is not ownership.
  const challenge = createChallenge({ identity, address: OTHER, now: 1000, nonce: "n2" });
  const result = await verifyOwnership({ challenge, signature: "0xsig", identity, onchainOwner: OWNER, recoverAddress: async () => OTHER, now: 2000 });
  assert.equal(result.verified, false);
  assert.equal(result.error, OWNERSHIP_ERRORS.NOT_OWNER);
});

test("a signature by someone other than the challenged wallet is rejected", async () => {
  const identity = `97:${REGISTRY}:2001`;
  const challenge = createChallenge({ identity, address: OWNER, now: 1000, nonce: "n3" });
  const result = await verifyOwnership({ challenge, signature: "0xsig", identity, onchainOwner: OWNER, recoverAddress: async () => OTHER, now: 2000 });
  assert.equal(result.verified, false);
  assert.equal(result.error, OWNERSHIP_ERRORS.ADDRESS_MISMATCH);
});

test("a challenge is single use, so a captured signature cannot be replayed", async () => {
  const identity = `97:${REGISTRY}:2001`;
  const challenge = createChallenge({ identity, address: OWNER, now: 1000, nonce: "n4" });
  const recoverAddress = async () => OWNER;

  const first = await verifyOwnership({ challenge, signature: "0xsig", identity, onchainOwner: OWNER, recoverAddress, now: 2000 });
  assert.equal(first.verified, true);

  const spent = consumeChallenge(challenge, { now: 2000 });
  const replay = await verifyOwnership({ challenge: spent, signature: "0xsig", identity, onchainOwner: OWNER, recoverAddress, now: 2001 });
  assert.equal(replay.verified, false);
  assert.equal(replay.error, OWNERSHIP_ERRORS.ALREADY_USED);
});

test("an expired challenge is refused even with a correct signature", async () => {
  const identity = `97:${REGISTRY}:2001`;
  const challenge = createChallenge({ identity, address: OWNER, now: 0, nonce: "n5" });
  const late = CHALLENGE_TTL_MS + 1;
  assert.equal(challengeState(challenge, { now: late }).error, OWNERSHIP_ERRORS.EXPIRED);

  const result = await verifyOwnership({ challenge, signature: "0xsig", identity, onchainOwner: OWNER, recoverAddress: async () => OWNER, now: late });
  assert.equal(result.verified, false);
  assert.equal(result.error, OWNERSHIP_ERRORS.EXPIRED);
});

test("a signature for one agent cannot be redirected at another", async () => {
  const challenge = createChallenge({ identity: `97:${REGISTRY}:2001`, address: OWNER, now: 1000, nonce: "n6" });
  const result = await verifyOwnership({ challenge, signature: "0xsig", identity: `97:${REGISTRY}:2002`, onchainOwner: OWNER, recoverAddress: async () => OWNER, now: 2000 });
  assert.equal(result.verified, false);
  assert.equal(result.error, OWNERSHIP_ERRORS.IDENTITY_MISMATCH);
});

test("a malformed signature fails closed instead of throwing", async () => {
  const identity = `97:${REGISTRY}:2001`;
  const challenge = createChallenge({ identity, address: OWNER, now: 1000, nonce: "n7" });
  const result = await verifyOwnership({
    challenge,
    signature: "not-a-signature",
    identity,
    onchainOwner: OWNER,
    recoverAddress: async () => { throw new Error("bad signature"); },
    now: 2000,
  });
  assert.equal(result.verified, false);
  assert.equal(result.error, OWNERSHIP_ERRORS.BAD_SIGNATURE);
});

/* ------------------------------------------------- listing input validation */

test("listing metadata is neutralised before it is ever stored", () => {
  assert.equal(sanitizeText('<script>alert(1)</script>Range bot'), "scriptalert(1)/scriptRange bot");
  assert.equal(sanitizeText('<img src=x onerror="steal()">'), 'img src=x onerror="steal()"');
  assert.equal(sanitizeText("line breakhere"), "linebreakhere");
  assert.equal(sanitizeText("   "), null);
  assert.equal(sanitizeText(null), null);
  // Length is capped so a listing cannot flood a card.
  assert.equal(sanitizeText("x".repeat(500), 60).length, 60);
});

test("private and internal hosts are refused so a listing cannot become an SSRF tool", () => {
  for (const host of [
    "localhost", "app.localhost", "printer.local", "svc.internal",
    "127.0.0.1", "10.0.0.5", "192.168.1.20", "172.16.4.4", "172.31.9.9",
    "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "intranet",
  ]) {
    assert.equal(isPrivateHost(host), true, `${host} should be treated as private`);
  }
  for (const host of ["example.com", "agent.example.org", "172.32.0.1", "8.8.8.8"]) {
    assert.equal(isPrivateHost(host), false, `${host} should be treated as public`);
  }
});

test("only public http(s) URLs survive URL validation", () => {
  assert.equal(sanitizeUrl("https://docs.example.com/agent"), "https://docs.example.com/agent");
  assert.equal(sanitizeUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(sanitizeUrl("file:///etc/passwd"), null);
  assert.equal(sanitizeUrl("http://169.254.169.254/latest/meta-data/"), null);
  assert.equal(sanitizeUrl("http://localhost:8787/admin"), null);
  assert.equal(sanitizeUrl("/relative/path"), null);
  assert.equal(sanitizeUrl(""), null);
});

test("a developer cannot write any field Canned derives from evidence", () => {
  for (const field of LISTING_FORBIDDEN_FIELDS) {
    const result = validateListingSubmission({ displayName: "Mine", [field]: "anything" });
    assert.equal(result.valid, false, `${field} should be rejected`);
    assert.ok(result.errors.some((error) => error.startsWith("fields_owned_by_canned_evidence")));
  }
});

test("a claimed category is recorded as a claim and an unknown one is refused", () => {
  const good = validateListingSubmission({ displayName: "Range bot", claimedCategory: "rebalancing" });
  assert.equal(good.valid, true);
  assert.equal(good.listing.claimedCategory, "rebalancing");

  const bad = validateListingSubmission({ displayName: "Range bot", claimedCategory: "makes-you-rich" });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.includes("unknown_category"));
});

/* ---------------------------------------------------- listing persistence */

test("a listing cannot be created without a verified ownership proof", () => {
  const identity = `97:${REGISTRY}:2001`;
  assert.throws(
    () => createListing({ identity, submission: { displayName: "Mine" }, ownership: null }),
    /verified ownership proof/,
  );
});

test("a stored listing carries the claim, the proof, and its own content hashes", () => {
  const identity = `97:${REGISTRY}:2001`;
  const ownership = { owner: OWNER.toLowerCase(), signer: OWNER.toLowerCase(), method: "wallet_signature_matched_onchain_owner", verifiedAt: "2026-08-30T00:00:00.000Z" };
  const listing = createListing({
    identity,
    submission: { displayName: "Range Runner", description: "Keeps a V3 position in range.", claimedCategory: "rebalancing", developerName: "Example Labs", developerUrl: "https://example.com" },
    ownership,
    now: "2026-08-30T00:00:00.000Z",
  });

  assert.equal(listing.state, LISTING_STATES.CLAIMED);
  assert.equal(listing.claimedBy, OWNER.toLowerCase());
  assert.equal(listing.claimedCategoryIsUnverified, true);
  assert.ok(listing.hashes);
  // The record says in its own text that presentation is not evidence.
  assert.match(listing.note, /derived by Canned from observed evidence/);
});

test("only the verified owner may update a listing", () => {
  const identity = `97:${REGISTRY}:2001`;
  const ownership = { owner: OWNER.toLowerCase() };
  const existing = createListing({ identity, submission: { displayName: "Range Runner" }, ownership, now: "2026-08-30T00:00:00.000Z" });

  const updated = updateListing({ existing, submission: { displayName: "Range Runner v2" }, ownership, now: "2026-08-30T01:00:00.000Z" });
  assert.equal(updated.listing.displayName, "Range Runner v2");
  assert.notDeepEqual(updated.hashes, existing.hashes);

  assert.throws(
    () => updateListing({ existing, submission: { displayName: "Stolen" }, ownership: { owner: OTHER } }),
    /Only the verified owner/,
  );
});

test("applying a listing changes presentation and nothing Canned observed", () => {
  const candidate = candidateAt("2001", { name: "Agent 2001", description: "Discovered on chain." });
  const listing = createListing({
    identity: candidate.identity,
    submission: { displayName: "Range Runner", description: "Keeps a V3 position in range.", claimedCategory: "rebalancing" },
    ownership: { owner: OWNER.toLowerCase() },
    now: "2026-08-30T00:00:00.000Z",
  });

  const merged = applyListing(candidate, listing);
  assert.equal(merged.name, "Range Runner");
  assert.equal(merged.claimed, true);
  assert.equal(merged.claimedBy, OWNER.toLowerCase());
  assert.equal(merged.ownerListing.claimedCategoryIsUnverified, true);
  // Observations are untouched by the merge.
  assert.deepEqual(merged.probes, candidate.probes);
  assert.equal(merged.ownerAddress, candidate.ownerAddress);
  assert.equal("trust" in merged, false);
});

test("an unclaimed agent is still listed and says so", () => {
  const candidate = candidateAt("2002");
  assert.equal(listingStateFor(candidate, null), LISTING_STATES.UNCLAIMED);
  const merged = applyListing(candidate, null);
  assert.equal(merged.claimed, false);
  assert.equal(merged.claimedBy, null);
  // A first-party agent is claimed by construction, not by a form submission.
  assert.equal(listingStateFor({ ...candidate, origin: "CANNED_REFERENCE" }, null), LISTING_STATES.CLAIMED);
});

/* -------------------------------------------------------------- public view */

test("an untested agent reports unknown, never zero wins", () => {
  const agent = buildPublicAgent({ candidate: candidateAt("2003"), runs: [] });
  assert.equal(agent.trackRecord.qualifyingBenchmarks, 0);
  assert.equal(agent.trackRecord.wins, null);
  assert.equal(agent.trackRecord.losses, null);
  assert.equal(agent.trackRecord.hasEnoughForRate, false);
  assert.equal(agent.trackRecord.summary, "not_enough_data");
  // A count of observed deliveries genuinely is zero, and stays zero.
  assert.equal(agent.trackRecord.deliveriesObserved, 0);
});

test("a price exists only when a signed quote was verified", () => {
  const withoutQuote = buildPublicAgent({ candidate: candidateAt("2004"), runs: [] });
  assert.equal(withoutQuote.price.raw, null);
  assert.equal(withoutQuote.price.verified, false);
  assert.equal(withoutQuote.price.source, "no_verified_quote");

  // An advertised price with no verification does not become a price.
  const advertisedOnly = buildPublicAgent({
    candidate: candidateAt("2005", { hiring: { price: "999", currency: "U" } }),
    runs: [],
  });
  assert.equal(advertisedOnly.price.verified, false);
  assert.equal(advertisedOnly.price.raw, null);
});

test("a developer-supplied listing never raises the trust level", () => {
  const candidate = candidateAt("2006");
  const listing = createListing({
    identity: candidate.identity,
    submission: { displayName: "Best Agent Ever", description: "Thousands of successful jobs.", claimedCategory: "rebalancing" },
    ownership: { owner: OWNER.toLowerCase() },
    now: "2026-08-30T00:00:00.000Z",
  });

  const plain = buildPublicAgent({ candidate, runs: [] });
  const claimed = buildPublicAgent({ candidate, runs: [], listing });

  assert.equal(claimed.name, "Best Agent Ever");
  assert.equal(claimed.claimed, true);
  // The copy changed. The evidence did not.
  assert.deepEqual(claimed.trust.reached, plain.trust.reached);
  assert.deepEqual(claimed.trackRecord, plain.trackRecord);
  assert.equal(claimed.category.cannedVerifiedCapability, false);
  assert.equal(claimed.category.claimedCategoryIsUnverified, true);
  assert.equal(claimed.price.verified, false);
});

test("the shelf shows eligible BNB agents and holds the rest back", () => {
  const marketplace = buildMarketplace({
    candidates: [candidateAt("2001"), candidateAt("2002"), { identity: `1:${REGISTRY}:9`, name: "Ethereum agent" }, { name: "unresolved" }],
    runs: [],
  });
  assert.equal(marketplace.agents.length, 2);
  assert.equal(marketplace.pendingEligibility.length, 1);
  assert.ok(marketplace.agents.every((agent) => agent.eligibility.status === ELIGIBILITY.ELIGIBLE));
  // The ineligible chain is not merely hidden from the shelf, it is nowhere.
  const everywhere = [...marketplace.agents, ...marketplace.pendingEligibility];
  assert.ok(!everywhere.some((agent) => String(agent.identity || "").startsWith("1:")));
});

test("a category with listings but no benchmark is reported incomplete, not fabricated", () => {
  const grid = candidateAt("2007", { categoryHypotheses: [{ category: CATEGORIES.GRID_TRADING, label: "Grid Trading", confidence: "low", signals: ["name"] }] });
  const summary = categorySummary([buildPublicAgent({ candidate: grid, runs: [] })]);
  const gridRow = summary.find((row) => row.category === CATEGORIES.GRID_TRADING);

  assert.equal(gridRow.listed, 1);
  assert.equal(gridRow.benchmarked, 0);
  assert.equal(gridRow.complete, false);
  // Nothing invents a score to fill the column.
  assert.equal(gridRow.hireable, 0);
});

/* ------------------------------------------------------- homepage evidence */

test("fixture and infrastructure runs never reach a public surface", () => {
  const runs = [
    { runId: "a", runType: RUN_TYPES.BENCHMARK },
    { runId: "b", runType: RUN_TYPES.FIXTURE },
    { runId: "c", runType: RUN_TYPES.INFRASTRUCTURE_SMOKE_TEST },
    { runId: "d", runType: RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL },
  ];
  assert.deepEqual(publicRunsOnly(runs).map((run) => run.runId), ["a"]);
});

test("homepage totals are derived, and an unmeasured total stays unknown", () => {
  const agents = [buildPublicAgent({ candidate: candidateAt("2001"), runs: [] })];
  const evidence = buildHomepageEvidence({ agents, runs: [], metrics: { jobsPaidForAndGraded: 3, wins: 2, losses: 1 }, pairs: [] });

  assert.equal(evidence.totals.agentsListed, 1);
  assert.equal(evidence.totals.agentsBenchmarked, 0);
  assert.equal(evidence.totals.jobsPaidForAndGraded, 3);
  // Nothing measured deliveries or timeouts here, so neither becomes a zero.
  assert.equal(evidence.totals.deliveries, null);
  assert.equal(evidence.totals.timeouts, null);
  assert.equal(evidence.pairedComparisons.required, 3);
});

test("the homepage lists verified runs in order and keeps a loss visible", () => {
  const runs = [
    {
      runId: "run-2", runType: RUN_TYPES.BENCHMARK,
      qualification: { isVerifiedRun: true, verifiedRunNumber: 2 },
      agent: { identity: `97:${REGISTRY}:2002`, name: "Canned Range Keeper" },
      benchmark: { id: "rebalancebench-v1", category: "rebalancing" },
      protocolJob: { jobId: 702, currentState: "Settled" },
      evaluation: { metrics: { humanQualityScore: 0.5, agentQualityScore: 0.9, agentAdvantage: true } },
    },
    {
      runId: "run-1", runType: RUN_TYPES.BENCHMARK,
      qualification: { isVerifiedRun: true, verifiedRunNumber: 1 },
      agent: { identity: `97:${REGISTRY}:2001`, name: "Canned Health Guard" },
      benchmark: { id: "healthbench-v1", category: "health-factor-monitoring" },
      protocolJob: { jobId: 695, currentState: "Settled" },
      evaluation: { metrics: { humanQualityScore: 0.9, agentQualityScore: 0.6, agentAdvantage: false } },
    },
  ];

  const evidence = buildHomepageEvidence({ agents: [], runs, metrics: {}, pairs: [] });
  assert.deepEqual(evidence.verifiedRuns.map((run) => run.runNumber), [1, 2]);
  // The run the agent lost is published exactly like the one it won.
  assert.equal(evidence.verifiedRuns[0].agentAdvantage, false);
  assert.equal(evidence.verifiedRuns[0].agentName, "Canned Health Guard");
  assert.equal(evidence.verifiedRuns[1].agentAdvantage, true);
});

/* ------------------------------------------------- no hardcoded shelf facts */

test("the public pages contain no hand-written marketplace figures", () => {
  const pages = ["web/home.html", "web/marketplace.html", "web/agent.html", "web/list.html"];
  // Phrases that would mean a fact was typed rather than derived.
  const fabricated = [
    /\b\d+(?:,\d{3})*\+?\s*(?:agents?|jobs?|deliveries|hires?)\s+(?:listed|completed|delivered|verified)/i,
    /\b\d{1,3}(?:\.\d+)?%\s*(?:success|win|uptime|accuracy)/i,
    /\b(?:trusted|used) by\s+\d/i,
    /\b\d+(?:\.\d+)?\s*(?:BNB|U)\s+(?:earned|paid out|in volume)/i,
  ];
  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    for (const pattern of fabricated) {
      assert.equal(pattern.test(html), false, `${page} contains a hand-written marketplace figure matching ${pattern}`);
    }
  }
});

test("public pages ask for a signature and never for a key, seed, or password", () => {
  for (const page of ["web/home.html", "web/marketplace.html", "web/agent.html", "web/list.html"]) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8").toLowerCase();
    for (const forbidden of ["seed phrase", "private key", "mnemonic", "wallet password", "recovery phrase"]) {
      // The list page may explain that Canned never asks for these, so the only
      // acceptable appearance is inside a sentence that refuses them.
      if (!html.includes(forbidden)) continue;
      const refused = new RegExp(`(never|not|no|without)[^.]{0,80}${forbidden}`);
      assert.ok(refused.test(html), `${page} mentions "${forbidden}" outside a refusal`);
    }
  }
});

test("every server value interpolated into markup passes through an escaper", () => {
  const pages = ["web/home.html", "web/marketplace.html", "web/agent.html", "web/list.html"];
  // A dotted value concatenated into a string that becomes innerHTML, without
  // esc(), encodeURIComponent(), String() or Number() around it.
  const unwrapped = /\+\s*(?!esc\(|encodeURIComponent\(|String\(|Number\()([A-Za-z_$][\w$]*(?:\.[\w$]+)+)/g;
  // Method chains and arithmetic helpers are not interpolated values.
  const benign = /\.(map|join|toString|toFixed|filter|length)$|^Math\./;

  for (const page of pages) {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    assert.ok(html.includes("const esc = "), `${page} must define an escaper`);
    // `document.title` is a text assignment, not a markup context, so it is
    // read out before the markup scan rather than treated as an exception.
    const markup = html.replace(/document\.title\s*=[^;]+;/g, "");
    for (const match of markup.matchAll(unwrapped)) {
      const expression = match[1];
      if (benign.test(expression)) continue;
      // Counts and scores are numbers Canned derived, never developer text.
      if (/\.(losses|wins|listed|benchmarked|reachable|hireable|count)$/.test(expression)) continue;
      assert.fail(`${page} interpolates ${expression} without escaping it`);
    }
  }
});
