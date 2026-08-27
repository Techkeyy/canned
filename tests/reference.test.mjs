import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { AltanaAuthorityProvider, buildAltanaSessionPolicy, createOfficialAltanaAuthority, validateAltanaCall, validateAltanaSessionPolicy } from "../src/reference/altana.mjs";
import { ReferenceAgentRuntime } from "../src/reference/foundation.mjs";
import { processFundedReferenceJob } from "../src/reference/erc8183-seller.mjs";
import { buildHealthFactorDeliverable, buildIndependentHealthFactorControl, manualHealthFactorBaselinePacket } from "../src/reference/health-factor.mjs";
import { REFERENCE_AGENT_SPECS, REFERENCE_ORIGIN, referenceAgentCandidate, referenceFleetCatalog } from "../src/reference/constants.mjs";

const account = "0x0000000000000000000000000000000000000001";
const commerce = "0x0000000000000000000000000000000000000011";
const router = "0x0000000000000000000000000000000000000022";
const snapshot = { protocol: "Venus", poolType: "core", source: "onchain", chainId: 97, account, asOfBlock: "123", errorCode: "0", liquidityRaw: "1000", shortfallRaw: "0", healthFactor: 1.42, authoritative: true, readPlan: { contract: commerce, method: "getAccountLiquidity(address)" } };

test("reference fleet names all four categories but only publishes implemented modules", () => {
  assert.equal(REFERENCE_AGENT_SPECS.length, 4);
  assert.deepEqual(referenceFleetCatalog().map((item) => item.implementationStatus), ["implemented", "planned", "planned", "planned"]);
  const candidate = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0]);
  assert.equal(candidate.origin, REFERENCE_ORIGIN);
  assert.equal(candidate.erc8004.status, "not_registered");
});

test("Health Factor refuses to answer without authoritative Venus data", () => {
  const result = buildHealthFactorDeliverable({ task: { account, protocol: "venus" } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "insufficient_authoritative_data");
  assert.equal(result.output.assessment, undefined);
});

test("Health Factor output preserves protocol provenance and deterministic changes", () => {
  const previous = { ...snapshot, healthFactor: 1.6, liquidityRaw: "1200" };
  const result = buildHealthFactorDeliverable({ jobId: 701, task: { account, protocol: "venus", authoritativeSnapshot: snapshot, warningHealthFactor: 1.2, criticalHealthFactor: 1.05 }, previousSnapshot: previous });
  assert.equal(result.ok, true);
  assert.equal(result.output.origin, REFERENCE_ORIGIN);
  assert.equal(result.output.assessment.status, "NO_SHORTFALL_OBSERVED");
  assert.deepEqual(result.output.changes.changes.map((item) => item.field), ["healthFactor", "liquidityRaw"]);
  assert.equal(result.output.recommendation.automaticActionTaken, false);
});

test("reference runtime separates endpoint liveness from worker heartbeat", async () => {
  let now = 1_800_000_000_000;
  const runtime = new ReferenceAgentRuntime({ spec: REFERENCE_AGENT_SPECS[0], clock: () => now, workerStaleMs: 1_000, taskHandler: ({ task }) => buildHealthFactorDeliverable({ task }) });
  assert.equal(runtime.health().endpointAlive, true);
  assert.equal(runtime.readiness().worker.alive, false);
  runtime.heartbeat({ state: "idle" });
  assert.equal(runtime.readiness().worker.alive, true);
  now += 1_001;
  assert.equal(runtime.readiness().worker.alive, false);
  const worked = await runtime.work({ jobId: 701, task: { account, protocol: "venus", authoritativeSnapshot: snapshot } });
  assert.equal(worked.ok, true);
  assert.equal(runtime.metrics().jobsWorked, 1);
});

test("seller path verifies a funded job, computes the task, and submits the deliverable", async () => {
  const calls = [];
  const runtime = new ReferenceAgentRuntime({ spec: REFERENCE_AGENT_SPECS[0], taskHandler: ({ task, jobId }) => buildHealthFactorDeliverable({ task, jobId }) });
  const seller = { jobOps: { verifyJob: async (jobId) => ({ valid: jobId === 701 }), submitResult: async (jobId, content, metadata) => { calls.push({ jobId, content, metadata }); return { success: true, txHash: "0xsubmit" }; } } };
  const result = await processFundedReferenceJob({ seller, runtime, job: { jobId: 701 }, task: { account, protocol: "venus", authoritativeSnapshot: snapshot } });
  assert.equal(result.status, "submitted");
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].content).origin, REFERENCE_ORIGIN);
  assert.equal(result.deliverable.manifestHash.startsWith("0x"), true);
});

