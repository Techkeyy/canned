/**
 * Directive #20 tests: the corrective paid run, the executable-route decision,
 * the token acquisition, and the real bounded Altana session.
 *
 * Nothing here performs a blockchain write. Chain facts come from the evidence
 * records the live runs produced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { GRID_TESTNET_VENUE, GRID_EXECUTION_MODEL, planGridStrategy, gridTaskResult, buildGridBenchDeliverable } from "../src/reference/grid-keeper.mjs";
import { buildGridBenchmarkDefinition } from "../src/reference/grid-benchmark.mjs";
import { computeGridGroundTruth, gradeGridBenchResponse } from "../src/reference/grid-evaluator.mjs";
import { buildLeash, LEASH_STATES } from "../src/marketplace/leash.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { RUN_TYPES } from "../src/domain.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readState = (name) => JSON.parse(readFileSync(path.join(root, "data", "state", name), "utf8"));
const ACTION_WALLET = "0xbb62a403f8b582b49bcb05e1a7a678da4ebde48f";
const V2_ROUTER = "0xd99d1c33f9fc3444f8101754abc46c52416550d1";
const V2_SELECTOR = "0x38ed1739";
const USDT = "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd";

/* ------------------------------------------------------ the deliverable fix */

test("the preflight proved the runtime contract before any second payment", () => {
  const preflight = readState("grid-deliverable-preflight.json");
  assert.equal(preflight.passed, true);
  assert.equal(preflight.fundsSpent, "none");
  assert.equal(preflight.transactionsSent, 0);
  assert.equal(preflight.runtimeContract.ok, true);
  assert.equal(preflight.runtimeContract.outputPresent, true);
  assert.ok(preflight.runtimeContract.canonicalOutputBytes > 1000, "canonical output must not be empty");
  assert.equal(preflight.jsonBoundary.serialisable, true);
  assert.equal(preflight.validation.valid, true);
  assert.deepEqual(preflight.failures, []);
});

test("a deliverable still submits empty if the runtime wrapper is skipped", () => {
  // The exact defect that cost job 835, kept as a live regression.
  const definition = buildGridBenchmarkDefinition();
  const built = buildGridBenchDeliverable({ jobId: 1, task: "t", definition });
  assert.equal(built.output, undefined);
  const wrapped = gridTaskResult(built);
  assert.ok(wrapped.output);
  assert.ok(wrapped.canonicalOutput.length > 1000);
});

/* ------------------------------------------------------- both Grid attempts */

test("both Grid paid runs are preserved, the failure and the correction", () => {
  const files = readdirSync(path.join(root, "data", "state")).filter((name) => name.startsWith("gridbench-run-"));
  assert.equal(files.length, 2, "the failed attempt must not be deleted or overwritten");

  const runs = files.map((name) => readState(name));
  const failed = runs.find((run) => String(run.jobId) === "835");
  const corrective = runs.find((run) => String(run.jobId) !== "835");

  assert.ok(failed, "job 835 must remain");
  assert.equal(failed.deliverable.validation.valid, false);
  assert.equal(failed.terminalState, "error");
  assert.ok(failed.deliverable.validation.errors.length > 0);

  assert.ok(corrective, "the corrective run must exist");
  assert.equal(corrective.deliverable.validation.valid, true);
  assert.deepEqual(corrective.deliverable.validation.errors, []);
  assert.equal(corrective.chainState, "COMPLETED");
  assert.equal(corrective.terminalState, "completed");
  assert.equal(corrective.economics.serviceFeeRaw, "1000000000000000");
  assert.equal(corrective.economics.allowanceAfterRaw, "0");
});

test("the corrective run was graded from the paid deliverable, not from a local test", () => {
  const files = readdirSync(path.join(root, "data", "state")).filter((name) => name.startsWith("gridbench-grading-"));
  const gradings = files.map((name) => readState(name));
  const graded = gradings.find((entry) => entry.outcome === "graded");
  const notGradable = gradings.find((entry) => entry.deliveryFailed === true);

  assert.ok(graded, "the corrective run must have a grading");
  assert.equal(graded.qualityScore, 100);
  assert.equal(graded.passedCount, graded.scenarioCount);
  assert.equal(graded.evaluator.llmGraded, false);
  assert.equal(graded.evaluator.groundTruthSource, "frozen_specification");
  assert.equal(graded.precommit.sha256, buildGridBenchmarkDefinition().precommit.sha256, "the benchmark was not edited after the run");

  // The empty one is recorded as absent, not as a score of zero.
  assert.ok(notGradable, "the failed delivery must still be recorded");
  assert.equal(notGradable.outcome, "not_gradable_no_answers_delivered");
  assert.equal(notGradable.qualityScore, null);
});

