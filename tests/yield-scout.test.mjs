import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, contentHashes } from "../src/core.mjs";
import { CATEGORIES, CATEGORY_LABELS } from "../src/domain.mjs";
import { selectHiringAdapter } from "../src/marketplace/adapters.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { referenceFleetIdentityFailures, publicReadinessFailures } from "../src/deploy/readiness.mjs";
import { REFERENCE_AGENT_SPECS, REFERENCE_IDENTITY_FILES, REFERENCE_NAMESPACES, REFERENCE_WALLET_PATHS, referenceAgentCandidate, referenceFleetCatalog, referenceNamespaceCollisions, referenceSpec, implementedReferenceAgentCandidates } from "../src/reference/constants.mjs";
import { publicReferenceMetadata } from "../src/reference/public-service.mjs";
import { breakEvenDays, returnOverHorizon, supplyApr, supplyApy, utilisationBps, validateAuthoritativeYieldSnapshot, VENUS_MAINNET_CORE } from "../src/reference/venus-yield.mjs";
import { encodePath, reallocationGasCost, swapCostFraction } from "../src/reference/swap-route.mjs";
import { boundedYieldPlan, buildIndependentYieldControl, buildYieldScoutDeliverable, REALLOCATION_STEPS, YIELD_POLICY } from "../src/reference/yield-scout.mjs";
import { completeYieldBaseline, createYieldBaselineAttempt, createYieldBenchDefinition, publicYieldBenchPacket, publicYieldBenchSource, yieldBenchAgentInput, yieldBenchProviderTask, yieldContainsSecretAnswer, validateYieldBenchAgentInput } from "../src/reference/yield-benchmark.mjs";
import { affirmation, computeYieldGroundTruth, extractNumbers, gradeYieldResponse, isDeclined, yieldScoutStructuredView, yieldScoutSubmissionFromOutput } from "../src/reference/yield-evaluator.mjs";
import { MINIMUM_OBSERVATIONS_FOR_RATE, recordYieldDecision, settleYieldDecision, summarizeYieldTrackRecord } from "../src/reference/yield-track-record.mjs";

const registry = "0x8004a818bfb912233c491871b3d84c89a494bd9e";
const yieldProvider = "0x99E5Fee06CF247F522119314980c58B8501d5684";
const BPY = 70_080_000n;

function market({ key, symbol, address, ratePerBlock, cash, borrows, decimals = 18, speed = 0n }) {
  const apr = supplyApr(ratePerBlock, BPY);
  return {
    key, vToken: address, vTokenSymbol: key, asset: `0x${key.slice(1).padEnd(40, "0")}`, assetSymbol: symbol, assetDecimals: decimals,
    supplyRatePerBlock: String(ratePerBlock), borrowRatePerBlock: "0", blocksPerYear: String(BPY),
    supplyAprDecimal: apr, supplyApyDecimal: supplyApy(ratePerBlock, BPY),
    cash: String(cash), totalBorrows: String(borrows), totalReserves: "0", totalSupply: "0", exchangeRateStored: "0",
    reserveFactorMantissa: "0", interestRateModel: "0x00", utilisationBps: utilisationBps({ cash, totalBorrows: borrows, totalReserves: 0n }),
    venusSupplySpeed: String(speed), incentivesIncluded: speed === 0n, collateralFactorMantissa: null, supplyCap: null,
  };
}

const E = (value) => BigInt(Math.round(value)) * 10n ** 18n;
const snapshot = {
  protocol: "Venus", poolType: "core", source: "onchain", chainId: 56,
  asOfBlock: "118529435", blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: 1_787_900_000,
  readPlan: { chainId: 56, comptroller: VENUS_MAINNET_CORE.comptroller, blockTag: "118529435", authoritative: true },
  markets: [
    market({ key: "vUSDC", symbol: "USDC", address: "0x01", ratePerBlock: 278_000_000n, cash: E(21_000_000), borrows: E(28_000_000) }),
    market({ key: "vUSDT", symbol: "USDT", address: "0x02", ratePerBlock: 366_000_000n, cash: E(68_000_000), borrows: E(129_000_000) }),
    market({ key: "vFDUSD", symbol: "FDUSD", address: "0x03", ratePerBlock: 403_000_000n, cash: E(2_500_000), borrows: E(3_200_000) }),
    market({ key: "vTINY", symbol: "TINY", address: "0x04", ratePerBlock: 900_000_000n, cash: E(100_000), borrows: E(50_000) }),
  ],
  authoritative: true,
};

