/**
 * Directive #19 tests: what a paid Grid run is allowed to change, the delivery
 * rule that decides it, the action wallet's separation, and the exact token
 * the Altana execution proof depends on.
 *
 * Nothing here performs a blockchain write. Chain facts are read from the
 * evidence records the paid run and the research step already produced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deriveTrustStates, deriveAgentStatus, delivered } from "../src/marketplace/model.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { deriveQualificationFlags } from "../src/benchmark/framework.mjs";
import { buildLeash, LEASH_STATES } from "../src/marketplace/leash.mjs";
import { GRID_TESTNET_VENUE, gridTaskResult, buildGridBenchDeliverable, planGridStrategy } from "../src/reference/grid-keeper.mjs";
import { buildGridBenchmarkDefinition } from "../src/reference/grid-benchmark.mjs";
import { REFERENCE_WALLET_PATHS } from "../src/reference/constants.mjs";
import { RUN_TYPES } from "../src/domain.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateFile = (name) => path.join(root, "data", "state", name);
const readState = (name) => JSON.parse(readFileSync(stateFile(name), "utf8"));

const BUYER = "0x14342be6726f1f5aafa30b673c787d696e3f09eb";
const GRID_PROVIDER = "0xa928deba3ad929a915ee26fd3394126364928460";
const ACTION_WALLET = "0xbb62a403f8b582b49bcb05e1a7a678da4ebde48f";

/* ------------------------------------------------------ the delivery rule */

test("a deliverable that failed validation is not an observed delivery", () => {
  // The chain saw a submission for paid job 835 and settled it COMPLETED, but
  // the deliverable was empty. Reading that as a delivery would flatter the
  // record, which is the one thing this marketplace must not do.
  const rejected = {
    protocolJob: { funded: true, jobId: 835, events: [{ event: "deliverable_observed", snapshot: { status: "COMPLETED" } }] },
    qualification: { hasActualDeliverable: false },
  };
  assert.equal(delivered(rejected), false);

  const accepted = { protocolJob: { funded: true, jobId: 700, events: [] }, qualification: { hasActualDeliverable: true } };
  assert.equal(delivered(accepted), true);

  // With no validation verdict at all, the chain state is still the fallback.
  const unvalidated = { protocolJob: { funded: true, jobId: 1, events: [{ event: "deliverable_observed" }] }, qualification: {} };
  assert.equal(delivered(unvalidated), true);
});