test("a deterministic grading with no pair yields no win and no loss", () => {
  const gridRun = {
    runId: "g", runType: RUN_TYPES.BENCHMARK, createdAt: "2026-08-31T13:00:00Z",
    agent: { identity: "97:0xreg:2045" },
    protocolJob: { funded: true, jobId: 837, currentState: "COMPLETED", events: [] },
    qualification: { hasRealPayment: true, hasActualDeliverable: true, qualifiesForPublicMetrics: true },
    evaluation: { status: "completed", metrics: { qualityScore: 100, agentAdvantage: null, pairedComparison: false } },
  };
  const metrics = deriveMarketplaceMetrics({ candidates: [], runs: [gridRun] });
  assert.equal(metrics.qualifyingBenchmarks, 1, "it counts as paid and graded");
  // agentAdvantage is null, so it is neither.
  assert.equal(metrics.wins, 0);
  assert.equal(metrics.losses, 0);
});

/* ---------------------------------------------------- the executable route */

test("the permission names the route that works, not the one that was planned", () => {
  const verification = readState("execution-route-verification.json");
  assert.equal(verification.readOnly, true);
  assert.equal(verification.transactionsSent, 0);
  assert.equal(verification.v3.quoterResponds, false, "the V3 quoter reverts on this network");
  assert.equal(verification.v3.executable, false);
  assert.equal(verification.v2.quoteResponds, true);
  assert.equal(verification.decision.chosenRouter, V2_ROUTER);
  assert.equal(verification.decision.chosenSelector, V2_SELECTOR);
});