test("Altana policy is testnet-only, bounded, explicit, and rejects wrong target or method", () => {
  const policy = buildAltanaSessionPolicy({ commerceAddress: commerce, routerAddress: router, expiry: Math.floor(Date.now() / 1000) + 900, maxSpendRaw: "1000000000000000" });
  assert.equal(validateAltanaSessionPolicy(policy).valid, true);
  const abi = parseAbi(["function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)", "function settle(uint256 jobId,bytes evidence)"]);
  const allowed = encodeFunctionData({ abi, functionName: "fund", args: [701n, 1000000000000000n, "0x"] });
  assert.equal(validateAltanaCall({ policy, to: commerce, data: allowed }).valid, true);
  assert.equal(validateAltanaCall({ policy, to: router, data: allowed }).valid, false);
  const wrongMethod = encodeFunctionData({ abi, functionName: "settle", args: [701n, "0x"] });
  assert.equal(validateAltanaCall({ policy, to: commerce, data: wrongMethod }).valid, false);
  assert.equal(validateAltanaSessionPolicy({ ...policy, permissions: { spend: policy.permissions.spend } }).valid, false);
});

test("Altana authority boundary requires confirmation, validates exact calls, and supports revocation seams", async () => {
  const policy = buildAltanaSessionPolicy({ commerceAddress: commerce, routerAddress: router, expiry: Math.floor(Date.now() / 1000) + 900, maxSpendRaw: "1000000000000000" });
  const abi = parseAbi(["function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)"]);
  const data = encodeFunctionData({ abi, functionName: "fund", args: [701n, 1000000000000000n, "0x"] });
  const calls = [];
  const authority = new AltanaAuthorityProvider({ grantSession: async (input) => ({ input, txHash: "0xgrant" }), execute: async (input) => { calls.push(input); return { status: "confirmed" }; }, revokeSession: async (input) => ({ input, txHash: "0xrevoke" }) });
  assert.throws(() => authority.prepare({ ...policy, network: undefined }));
  const prepared = authority.prepare({ commerceAddress: commerce, routerAddress: router, expiry: policy.expiry, maxSpendRaw: "1000000000000000" });
  await assert.rejects(authority.grant({ policy: prepared.policy }), /confirmation/);
  const granted = await authority.grant({ policy: prepared.policy, confirmed: true });
  assert.equal(granted.txHash, "0xgrant");
  assert.equal((await authority.execute({ policy: prepared.policy, to: commerce, data })).status, "confirmed");
  assert.equal(calls.length, 1);
  await assert.rejects(authority.execute({ policy: prepared.policy, to: commerce, data, session: { walletAddress: account, publicKey: "0xpub", expiry: 1, permissions: prepared.policy.permissions } }), /session rejected/);
  await assert.rejects(authority.execute({ policy: prepared.policy, to: router, data }), /call rejected/);
  assert.equal((await authority.revoke({ publicKey: "0xpub", confirmed: true })).txHash, "0xrevoke");
});

test("official Altana adapter selects BNB testnet without writing until a method is called", async () => {
  const fakeWallet = { address: account };
  const fakeSigner = { address: account };
  const { authority, chainId, network } = await createOfficialAltanaAuthority({ wallet: fakeWallet, signer: fakeSigner });
  assert.equal(network, "BNB_TESTNET");
  assert.equal(chainId, 97);
  assert.equal(authority.inspect({ expiry: Math.floor(Date.now() / 1000) + 60, permissions: { calls: [{ to: commerce, signature: "fund(uint256,uint256,bytes)" }], spend: [{ limit: 1n, period: "day", token: REFERENCE_AGENT_SPECS[0] ? "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565" : null }] } }).valid, true);
});

test("manual baseline remains uncontaminated and never becomes TermiX evidence automatically", () => {
  const packet = manualHealthFactorBaselinePacket({ task: { account, poolType: "core" } });
  assert.equal(packet.expectedAnswer, null);
  assert.equal(packet.contaminationBoundary.includes("before opening"), true);
  const control = buildIndependentHealthFactorControl({ task: { account, protocol: "venus", authoritativeSnapshot: snapshot } });
  assert.equal(control.provenance.humanBaseline, false);
  assert.equal(control.provenance.termixEligible, false);
});

test("reference marketplace record is visibly first-party and still cannot be hired before quote/provider readiness", () => {
  const candidate = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0]);
  const record = deriveAgentRecord(candidate, []);
  assert.equal(record.origin, REFERENCE_ORIGIN);
  assert.equal(record.reference, true);
  assert.equal(record.activation.selection.status, "blocked");
});