test("the delivery rule has exactly one definition", () => {
  // Two copies of this rule drifted apart once already, and the weaker one
  // was the one that counted an empty deliverable.
  const metrics = readFileSync(path.join(root, "src", "marketplace", "metrics.mjs"), "utf8");
  assert.equal(/function delivered\s*\(/.test(metrics), false, "metrics.mjs must not define its own delivered()");
  assert.match(metrics, /import \{ delivered \} from "\.\/model\.mjs"/);
});

/* ---------------------------------------------- what the paid run changed */

test("the paid Grid run reached a real payment but not a qualifying benchmark", () => {
  const files = readdirSync(path.join(root, "data", "state")).filter((name) => name.startsWith("gridbench-run-"));
  assert.ok(files.length >= 1, "a paid GridBench run record must exist");
  const run = readState(files.sort().at(-1));

  assert.equal(run.benchmarkId, "gridbench-v1");
  assert.equal(String(run.provider).toLowerCase(), GRID_PROVIDER);
  assert.ok(Number(run.jobId) > 0, "a real job id must be recorded");
  assert.equal(run.chainState, "COMPLETED", "the ERC-8183 lifecycle completed on chain");
  assert.equal(run.economics.serviceFeeRaw, "1000000000000000", "0.001 U was paid");

  // The failure is preserved rather than smoothed over.
  assert.equal(run.deliverable.validation.valid, false);
  assert.ok(run.deliverable.validation.errors.length > 0);
  assert.equal(run.terminalState, "error");

  // No residual allowance after settlement.
  assert.equal(run.economics.allowanceAfterRaw, "0");
});

test("an invalid deliverable cannot qualify, however complete the protocol run was", () => {
  const flags = deriveQualificationFlags({
    runType: RUN_TYPES.BENCHMARK,
    provenanceMode: "LIVE_QUALIFYING",
    precommit: { manifestHash: "0xabc" },
    protocolJob: { funded: true, jobId: 835, currentState: "COMPLETED", events: [{ tx: { transactionHash: "0x1" } }] },
    agentOutput: {},
    agentDeliverableValidation: { valid: false, hasActualDeliverable: false },
    controlOutput: { provenance: { independent: true } },
    evaluation: { status: "completed" },
    terminalState: "error",
  });
  assert.equal(flags.hasRealPayment, true);
  assert.equal(flags.protocolCompleted, true);
  assert.equal(flags.hasActualDeliverable, false);
  assert.equal(flags.isComplete, false);
  assert.equal(flags.qualifiesForAgentTrackRecord, false);
  assert.equal(flags.qualifiesForPublicMetrics, false);
});

test("Grid Keeper reports the state it actually reached and no more", () => {
  const candidate = { identity: "97:0xreg:2045", probes: [{ reachable: true }], selectionGate: { readiness: { quoteVerified: true } } };
  const run = {
    runId: "r", runType: RUN_TYPES.BENCHMARK, createdAt: "2026-08-31T11:00:00Z",
    agent: { identity: "97:0xreg:2045" },
    protocolJob: { funded: true, jobId: 835, currentState: "COMPLETED", events: [{ snapshot: { status: "COMPLETED" } }] },
    qualification: { hasActualDeliverable: false, qualifiesForAgentTrackRecord: false },
    terminalState: "error",
  };
  const trust = deriveTrustStates(candidate, [run]);
  assert.equal(trust.states.HIRE_ATTEMPTED, true);
  assert.equal(trust.states.DELIVERY_OBSERVED, false);
  assert.equal(trust.states.BENCHMARKED, false);
  assert.equal(deriveAgentStatus(candidate, [run]).label, "HIRE ATTEMPTED - DELIVERY NOT OBSERVED");
});

test("the failed Grid run does not move TermiX or the public metrics", () => {
  const gridRun = {
    runId: "grid", runType: RUN_TYPES.BENCHMARK, createdAt: "2026-08-31T11:00:00Z",
    agent: { identity: "97:0xreg:2045" },
    protocolJob: { funded: true, jobId: 835, currentState: "COMPLETED", events: [] },
    qualification: { hasRealPayment: true, hasActualDeliverable: false, qualifiesForPublicMetrics: false, qualifiesForTermixEvidence: false },
    evaluation: { metrics: {} },
  };
  const metrics = deriveMarketplaceMetrics({ candidates: [], runs: [gridRun] });
  assert.equal(metrics.qualifyingBenchmarks, 0);
  assert.equal(metrics.wins, 0);
  assert.equal(metrics.losses, 0);
  // Paid and attempted, but not delivered.
  assert.equal(metrics.paidAttempts, 1);
  assert.equal(metrics.deliveries, 0);
});

test("GridBench adds no Agent Advantage pair, because it has no human baseline", () => {
  const definition = buildGridBenchmarkDefinition();
  // Nothing in the frozen benchmark references a human baseline or a pair.
  const serialised = JSON.stringify(definition);
  assert.equal(/humanBaseline|termix/i.test(serialised), false);
});

/* ------------------------------------------------- the shape that failed */

test("a deliverable must be wrapped in the runtime result shape or it submits empty", () => {
  // This is the exact defect that cost paid job 835: the runtime reads
  // result.output, and a builder returning the deliverable directly submits
  // nothing at all.
  const definition = buildGridBenchmarkDefinition();
  const built = buildGridBenchDeliverable({ jobId: 1, task: "t", definition });
  assert.equal(built.output, undefined, "the builder returns a deliverable, not a runtime result");

  const wrapped = gridTaskResult(built);
  assert.equal(wrapped.ok, true);
  assert.equal(wrapped.status, "delivered");
  assert.ok(wrapped.output && typeof wrapped.output === "object");
  assert.ok(wrapped.canonicalOutput.length > 1000, "canonical output must carry the answers");
  assert.equal(JSON.parse(wrapped.canonicalOutput).benchmarkId, definition.benchmarkId);
  assert.equal(Object.keys(JSON.parse(wrapped.canonicalOutput).answers).length, definition.scenarios.length);
});

test("a failed deliverable is wrapped as not ok rather than silently delivered", () => {
  const wrapped = gridTaskResult({ status: "insufficient_data", reason: "no strategy" });
  assert.equal(wrapped.ok, false);
  assert.equal(wrapped.status, "insufficient_data");
});

/* --------------------------------------------------------- wallet roles */

test("the buyer, the Grid provider and the action wallet stay three distinct roles", () => {
  assert.equal(new Set([BUYER, GRID_PROVIDER, ACTION_WALLET]).size, 3);

  // The action wallet must not be any reference agent's provider keystore.
  const providerDirs = Object.values(REFERENCE_WALLET_PATHS).map((paths) => paths.walletsDir);
  assert.equal(providerDirs.includes("grid-action-wallets"), false, "the action wallet is not a provider wallet");

  const funding = readState("grid-action-wallet-funding.json");
  assert.equal(String(funding.to).toLowerCase(), ACTION_WALLET);
  assert.equal(String(funding.from).toLowerCase(), BUYER);
  assert.equal(funding.chainId, 97);
  // Gas only: exactly the authorized amount and no token.
  assert.equal(funding.amountWei, "10000000000000000");
  assert.equal(funding.amountWei, funding.authorizedCeilingWei);
  assert.equal(funding.tokenSent, "none");
  assert.equal(BigInt(funding.recipientBalanceAfterWei) - BigInt(funding.recipientBalanceBeforeWei), 10_000_000_000_000_000n);
});

test("the action wallet keystore is never placed on the public agent host", () => {
  // The provider signs agent actions; the action wallet owns user capital.
  // Merging them would make the bounded permission meaningless.
  const service = readFileSync(path.join(root, "scripts", "run-public-grid-keeper.mjs"), "utf8");
  assert.equal(/grid-action-wallets/.test(service), false, "the public service must not reference the action keystore");
  assert.equal(/ACTION_WALLET_PASSWORD|CANNED_GRID_ACTION/.test(service), false);
});

/* ------------------------------------------- the exact token dependency */

test("the required testnet USDT is identified by address, never by symbol", () => {
  const research = readState("testnet-usdt-research.json");
  const token = research.expectedTestnetUsdt;
  assert.equal(token.address, GRID_TESTNET_VENUE.usdt);
  assert.equal(token.address, "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd");
  assert.equal(token.deployed, true);
  assert.ok(token.codeBytes > 0);
  assert.equal(token.decimals, 18);
  assert.equal(token.symbol, "USDT");

  // A symbol match alone must never be sufficient: another contract can call
  // itself USDT, and the execution path is bound to this address.
  assert.notEqual(GRID_TESTNET_VENUE.usdt, research.paymentTokenU.address);
  assert.equal(research.paymentTokenU.symbol, "U");
});

test("the research is read-only and found no wallet holding the token", () => {
  const research = readState("testnet-usdt-research.json");
  assert.equal(research.readOnly, true);
  assert.equal(research.transactionsSent, 0);
  assert.equal(research.chainId, 97);
  assert.equal(research.anyWalletHoldsUsdt, false);
  // Every distribution entry point on the token itself is closed to us.
  assert.ok(Object.values(research.tokenDistribution).every((outcome) => outcome !== "SUCCEEDS"));
});

/* ----------------------------------------------- Altana stays unconfigured */

test("The Leash is still NOT_CONFIGURED and invents no permission", () => {
  const leash = buildLeash({ strategy: planGridStrategy({
    strategyId: "regress",
    pair: { baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt, baseSymbol: "WBNB", quoteSymbol: "USDT" },
    lowerPriceMinor: 600n * 10n ** 18n, upperPriceMinor: 800n * 10n ** 18n, levelCount: 8,
    totalCapitalMinor: 10n * 10n ** 18n, maxPerLevelMinor: 3n * 10n ** 18n,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }), session: null });

  assert.equal(leash.state, LEASH_STATES.NOT_CONFIGURED);
  assert.equal(leash.spend, null);
  assert.equal(leash.contracts.length, 0);
  assert.equal(leash.expiresAt, null);
  assert.equal(leash.revocable, false);
  assert.equal(leash.onchain, null);
});

test("the recorded Altana session is real, bounded and revoked", () => {
  // Directive #20 granted a real session. What must never happen is a session
  // record that claims authority nobody granted, or one left live.
  const record = readState("grid-session.json");
  assert.equal(record.revoked, true, "the session must be recorded as revoked");
  const session = record.session;
  assert.equal(session.chainId, 97);
  assert.match(session.grantTransactionHash, /^0x[0-9a-f]{64}$/i);
  assert.match(session.revocationTransactionHash, /^0x[0-9a-f]{64}$/i);
  assert.equal(session.permissions.calls.length, 1);
  assert.equal(session.permissions.calls[0].to.toLowerCase(), "0xd99d1c33f9fc3444f8101754abc46c52416550d1");
  assert.equal(session.permissions.calls[0].selector, "0x38ed1739");
  assert.equal(session.permissions.spend.length, 1);
  assert.equal(session.permissions.spend[0].token.toLowerCase(), "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd");
  assert.ok(BigInt(session.permissions.spend[0].limit) <= 1_500_000_000_000_000_000n);
  assert.equal(String(session.owner).toLowerCase(), ACTION_WALLET);
});

test("the Altana proof records the execution failure rather than a success", () => {
  // The session-key swap was refused by the validator. Recording it as
  // anything else would be the single most misleading thing in this project.
  const proof = readState("altana-proof.json");
  assert.equal(proof.steps.execution.attempted, true);
  assert.equal(proof.steps.execution.succeeded, false);
  assert.match(proof.steps.execution.error, /NoSpendPermissions/);
  assert.equal(proof.steps.execution.balances.usdtSpentRaw, "0", "no capital moved");
  assert.equal(proof.steps.execution.fillsUsed, 0);
  assert.equal(proof.steps.revokedKeyRefused.refused, true);
  assert.equal(proof.steps.allowanceCleared.residualAllowanceRaw, "0");
  // The claim boundary is part of the evidence, not a footnote.
  assert.ok(proof.claimBoundary.doesNotProve.some((line) => /profitable/i.test(line)));
});