const costs = {
  quotedAtBlock: "118529435", gasPriceAtBlock: "118529435", gasPriceWei: "50000000",
  gasCostNative: 0.0000415, gasSteps: REALLOCATION_STEPS, totalGasUnits: "830000",
  nativeSymbol: "BNB", nativePriceInAsset: 712,
  swapRoutes: [
    { toMarketKey: "vUSDT", toAssetSymbol: "USDT", bestCostFraction: 0.000251, bestRoute: { kind: "direct", hops: ["a", "b"], fees: [100] }, routes: [] },
    { toMarketKey: "vFDUSD", toAssetSymbol: "FDUSD", bestCostFraction: -0.000266, bestRoute: { kind: "routed", hops: ["a", "b", "c"], fees: [100, 100] }, routes: [] },
    { toMarketKey: "vTINY", toAssetSymbol: "TINY", bestCostFraction: 0.004, bestRoute: { kind: "direct", hops: ["a", "d"], fees: [500] }, routes: [] },
  ],
};

const definition = createYieldBenchDefinition({
  snapshot,
  position: { marketKey: "vUSDC", assetSymbol: "USDC", asset: snapshot.markets[0].asset, amount: 25_000, assetDecimals: 18 },
  horizonDays: 30,
  costs,
});
const truth = computeYieldGroundTruth(definition);
const deliverable = buildYieldScoutDeliverable({ jobId: 800, task: yieldBenchProviderTask(definition, { jobId: 800 }) });

test("Venus yield maths uses the market's own blocksPerYear and is exact", () => {
  assert.ok(Math.abs(supplyApr(366_000_000n, BPY) - 0.02565) < 1e-4);
  assert.ok(supplyApy(366_000_000n, BPY) > supplyApr(366_000_000n, BPY));
  assert.equal(utilisationBps({ cash: E(50), totalBorrows: E(50), totalReserves: 0n }), 5000);
  assert.equal(utilisationBps({ cash: 0n, totalBorrows: 0n, totalReserves: 0n }), null);
  assert.ok(Math.abs(returnOverHorizon({ principal: 25_000, apr: 0.01, days: 365 }) - 250) < 1e-9);
  assert.ok(Math.abs(returnOverHorizon({ principal: 25_000, apr: 0.01, days: 30 }) - 20.5479) < 1e-3);
});

test("break-even is immediate when a move costs nothing and null when it cannot repay", () => {
  assert.equal(breakEvenDays({ principal: 25_000, aprDelta: 0.01, oneOffCost: 0 }), 0);
  assert.equal(breakEvenDays({ principal: 25_000, aprDelta: 0.01, oneOffCost: -5 }), 0);
  assert.equal(breakEvenDays({ principal: 25_000, aprDelta: -0.01, oneOffCost: 10 }), null);
  const days = breakEvenDays({ principal: 25_000, aprDelta: 0.006, oneOffCost: 6.25 });
  assert.ok(Math.abs(days - 15.2) < 1);
});

test("swap route helpers price cost honestly, including a favourable swap", () => {
  assert.ok(Math.abs(swapCostFraction({ amountIn: 1000, amountOut: 999 }) - 0.001) < 1e-9);
  assert.ok(swapCostFraction({ amountIn: 1000, amountOut: 1001 }) < 0);
  assert.equal(swapCostFraction({ amountIn: 0, amountOut: 0 }), null);
  const path = encodePath(["0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa", "0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb", "0xCCccCCccCCccCCccCCccCCccCCccCCccCCccCCcc"], [100, 500]);
  assert.equal(path.length, 2 + 40 + 6 + 40 + 6 + 40);
  assert.throws(() => encodePath(["0x1", "0x2"], [100, 500]), /one more token/);
  const gas = reallocationGasCost({ gasPriceWei: "50000000", steps: REALLOCATION_STEPS });
  assert.equal(gas.totalGasUnits, "830000");
  assert.ok(gas.gasCostNative > 0);
});

