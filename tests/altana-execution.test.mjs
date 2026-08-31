/**
 * Directive #21 tests: the relay fee model, the two-permission session, the
 * real session-key execution, and the revocation that followed it.
 *
 * No blockchain writes and no network. Chain facts come from the evidence the
 * live proof produced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildLeash, LEASH_STATES } from "../src/marketplace/leash.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { RUN_TYPES } from "../src/domain.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readState = (name) => JSON.parse(readFileSync(path.join(root, "data", "state", name), "utf8"));

const ACTION_WALLET = "0xbb62a403f8b582b49bcb05e1a7a678da4ebde48f";
const V2_ROUTER = "0xd99d1c33f9fc3444f8101754abc46c52416550d1";
const V2_SELECTOR = "0x38ed1739";
const USDT = "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd";
const NATIVE = "0x0000000000000000000000000000000000000000";
const ORCHESTRATOR = "0xcb5cef3c54aa90e9a7ad602a258d3d360cc862b9";
const ONE_USDT = 1_000_000_000_000_000_000n;

const proof = () => readState("altana-final-proof.json");

/* ------------------------------------------------------------ the fee model */

test("the relay advertises only the native token as a fee token, and USDT is refused", () => {
  const fee = proof().steps.feeModel;
  assert.equal(fee.usdtSupportedAsFeeToken, false);
  assert.equal(fee.nativeSupportedAsFeeToken, true);
  assert.equal(fee.advertisedFeeTokens.length, 1);
  assert.equal(String(fee.advertisedFeeTokens[0].address).toLowerCase(), NATIVE);

  // The preferred design was attempted and refused, not assumed impossible.
  const attempt = proof().steps.usdtFeeAttempt;
  assert.equal(attempt.accepted, false);
  assert.match(attempt.error, /fee token not supported/i);
});