test("the live venue points at the V2 router and records why V3 was rejected", () => {
  assert.equal(GRID_TESTNET_VENUE.router, V2_ROUTER);
  assert.equal(GRID_TESTNET_VENUE.swapSelector, V2_SELECTOR);
  assert.equal(GRID_TESTNET_VENUE.routerVersion, "PancakeSwap V2");
  assert.equal(GRID_TESTNET_VENUE.notExecutable.reason, "quoter_reverts_on_bsc_testnet");

  const planned = planGridStrategy({
    strategyId: "route",
    pair: { baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt, baseSymbol: "WBNB", quoteSymbol: "USDT" },
    lowerPriceMinor: 600n * 10n ** 18n, upperPriceMinor: 800n * 10n ** 18n, levelCount: 4,
    totalCapitalMinor: 15n * 10n ** 17n, maxPerLevelMinor: 10n ** 18n,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.deepEqual(planned.authority.allowedContracts, [V2_ROUTER]);
  assert.equal(planned.authority.allowedContracts.includes(GRID_TESTNET_VENUE.notExecutable.smartRouterV3), false);
});

test("the execution model says V2 and still never claims a native order", () => {
  assert.equal(GRID_EXECUTION_MODEL.isNativeLimitOrder, false);
  assert.equal(GRID_EXECUTION_MODEL.routerVersion, "PancakeSwap V2");
  assert.match(GRID_EXECUTION_MODEL.summary, /PancakeSwap V2 swap/);
  assert.ok(GRID_EXECUTION_MODEL.evidence.some((line) => /QuoterV2 reverts/i.test(line)));
});

/* ------------------------------------------------------- token acquisition */

test("the acquisition stayed inside its ceiling and used a bounded approval", () => {
  const record = readState("testnet-usdt-acquisition.json");
  assert.equal(record.chainId, 97);
  assert.equal(record.mainnetWrite, false);
  assert.equal(record.token.address, "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd");
  assert.equal(record.token.decimals, 18);

  // 0.12 tBNB was the authorized ceiling.
  assert.ok(BigInt(record.input.amountInWei) <= 120_000_000_000_000_000n, "input exceeded the ceiling");
  assert.equal(record.input.ceilingWei, "120000000000000000");
  assert.ok(BigInt(record.output.receivedRaw) >= 1_200_000_000_000_000_000n, "below the 1.2 USDT minimum");

  assert.equal(record.approvals.unlimited, false);
  assert.equal(record.approvals.grantedRaw, record.input.amountInWei, "approval was for exactly the swap amount");
  assert.equal(record.approvals.residualAfterRaw, "0", "no residual router allowance");
  assert.equal(record.route.router, "0xD99D1c33F9fC3444f8101754aBC46c52416550D1");
});

test("only the proof amount reached the action wallet", () => {
  const record = readState("testnet-usdt-acquisition.json");
  const moved = BigInt(record.transferredToActionRaw);
  assert.ok(moved >= 1_200_000_000_000_000_000n && moved <= 1_500_000_000_000_000_000n, "outside the authorized 1.2 to 1.5 band");
  assert.equal(BigInt(record.balances.actionUsdtAfterRaw) - BigInt(record.balances.actionUsdtBeforeRaw), moved);
});

/* ----------------------------------------------------- the bounded session */

test("the session was scoped to one contract, one method and one token", () => {
  const session = readState("grid-session.json").session;
  assert.equal(session.chainId, 97);
  assert.equal(String(session.owner).toLowerCase(), ACTION_WALLET);
  assert.equal(session.permissions.calls.length, 1);
  assert.equal(session.permissions.calls[0].to.toLowerCase(), V2_ROUTER);
  assert.equal(session.permissions.calls[0].selector, V2_SELECTOR);
  assert.equal(session.permissions.spend.length, 1);
  assert.equal(session.permissions.spend[0].token.toLowerCase(), USDT);
  assert.ok(BigInt(session.permissions.spend[0].limit) <= 1_500_000_000_000_000_000n);
  assert.ok(BigInt(session.strategyCaps.perTransactionRaw) <= 1_000_000_000_000_000_000n);
  assert.equal(session.strategyCaps.maxFills, 1);
  assert.ok(session.expiry * 1000 - Date.parse(session.expiresAt) === 0);
});

test("the proof records a refused execution, a revocation, and no residual authority", () => {
  const proof = readState("altana-proof.json");
  // A real grant and a real revocation, both on chain.
  assert.match(proof.steps.granted.transactionHash, /^0x[0-9a-f]{64}$/i);
  assert.match(proof.steps.revocation.transactionHash, /^0x[0-9a-f]{64}$/i);
  assert.deepEqual(proof.steps.verification.broaderThanIntended, []);

  // The execution was refused by the validator. Nothing moved.
  assert.equal(proof.steps.execution.succeeded, false);
  assert.match(proof.steps.execution.error, /NoSpendPermissions/);
  assert.equal(proof.steps.execution.balances.usdtSpentRaw, "0");
  assert.equal(proof.steps.execution.balances.wbnbReceivedRaw, "0");

  assert.equal(proof.steps.revokedKeyRefused.refused, true);
  assert.equal(proof.steps.allowanceCleared.residualAllowanceRaw, "0");
});

test("the session key is not the owner key, and is not retained after revocation", () => {
  const proof = readState("altana-proof.json");
  assert.equal(proof.steps.verification.checks.sessionKeyIsNotTheOwner, true);
  const key = readState("grid-session-key.json");
  assert.equal(key.retained, false, "a dead session key is a secret with no purpose");
  assert.equal("privateKey" in key, false);
});

test("nothing in the evidence claims a profitable or market-meaningful trade", () => {
  const proof = readState("altana-proof.json");
  assert.ok(proof.claimBoundary.proves.some((line) => /bounded session/i.test(line)));
  assert.ok(proof.claimBoundary.doesNotProve.some((line) => /profitable/i.test(line)));
  assert.ok(proof.claimBoundary.doesNotProve.some((line) => /testnet market price/i.test(line)));
  const serialised = JSON.stringify(proof);
  assert.equal(/\bprofit\b(?!able strategy)/i.test(serialised.replace(/profitable strategy/gi, "")), false);
});

test("The Leash reports REVOKED from the stored session, not from a guess", () => {
  const record = readState("grid-session.json");
  const strategy = readState("grid-strategy.json").strategy;
  const session = { ...record.session, publicKey: record.session.sessionPublicKey };
  const leash = buildLeash({ strategy, session, network: { chainId: 97, keyStore: "0xks", explorer: "https://x" }, revoked: record.revoked });

  assert.equal(leash.state, LEASH_STATES.REVOKED);
  assert.equal(leash.revocable, false);
  assert.equal(leash.unrestrictedRules.length, 0);
  assert.equal(leash.contracts[0].contract, V2_ROUTER);
  assert.equal(leash.contracts[0].selector, V2_SELECTOR);
  assert.match(leash.summary, /revoked/i);
});

test("Altana qualification is not claimed while the execution has not succeeded", () => {
  const proof = readState("altana-proof.json");
  const requirements = {
    realOnchainSession: Boolean(proof.steps.granted.transactionHash),
    boundedPermission: proof.steps.verification.broaderThanIntended.length === 0,
    exactAllowlist: proof.steps.granted.permissions.calls.length === 1,
    spendCap: proof.steps.granted.permissions.spend.length === 1,
    expiry: Number(proof.steps.granted.expiry) > 0,
    realSessionKeyTransaction: proof.steps.execution.succeeded === true,
    revocation: Boolean(proof.steps.revocation.transactionHash),
    revokedStateVerified: proof.steps.revokedKeyRefused.refused === true,
  };
  // Every requirement but the execution is met, and one unmet requirement is
  // enough. The flag must stay false rather than round up.
  assert.equal(requirements.realSessionKeyTransaction, false);
  assert.equal(Object.values(requirements).every(Boolean), false);
});