test("the snapshot parser rejects anything that is not an authoritative multi-market read", () => {
  assert.equal(validateAuthoritativeYieldSnapshot(snapshot).valid, true);
  assert.ok(validateAuthoritativeYieldSnapshot({ ...snapshot, source: "scraped" }).errors.includes("snapshot_not_onchain"));
  assert.ok(validateAuthoritativeYieldSnapshot({ ...snapshot, markets: [snapshot.markets[0]] }).errors.includes("at_least_two_markets_required"));
  assert.ok(validateAuthoritativeYieldSnapshot({ ...snapshot, blockHash: undefined }).errors.includes("frozen_block_fields_missing"));
});

test("the highest advertised yield is not automatically the recommendation", () => {
  // vTINY advertises the best rate and is rejected on destination liquidity.
  const tiny = deliverable.output.comparison.find((entry) => entry.assetSymbol === "TINY");
  assert.ok(tiny.supplyAprPct > deliverable.output.comparison.find((entry) => entry.assetSymbol === "FDUSD").supplyAprPct);
  assert.equal(tiny.qualifies, false);
  assert.ok(tiny.disqualifiers.includes("insufficient_destination_liquidity"));
  assert.notEqual(deliverable.output.decision.recommendedAssetSymbol, "TINY");
  assert.equal(deliverable.output.decision.highestAdvertisedYield.assetSymbol, "TINY");
  assert.equal(deliverable.output.decision.highestAdvertisedYield.isTheRecommendation, false);
});

test("a move is only recommended when it clears every declared threshold", () => {
  assert.equal(deliverable.ok, true);
  assert.equal(deliverable.output.decision.policyVersion, YIELD_POLICY.version);
  const chosen = deliverable.output.comparison.find((entry) => entry.marketKey === deliverable.output.decision.recommendedMarketKey);
  if (deliverable.output.decision.moveRecommended) {
    assert.ok(chosen.netBenefitBps >= YIELD_POLICY.minimumNetBenefitBpsOfPosition);
    assert.ok(chosen.liquidityCoverMultiple >= YIELD_POLICY.minimumLiquidityCoverMultiple);
    assert.ok(chosen.breakEvenDays <= definition.horizonDays);
  }
  // A position too large for every destination must produce HOLD.
  const huge = buildYieldScoutDeliverable({ task: { ...yieldBenchProviderTask(definition), position: { marketKey: "vUSDC", assetSymbol: "USDC", amount: 20_000_000 } } });
  assert.equal(huge.output.decision.action, "HOLD");
  assert.equal(huge.output.decision.recommendedMarketKey, null);
});

test("Yield Scout refuses to answer without authoritative data", () => {
  const blocked = buildYieldScoutDeliverable({ task: { position: { assetSymbol: "USDC", amount: 1 }, horizonDays: 30 } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.output.status, "INSUFFICIENT_AUTHORITATIVE_DATA");
  assert.equal(blocked.output.comparison, undefined);
});

test("Yield Scout v1 has no execution path and never moves capital", () => {
  assert.equal(deliverable.output.execution.mode, "recommendation_only");
  assert.equal(deliverable.output.execution.capitalMoved, false);
  assert.equal(deliverable.output.execution.automaticActionTaken, false);
  assert.equal(referenceSpec("yield").executionPolicy.capitalMovement, false);
  const serialized = canonicalJson(deliverable.output);
  for (const primitive of ["privateKey", "signTransaction", "rawTransaction", "sendRawTransaction"]) {
    assert.equal(serialized.includes(primitive), false);
  }
  const plan = deliverable.output.execution.futureBoundedPlan;
  if (plan) {
    assert.equal(plan.status, "PLANNED_NOT_AUTHORIZED");
    assert.equal(plan.requiresOperatorConfirmation, true);
    assert.ok(plan.forbidden.includes("unlimited allowance"));
    assert.ok(plan.maximumAmount <= definition.position.amount);
    assert.equal(plan.network, "bsc-testnet");
  }
  assert.equal(boundedYieldPlan({ position: { assetSymbol: "USDC", amount: 1, marketKey: "vUSDC" }, best: { marketKey: "vUSDT" }, policy: YIELD_POLICY, horizonDays: 30 }).status, "PLANNED_NOT_AUTHORIZED");
});

test("the frozen benchmark reproduces its own precommit and binds one block", () => {
  assert.equal(definition.immutable, true);
  assert.equal(definition.executionBoundary.mainnetWriteAuthorized, false);
  assert.equal(definition.executionBoundary.capitalMovementAuthorized, false);
  assert.equal(definition.coherence.allMarketsReadAtSameBlock, true);
  assert.equal(definition.coherence.swapQuotesAtSameBlock, true);
  assert.equal(definition.coherence.gasPriceAtSameBlock, true);
  const { precommit, ...rest } = definition;
  const recomputed = contentHashes(rest);
  assert.equal(recomputed.sha256, precommit.canonicalSha256);
  assert.equal(recomputed.keccak256, precommit.manifestKeccak256);
});

test("the agent input is the exact frozen state and a tampered one is rejected", () => {
  const input = yieldBenchAgentInput(definition);
  assert.equal(validateYieldBenchAgentInput({ definition, input }).valid, true);
  assert.deepEqual(input.evidence.snapshot, definition.frozenEvidence.snapshot);
  const tampered = { ...definition, frozenEvidence: { snapshot: { ...snapshot, markets: snapshot.markets.slice(0, 3) } } };
  const result = validateYieldBenchAgentInput({ definition, input: yieldBenchAgentInput(tampered) });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("agent_input_does_not_match_frozen_definition"));
});