test("the SDK default is the native token, which is why the earlier session was refused", () => {
  const execute = readFileSync(path.join(root, "node_modules", "@altananetwork", "sdk", "dist", "execute.js"), "utf8");
  assert.match(execute, /const feeToken = opts\.feeToken \?\? NATIVE_TOKEN/);
  assert.match(execute, /const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000"/);

  // The refusal it caused is still on the record from Directive #20.
  const previous = readState("altana-proof.json");
  assert.equal(previous.steps.execution.succeeded, false);
  assert.match(previous.steps.execution.error, /NoSpendPermissions/);
});

test("the native fee cap is measured from the relay quote, never from the wallet balance", () => {
  const measurement = proof().steps.feeMeasurement;
  assert.match(measurement.source, /intent\.paymentMaxAmount/);
  assert.equal(String(measurement.paymentToken).toLowerCase(), NATIVE);

  const measured = BigInt(measurement.measuredNativeFeeWei);
  const cap = BigInt(measurement.nativeSpendCapWei);
  assert.ok(measured > 0n, "a fee of zero would not be a measurement");
  assert.equal(cap, measured * BigInt(measurement.marginMultiplier));
  assert.ok(cap <= BigInt(measurement.hardCeilingWei), "the cap must respect the hard ceiling");

  // The wallet held far more than this. The cap is not the balance.
  const nativeHeld = BigInt(proof().steps.execution.balances.nativeBeforeWei);
  assert.ok(cap < nativeHeld / 10n, "the fee cap must be a small fraction of the balance");
  // And far smaller than the trade itself.
  assert.ok(cap < ONE_USDT / 1000n, "the fee allowance must not resemble trading capital");
});

/* --------------------------------------------------------- the precommit */

test("the execution was precommitted before the session existed", () => {
  const precommit = readState("altana-execution-precommit.json");
  assert.equal(precommit.chainId, 97);
  assert.equal(String(precommit.actionWallet).toLowerCase(), ACTION_WALLET);
  assert.equal(String(precommit.router).toLowerCase(), V2_ROUTER);
  assert.equal(precommit.selector, V2_SELECTOR);
  assert.equal(String(precommit.tradeToken).toLowerCase(), USDT);
  assert.equal(String(precommit.feeToken).toLowerCase(), NATIVE);
  assert.equal(precommit.maxFills, 1);
  assert.ok(BigInt(precommit.tradeMaxRaw) <= ONE_USDT);
  assert.ok(precommit.hashes.sha256.startsWith("sha256:"));

  // What was precommitted is what was granted.
  const granted = proof().steps.granted;
  assert.equal(String(granted.permissions.calls[0].to).toLowerCase(), String(precommit.router).toLowerCase());
  assert.equal(granted.permissions.calls[0].selector, precommit.selector);
});

/* ------------------------------------------------ the two-permission session */

test("the session allows one contract and one method, and two spend rules with different jobs", () => {
  const granted = proof().steps.granted;
  assert.equal(granted.permissions.calls.length, 1);
  assert.equal(String(granted.permissions.calls[0].to).toLowerCase(), V2_ROUTER);
  assert.equal(granted.permissions.calls[0].selector, V2_SELECTOR);

  assert.equal(granted.permissions.spend.length, 2);
  const trade = granted.permissions.spend.find((entry) => String(entry.token).toLowerCase() === USDT);
  const fee = granted.permissions.spend.find((entry) => String(entry.token).toLowerCase() === NATIVE);
  assert.ok(trade, "a USDT trade permission must exist");
  assert.ok(fee, "a native fee permission must exist");
  assert.equal(trade.purpose, "trade capital");
  assert.equal(fee.purpose, "relay fee only");
  // The fee permission must be orders of magnitude smaller than the trade one.
  assert.ok(BigInt(fee.limit) * 1000n < BigInt(trade.limit));
});

test("every verification check passed and nothing was broader than intended", () => {
  const verification = proof().steps.verification;
  assert.deepEqual(verification.broaderThanIntended, []);
  assert.equal(Object.values(verification.checks).every((value) => value === true), true);
  assert.equal(verification.checks.nativeCapIsTiny, true);
  assert.equal(verification.checks.sessionKeyIsNotOwner, true);
  assert.equal(verification.checks.expiryWithinOneHour, true);
});

/* ------------------------------------------------------------- the execution */

test("one real session-key transaction executed inside both caps", () => {
  const execution = proof().steps.execution;
  assert.equal(execution.succeeded, true);
  assert.equal(execution.error, null);
  assert.match(execution.transactionHash, /^0x[0-9a-f]{64}$/i);
  assert.equal(execution.signedBy, "altana_session_key");
  assert.equal(String(execution.router).toLowerCase(), V2_ROUTER);
  assert.equal(execution.selector, V2_SELECTOR);
  assert.equal(String(execution.feeToken).toLowerCase(), NATIVE);

  // Exactly one fill, at or under the 1 USDT ceiling.
  assert.equal(execution.fillsUsed, 1);
  assert.equal(execution.maxFills, 1);
  const spent = BigInt(execution.balances.usdtSpentRaw);
  assert.ok(spent > 0n && spent <= ONE_USDT, `spent ${spent} outside the bound`);
  assert.equal(execution.withinTradeCap, true);
  assert.equal(execution.withinNativeCap, true);

  // Real output was received, and the fee came out of native, not the trade.
  assert.ok(BigInt(execution.balances.wbnbReceivedRaw) > 0n);
  assert.ok(BigInt(execution.balances.nativeSpentWei) > 0n);
  assert.ok(BigInt(execution.balances.nativeSpentWei) <= BigInt(proof().steps.feeMeasurement.nativeSpendCapWei));
});

test("the transaction is independently verified as a session path, not an owner signature", () => {
  const onchain = proof().steps.onchainVerification;
  assert.equal(onchain.receiptStatus, "success");
  assert.equal(onchain.entryIsAltanaOrchestrator, true);
  assert.equal(String(onchain.entryContract).toLowerCase(), ORCHESTRATOR);
  // The owner EOA did not submit it; the relay did.
  assert.equal(onchain.submittedByOwner, false);
  assert.notEqual(String(onchain.submittedBy).toLowerCase(), ACTION_WALLET);
  // And it really reached PancakeSwap.
  assert.equal(onchain.pancakeV2PairTouched, true);
  assert.equal(onchain.v2SwapEventEmitted, true);
});

/* ------------------------------------------------------ revocation and after */

test("the session was revoked and the key is gone from the account on chain", () => {
  const steps = proof().steps;
  assert.match(steps.revocation.transactionHash, /^0x[0-9a-f]{64}$/i);
  assert.equal(steps.revokedKeyRefused.refused, true);
  assert.equal(steps.revokedKeyRefused.verdict, "REJECTED_BECAUSE_REVOKED");

  // Stronger than the refusal message: the account no longer lists the key.
  const check = steps.revokedKeyRefused.onchainKeyCheck;
  assert.equal(check.sessionKeyStillAuthorized, false);
  assert.equal(check.verdict, "SESSION_KEY_REMOVED_FROM_ACCOUNT");
  assert.equal(check.remainingKeysAreAdminOnly, true);
  // Nothing moved on the refused attempt.
  assert.equal(steps.revokedKeyRefused.usdtUnchangedAfterAttempt, true);
});

test("no standing approval or retained session key is left behind", () => {
  assert.equal(proof().steps.allowanceCleared.residualAllowanceRaw, "0");
  const key = readState("grid-session-key.json");
  assert.equal(key.retained, false);
  assert.equal("privateKey" in key, false);
  assert.equal(readState("grid-session.json").revoked, true);
});

/* ------------------------------------------------------------- The Leash */

test("The Leash separates trading capital from the network fee allowance", () => {
  // Presenting the relay fee as money the agent may trade with would
  // overstate what the user granted.
  const record = readState("grid-session.json");
  const strategy = readState("grid-strategy.json").strategy;
  const session = { ...record.session, publicKey: record.session.sessionPublicKey };
  const network = { chainId: 97, keyStore: "0xks", explorer: "https://x", chain: { name: "BNB Smart Chain Testnet", nativeCurrency: { symbol: "tBNB" } } };
  const active = buildLeash({ strategy, session, network, revoked: false, now: (session.expiry - 60) * 1000 });

  assert.equal(active.state, LEASH_STATES.ACTIVE);
  assert.equal(active.tradeCapital.length, 1);
  assert.equal(active.tradeCapital[0].purpose, "trade_capital");
  assert.equal(active.networkFeeAllowance.length, 1);
  assert.equal(active.networkFeeAllowance[0].purpose, "network_fee_only");
  assert.equal(active.networkFeeAllowance[0].tokenSymbol, "tBNB");
  // The fee line says what it is, in a user's words.
  assert.ok(active.can.some((line) => /network fee/i.test(line)));
  assert.ok(active.can.some((line) => /trading cap/i.test(line)));
});

test("The Leash moves ACTIVE to REVOKED from the same real session data", () => {
  const record = readState("grid-session.json");
  const strategy = readState("grid-strategy.json").strategy;
  const session = { ...record.session, publicKey: record.session.sessionPublicKey };
  const at = (session.expiry - 60) * 1000;

  assert.equal(buildLeash({ strategy, session, revoked: false, now: at }).state, LEASH_STATES.ACTIVE);
  assert.equal(buildLeash({ strategy, session, revoked: true, now: at }).state, LEASH_STATES.REVOKED);
  assert.equal(buildLeash({ strategy, session, revoked: true, now: at }).revocable, false);
  // Expiry alone also ends it, with no revocation needed.
  assert.equal(buildLeash({ strategy, session, revoked: false, now: (session.expiry + 60) * 1000 }).state, LEASH_STATES.EXPIRED);
});

/* --------------------------------------------------------- what it may claim */

test("the Altana requirement set is now fully met, and derived rather than asserted", () => {
  const steps = proof().steps;
  const requirements = {
    boundedSession: steps.verification.broaderThanIntended.length === 0,
    callAllowlist: steps.granted.permissions.calls.length === 1,
    spendCap: steps.granted.permissions.spend.some((entry) => String(entry.token).toLowerCase() === USDT),
    expiry: Number(steps.granted.expiry) > 0,
    onchainRegistration: Boolean(steps.granted.transactionHash),
    realSessionKeyTransaction: steps.execution.succeeded === true && Boolean(steps.execution.transactionHash),
    visiblePermissions: true,
    revocation: Boolean(steps.revocation.transactionHash),
    revokedStateVerified: steps.revokedKeyRefused.onchainKeyCheck.sessionKeyStillAuthorized === false,
  };
  assert.equal(Object.values(requirements).every(Boolean), true, `unmet: ${Object.entries(requirements).filter(([, v]) => !v).map(([k]) => k)}`);
});

test("the execution claims capability and never claims profit", () => {
  const boundary = proof().claimBoundary;
  assert.ok(boundary.proves.some((line) => /session-key transaction/i.test(line)));
  assert.ok(boundary.doesNotProve.some((line) => /profitable/i.test(line)));
  assert.ok(boundary.doesNotProve.some((line) => /testnet market price/i.test(line)));
});

/* -------------------------------------------------- nothing else moved */

test("the Altana execution is not a job, a benchmark, or an Agent Advantage win", () => {
  // It carries no run type, no benchmark id and no pair, so no metric can
  // pick it up as agent performance.
  const serialised = JSON.stringify(proof());
  assert.equal(/gridbench-v1/.test(serialised), false, "the proof must not reference the benchmark");
  assert.equal(/agentAdvantage/.test(serialised), false);
  assert.equal(/termix/i.test(serialised), false);

  // A metrics pass over only this evidence yields nothing.
  const metrics = deriveMarketplaceMetrics({ candidates: [], runs: [] });
  assert.equal(metrics.qualifyingBenchmarks, 0);
  assert.equal(metrics.wins, 0);
  assert.equal(metrics.losses, 0);
});

test("the four graded runs and three pairs are untouched by this directive", () => {
  const stored = readState("benchmark-runs.json");
  const runs = Array.isArray(stored) ? stored : stored.runs;
  const benchmarkRuns = runs.filter((run) => run.runType === RUN_TYPES.BENCHMARK);
  const graded = benchmarkRuns.filter((run) => run.qualification?.qualifiesForPublicMetrics === true);
  assert.equal(graded.length, 4, "four paid and graded runs");

  const wins = graded.filter((run) => run.evaluation?.metrics?.agentAdvantage === true).length;
  const losses = graded.filter((run) => run.evaluation?.metrics?.agentAdvantage === false).length;
  assert.equal(wins, 2);
  assert.equal(losses, 1);
  // The fourth is the Grid run, which is neither.
  assert.equal(graded.filter((run) => run.evaluation?.metrics?.agentAdvantage === null).length, 1);
});