test("no public surface carries the decision, the ranking, or the evaluator", () => {
  const packet = publicYieldBenchPacket(definition);
  const source = publicYieldBenchSource(definition);
  const input = yieldBenchAgentInput(definition);
  assert.equal(packet.evaluator, undefined);
  assert.equal(packet.frozenEvidence, undefined);
  assert.equal(packet.policy, undefined);
  for (const surface of [packet, source, input]) {
    const text = JSON.stringify(surface);
    for (const secret of [truth.decisionTruth.reason, truth.hashes.keccak256]) assert.equal(text.includes(secret), false);
    assert.equal(text.includes("netBenefit"), false);
    assert.equal(text.includes("breakEvenDays") && surface !== packet, false);
  }
  // The option list must be visible; hiding it would make the task impossible.
  assert.equal(source.plainLanguage.options.length, snapshot.markets.length);
  assert.ok(source.plainLanguage.options.some((option) => option.isYourCurrentPosition));
  assert.equal(yieldContainsSecretAnswer(input), false);
});

test("the source packet is readable without developer knowledge", () => {
  const plain = publicYieldBenchSource(definition).plainLanguage;
  assert.match(plain.whatYouHold, /25000 USDC|25,000 USDC/);
  assert.match(plain.theQuestion, /30 days/);
  assert.ok(plain.options.every((option) => typeof option.supplyRatePctPerYear === "number"));
  assert.ok(plain.whatMovingCosts.swapCosts.length >= 2);
  assert.ok(plain.thingsWorthNoticing.length >= 3);
  assert.equal(JSON.stringify(plain).includes("supplyRatePerBlock"), false);
});

test("ground truth is deterministic and derives only from frozen state and policy", () => {
  const again = computeYieldGroundTruth(definition);
  assert.equal(again.hashes.keccak256, truth.hashes.keccak256);
  assert.equal(truth.computedFrom, "frozen_snapshot_and_precommitted_policy_only");
  assert.equal(truth.policyVersion, YIELD_POLICY.version);
  assert.ok(["MOVE", "HOLD"].includes(truth.decisionTruth.correctAction));
});

test("the evaluator reads meaning, not vocabulary", () => {
  assert.equal(affirmation("yeah, I'd move it"), true);
  assert.equal(affirmation("yes it is"), true);
  assert.equal(affirmation("nah, not worth it"), false);
  assert.equal(affirmation("I would not move"), false);
  assert.equal(affirmation("no idea"), null);
  assert.equal(isDeclined("no idea"), true);
  // "none" is a real answer to a risk question, not a decline.
  assert.equal(isDeclined("none"), false);
  assert.equal(isDeclined("no"), false);
  assert.deepEqual(extractNumbers("about 0.87 points, or 87 bps"), [0.87, 87]);
  assert.deepEqual(extractNumbers("25,000 USDC"), [25000]);
});

test("equivalent phrasings of a correct answer score alike", () => {
  const asset = truth.decisionTruth.correctAssetSymbol || truth.position.assetSymbol;
  const advantage = truth.arithmeticTruth ? truth.arithmeticTruth.yieldAdvantagePct : 0;
  const technical = {
    chosenOption: `The Venus ${asset} market.`,
    moveDecision: truth.decisionTruth.moveRecommended ? "Yes, move it." : "No, stay put.",
    yieldAdvantage: `${advantage} percentage points.`,
    worthItAfterCosts: truth.decisionTruth.moveRecommended ? `Yes, roughly ${truth.arithmeticTruth.incrementalReturnOverHorizon} over the horizon and it pays for itself immediately.` : "No, the costs outweigh it.",
    risksAndTradeoffs: "Thinner market to exit, different issuer, and the rate is variable so it can change.",
    boundedAction: truth.decisionTruth.moveRecommended ? "Move only the stated amount and review after the horizon." : "Leave it and monitor.",
  };
  const casual = {
    chosenOption: `I'd go with ${asset}.`,
    moveDecision: truth.decisionTruth.moveRecommended ? "Yeah I'd move it." : "Nah, leave it.",
    yieldAdvantage: `about ${Math.round(advantage * 100)} basis points`,
    worthItAfterCosts: truth.decisionTruth.moveRecommended ? `Yes, works out around ${Math.round(truth.arithmeticTruth.incrementalReturnOverHorizon)} dollars and costs basically nothing, so it pays off straight away.` : "Not worth it, the fees eat it.",
    risksAndTradeoffs: "Smaller pool so harder to get out, different company behind it, and rates float.",
    boundedAction: truth.decisionTruth.moveRecommended ? "Just the 25k, then check again." : "Do nothing, keep watching.",
  };
  const a = gradeYieldResponse({ truth, submission: technical, responder: "technical" });
  const b = gradeYieldResponse({ truth, submission: casual, responder: "casual" });
  assert.ok(a.qualityScore >= 85, `technical scored ${a.qualityScore}`);
  assert.ok(b.qualityScore >= 85, `casual scored ${b.qualityScore}`);
  assert.ok(Math.abs(a.qualityScore - b.qualityScore) <= 15);
});

test("the agent is graded by the same rubric as a person, and declining scores zero", () => {
  const agent = gradeYieldResponse({ truth, submission: yieldScoutSubmissionFromOutput(deliverable.output), structuredFor: yieldScoutStructuredView(deliverable.output), responder: "agent" });
  assert.equal(agent.groundTruthHash, truth.hashes.keccak256);
  assert.ok(agent.qualityScore >= 85);
  const repeat = gradeYieldResponse({ truth, submission: yieldScoutSubmissionFromOutput(deliverable.output), structuredFor: yieldScoutStructuredView(deliverable.output), responder: "agent" });
  assert.equal(repeat.hashes.keccak256, agent.hashes.keccak256);
  const declined = gradeYieldResponse({ truth, submission: Object.fromEntries(["chosenOption", "moveDecision", "yieldAdvantage", "worthItAfterCosts", "risksAndTradeoffs", "boundedAction"].map((field) => [field, "no idea"])), responder: "declined" });
  assert.equal(declined.qualityScore, 0);
  assert.equal(declined.declinedDimensions.length, 6);
});

test("claiming a move is risk free is penalised as an unsupported claim", () => {
  const base = { chosenOption: truth.decisionTruth.correctAssetSymbol || "USDC", moveDecision: "Yes", yieldAdvantage: `${truth.arithmeticTruth?.yieldAdvantagePct ?? 0} points`, worthItAfterCosts: "Yes it pays for itself immediately", boundedAction: "Move only that amount then review" };
  const honest = gradeYieldResponse({ truth, submission: { ...base, risksAndTradeoffs: "Thinner market, different issuer, and the rate is variable." }, responder: "honest" });
  const reckless = gradeYieldResponse({ truth, submission: { ...base, risksAndTradeoffs: "none, it is risk free" }, responder: "reckless" });
  assert.ok(reckless.qualityScore < honest.qualityScore);
  assert.ok(reckless.unsupportedClaims.includes("risksAndTradeoffs.no_risk_free_claim"));
});

test("the human baseline preserves the raw submission and refuses partial answers", () => {
  const attempt = createYieldBaselineAttempt({ benchmarkId: "YieldBench_v1" });
  assert.equal(attempt.status, "started");
  assert.throws(() => completeYieldBaseline({ attempt, submission: { chosenOption: "USDT" } }), /missing required fields/);
  const submission = { chosenOption: "a", moveDecision: "b", yieldAdvantage: "c", worthItAfterCosts: "d", risksAndTradeoffs: "e", boundedAction: "f" };
  const completed = completeYieldBaseline({ attempt, submission, elapsedMs: 4321 });
  assert.equal(completed.status, "submitted");
  assert.equal(completed.elapsedMs, 4321);
  assert.deepEqual(completed.submission, submission);
  assert.throws(() => completeYieldBaseline({ attempt: completed, submission }), /A started YieldBench baseline is required/);
});

test("the track record starts empty and is settled only against a later read", () => {
  const empty = summarizeYieldTrackRecord({ decisions: [] });
  assert.equal(empty.hasEnoughObservations, false);
  assert.equal(empty.advantagePersistenceRate, null);
  assert.equal(empty.minimumObservations, MINIMUM_OBSERVATIONS_FOR_RATE);
  assert.match(empty.statement, /Not enough observations/);
  const decision = recordYieldDecision({ decisionId: "d1", snapshot, deliverable: deliverable.output });
  assert.equal(decision.outcome, null);
  assert.match(decision.outcomeNote, /Not yet observed/);
  assert.throws(() => settleYieldDecision({ decision, followUpSnapshot: snapshot }), /must be later/);
  const later = { ...snapshot, asOfBlock: "118600000", blockTimestamp: snapshot.blockTimestamp + 86_400 };
  const settled = settleYieldDecision({ decision, followUpSnapshot: later });
  assert.ok(["advantage_persisted", "advantage_did_not_persist", "unmeasurable"].includes(settled.outcome.verdict));
  assert.match(settled.outcome.note, /not a full return accounting/);
  assert.equal(summarizeYieldTrackRecord({ decisions: [settled] }).hasEnoughObservations, false);
});

test("the control uses the same evidence and is never TermiX evidence", () => {
  const control = buildIndependentYieldControl({ task: yieldBenchProviderTask(definition) });
  assert.equal(control.provenance.independent, true);
  assert.equal(control.provenance.humanBaseline, false);
  assert.equal(control.provenance.termixEligible, false);
  assert.equal(control.output.origin, "CANNED_INDEPENDENT_CONTROL");
  assert.equal(control.output.execution.mode, "control_only");
  assert.equal(control.output.decision.action, deliverable.output.decision.action);
});

test("Yield Scout metadata is first-party, Venus-scoped, and recommendation-only", () => {
  const metadata = publicReferenceMetadata({ agentUrl: "https://yield-scout.example/erc8183", providerAddress: yieldProvider, referenceKey: "yield" });
  assert.equal(metadata.name, "Canned Yield Scout");
  assert.equal(metadata.category, CATEGORY_LABELS[CATEGORIES.YIELD_OPTIMISATION]);
  assert.equal(metadata.venue, "Venus");
  assert.equal(metadata.origin, "CANNED_REFERENCE");
  assert.equal(metadata.version, "yield-scout-service-v1");
  assert.equal(metadata.executionPolicy.capitalMovement, false);
  const others = ["health-factor", "rebalancing"].map((key) => publicReferenceMetadata({ agentUrl: "https://x.example/erc8183", providerAddress: "0x1", referenceKey: key }));
  assert.equal(others.some((entry) => entry.version === metadata.version), false);
  assert.equal(others.some((entry) => entry.category === metadata.category), false);
});

test("three reference agents share no namespace, wallet, identity, or port", () => {
  assert.deepEqual(referenceNamespaceCollisions(), []);
  const keys = ["health-factor", "rebalancing", "yield"];
  for (const key of keys) {
    assert.ok(REFERENCE_IDENTITY_FILES[key], `${key} needs an identity file`);
    assert.ok(REFERENCE_WALLET_PATHS[key], `${key} needs a wallet path`);
    assert.ok(REFERENCE_NAMESPACES[key], `${key} needs a namespace`);
  }
  assert.equal(new Set(keys.map((key) => REFERENCE_NAMESPACES[key].port)).size, 3);
  assert.equal(new Set(keys.map((key) => REFERENCE_WALLET_PATHS[key].walletsDir)).size, 3);
  assert.deepEqual(referenceFleetIdentityFailures({
    "health-factor": { agentId: 2003, registry, endpoint: "https://a/erc8183", origin: "CANNED_REFERENCE" },
    rebalancing: { agentId: 2005, registry, endpoint: "https://b/erc8183", origin: "CANNED_REFERENCE" },
    yield: { agentId: 2007, registry, endpoint: "https://c/erc8183", origin: "CANNED_REFERENCE" },
  }), []);
  const clash = referenceFleetIdentityFailures({
    rebalancing: { agentId: 2005, registry, endpoint: "https://b/erc8183" },
    yield: { agentId: 2005, registry, endpoint: "https://c/erc8183" },
  });
  assert.ok(clash.some((entry) => entry.startsWith("shared_erc8004_identity")));
});

test("readiness fails closed on the wrong category or a blind watcher", () => {
  const base = {
    agentUrl: "https://yield-scout.example/erc8183",
    health: { ok: true, body: { chainId: 97, endpointAlive: true } },
    readiness: { ok: true, body: { network: "bsc-testnet", chainId: 97, endpoint: { transport: "public_http", url: "https://yield-scout.example/erc8183" }, worker: { alive: true }, watcher: { alive: true }, storage: { public: true, localFilesystemPresentedAsEvidence: false }, providerAddress: yieldProvider, rpc: { capable: true, usingSdkDefault: false } } },
    status: { ok: true, body: { chainId: 97, paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", provider: yieldProvider } },
    metadata: { ok: true, body: { origin: "CANNED_REFERENCE", chainId: 97, category: "Yield Optimisation", protocols: [{ verifyingContract: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE", endpoint: "https://yield-scout.example/erc8183" }] } },
    expectedCategory: "Yield Optimisation",
  };
  assert.deepEqual(publicReadinessFailures(base), []);
  assert.ok(publicReadinessFailures({ ...base, expectedCategory: "Rebalancing" }).includes("metadata_category_mismatch"));
  const blind = publicReadinessFailures({ ...base, readiness: { ...base.readiness, body: { ...base.readiness.body, rpc: { capable: false, usingSdkDefault: true } } } });
  assert.ok(blind.includes("rpc_cannot_serve_verify_job_log_span"));
  assert.ok(blind.includes("sdk_rpc_override_not_set"));
});

test("Yield Scout is not hireable before registration and adds nothing to public counts", () => {
  const spec = REFERENCE_AGENT_SPECS.find((item) => item.key === "yield");
  const candidate = referenceAgentCandidate(spec, { providerAddress: yieldProvider, allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: false });
  assert.equal(candidate.erc8004.status, "not_registered");
  assert.equal(candidate.selectionGate.readiness.ready, false);
  assert.equal(selectHiringAdapter(candidate, { chainId: 97 }).status, "blocked");
  const record = deriveAgentRecord(candidate, []);
  assert.equal(record.origin, "CANNED_REFERENCE");
  assert.equal(record.reference, true);
  assert.equal(record.trust.deliveryCount, 0);
  assert.equal(record.trust.benchmarkCount, 0);
  assert.equal(record.trust.states.BENCHMARKED, false);
  const metrics = deriveMarketplaceMetrics({ candidates: [candidate], runs: [] });
  assert.equal(metrics.jobsPaidForAndGraded, 0);
  assert.equal(metrics.categories.yield_optimisation.delivered, 0);
  assert.equal(metrics.categories.yield_optimisation.benchmarked, 0);
  // Three implemented agents, one still planned; the fleet does not overclaim.
  const catalog = referenceFleetCatalog();
  assert.equal(catalog.filter((item) => item.implementationStatus === "implemented").length, 3);
  assert.equal(catalog.filter((item) => item.implementationStatus === "planned").length, 1);
  assert.equal(implementedReferenceAgentCandidates({ allowLocalProbe: false }).length, 3);
});
