import test from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, parseAbi } from "viem";
import { contentHashes } from "../src/core.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { AltanaAuthorityProvider, buildAltanaSessionPolicy, createOfficialAltanaAuthority, validateAltanaCall, validateAltanaSessionPolicy } from "../src/reference/altana.mjs";
import { ReferenceAgentRuntime } from "../src/reference/foundation.mjs";
import { processFundedReferenceJob } from "../src/reference/erc8183-seller.mjs";
import { buildHealthFactorDeliverable, buildIndependentHealthFactorControl, manualHealthFactorBaselinePacket } from "../src/reference/health-factor.mjs";
import { REFERENCE_AGENT_SPECS, REFERENCE_ERC8183_COMMERCE_PROXY, REFERENCE_ORIGIN, REFERENCE_PAYMENT_TOKEN, referenceAgentCandidate, referenceFleetCatalog } from "../src/reference/constants.mjs";
import { createHealthBenchDefinition, createHumanBaselineAttempt, completeHumanBaseline, baselineContainsSecretAnswer, healthBenchAgentInput, healthBenchProviderTask, healthBenchRunDefinition, validateHealthBenchAgentInput, publicHealthBenchPacket, publicHealthBenchSource } from "../src/reference/health-benchmark.mjs";
import { publicHealthGuardMetadata, publicReadinessSummary, validatePublicReferenceConfig } from "../src/reference/public-service.mjs";
import { publicReadinessFailures, referenceIdentityBindingFailures } from "../src/deploy/readiness.mjs";
import { verifyContentAddressedRoundTrip } from "../src/deploy/storage.mjs";

const account = "0x0000000000000000000000000000000000000001";
const commerce = "0x0000000000000000000000000000000000000011";
const router = "0x0000000000000000000000000000000000000022";
const snapshot = { protocol: "Venus", poolType: "core", source: "onchain", chainId: 97, account, asOfBlock: "123", errorCode: "0", liquidityRaw: "1000", shortfallRaw: "0", healthFactor: 1.42, authoritative: true, readPlan: { contract: commerce, method: "getAccountLiquidity(address)" } };
const frozenSnapshot = { ...snapshot, blockHash: `0x${"ab".repeat(32)}`, blockTimestamp: 1_800_000_000 };

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

test("reference runtime refreshes existing worker and watcher heartbeats", () => {
  let now = 1_800_000_000_000;
  const runtime = new ReferenceAgentRuntime({ spec: REFERENCE_AGENT_SPECS[0], clock: () => now, workerStaleMs: 1_000, taskHandler: async () => ({ ok: true }) });
  runtime.heartbeat({ state: "idle" });
  runtime.watcherHeartbeat({ state: "watching" });
  now += 1_001;
  assert.equal(runtime.readiness().worker.alive, false);
  assert.equal(runtime.readiness().watcher.alive, false);
  runtime.refreshHeartbeats();
  assert.equal(runtime.readiness().worker.alive, true);
  assert.equal(runtime.readiness().watcher.alive, true);
  assert.equal(runtime.readiness().worker.status, "idle");
  assert.equal(runtime.readiness().watcher.status, "watching");
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

test("public reference configuration rejects local or non-durable deployment inputs", () => {
  assert.equal(validatePublicReferenceConfig({ agentUrl: "http://127.0.0.1:8790/erc8183", storageApiKey: "test" }).valid, false);
  assert.equal(validatePublicReferenceConfig({ agentUrl: "http://health.example/erc8183", storageApiKey: "test" }).errors.includes("agent_url_must_use_https"), true);
  assert.equal(validatePublicReferenceConfig({ agentUrl: "https://health.example/erc8183", storageApiKey: "test" }).valid, true);
  assert.equal(validatePublicReferenceConfig({ agentUrl: "https://health.example/service", storageApiKey: "test" }).errors.includes("agent_url_must_end_in_erc8183"), true);
});

test("HealthBench freezes the authoritative source and keeps the answer out of its public packet", () => {
  const definition = createHealthBenchDefinition({ snapshot: frozenSnapshot, account });
  const packet = publicHealthBenchPacket(definition);
  const source = publicHealthBenchSource(definition);
  assert.equal(definition.immutable, true);
  assert.equal(typeof definition.precommit.canonicalSha256, "string");
  assert.equal(packet.frozenEvidence, undefined);
  assert.equal(packet.evaluator, undefined);
  assert.equal(definition.evaluator.status, "sealed_until_baseline_submission");
  assert.equal(source.rawOnchainEvidence.blockHash, frozenSnapshot.blockHash);
  assert.equal(baselineContainsSecretAnswer(packet), false);
  assert.equal(baselineContainsSecretAnswer({ agentOutput: { assessment: "hidden" } }), true);
});

test("HealthBench provider input is bound to the frozen snapshot and excludes baseline/evaluator content", () => {
  const definition = createHealthBenchDefinition({ snapshot: frozenSnapshot, account });
  const input = healthBenchAgentInput(definition);
  assert.equal(input.benchmarkId, "HealthBench_v1");
  assert.equal(input.evidence.snapshot.blockHash, frozenSnapshot.blockHash);
  assert.equal(input.evidence.snapshotHash, contentHashes(frozenSnapshot).keccak256);
  assert.equal(input.humanBaseline, undefined);
  assert.equal(input.agentOutput, undefined);
  assert.equal(input.groundTruth, undefined);
  assert.equal(baselineContainsSecretAnswer(input), false);
  assert.equal(validateHealthBenchAgentInput({ definition, input }).valid, true);
  assert.equal(validateHealthBenchAgentInput({ definition, input: { ...input, evidence: { ...input.evidence, snapshotHash: "0xwrong" } } }).valid, false);
  const providerTask = healthBenchProviderTask(definition, { jobId: 701 });
  assert.equal(providerTask.jobId, 701);
  assert.equal(providerTask.authoritativeSnapshot.blockHash, frozenSnapshot.blockHash);
  assert.equal(providerTask.automaticActionTaken, false);
  assert.equal(baselineContainsSecretAnswer(providerTask), false);
  const runDefinition = healthBenchRunDefinition(definition);
  assert.equal(runDefinition.id, "HealthBench_v1");
  assert.equal(runDefinition.evaluator.version, "health-factor-deterministic-v1");
  assert.equal(runDefinition.control.sameFrozenEvidence, true);
});

test("human baseline preserves raw submission and server timing without evaluation", () => {
  const attempt = createHumanBaselineAttempt({ benchmarkId: "HealthBench_v1", startedAt: "2026-08-27T10:00:00.000Z" });
  const completed = completeHumanBaseline({ attempt, submittedAt: "2026-08-27T10:00:12.345Z", elapsedMs: 12345, submission: { positionFacts: "raw", liquidationProximity: "unknown", changeExplanation: "none", boundedAction: "monitor", reasoningNotes: "manual" } });
  assert.equal(completed.status, "submitted");
  assert.equal(completed.elapsedMs, 12345);
  assert.equal(completed.submission.reasoningNotes, "manual");
  assert.equal(completed.groundTruth, undefined);
});

test("marketplace does not promote local Health Guard as public until readiness is recorded", () => {
  const candidate = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { allowLocalProbe: false, publicReadinessVerified: false, providerAddress: account });
  assert.equal(candidate.services[0].cannedVerified, false);
  assert.equal(candidate.probes.length, 0);
  const publicCandidate = referenceAgentCandidate(REFERENCE_AGENT_SPECS[0], { allowLocalProbe: false, publicReadinessVerified: true, identityRecord: { agentId: 1927, registry: commerce, endpoint: "https://health.example/erc8183" }, providerAddress: account });
  assert.equal(publicCandidate.services[0].cannedVerified, true);
  assert.equal(publicCandidate.services[0].endpoint, "https://health.example/erc8183");
  assert.equal(publicCandidate.erc8004.status, "onchain_registered");
});

test("public Health Guard metadata and readiness preserve first-party provenance and heartbeat distinctions", () => {
  const runtime = new ReferenceAgentRuntime({ spec: REFERENCE_AGENT_SPECS[0], taskHandler: async () => ({ ok: true }) });
  const metadata = publicHealthGuardMetadata({ agentUrl: "https://health.example/erc8183", providerAddress: account });
  const summary = publicReadinessSummary({ runtime, providerAddress: account, agentUrl: "https://health.example/erc8183", storageMode: "ipfs", metadata });
  assert.equal(metadata.origin, REFERENCE_ORIGIN);
  assert.equal(metadata.protocols[0].verifyingContract.toLowerCase(), REFERENCE_ERC8183_COMMERCE_PROXY.toLowerCase());
  assert.equal(summary.storage.public, true);
  assert.equal(summary.worker.alive, false);
  assert.equal(summary.watcher.alive, false);
});

test("content-addressed storage probe verifies retrieval, hashes, and changed content without returning artifacts", async () => {
  const records = new Map();
  const storage = {
    async upload(data, filename) { const url = `ipfs://${filename.includes("v2") ? "bafychanged" : "bafyfirst"}`; records.set(url, structuredClone(data)); return url; },
    async exists(url) { return records.has(url); },
    async download(url) { return structuredClone(records.get(url)); },
    getGatewayUrl(url) { return `https://gateway.example/ipfs/${url.slice(7)}`; },
  };
  const result = await verifyContentAddressedRoundTrip({ storage, firstArtifact: { probe: "one" }, secondArtifact: { probe: "two" } });
  assert.equal(result.uploadRetrievedEqual, true);
  assert.equal(result.changedContentDifferent, true);
  assert.equal(result.firstGatewayUrl.includes("ipfs://"), false);
  assert.equal(result.firstHash.sha256, result.retrievedHash.sha256);
});

test("public readiness and identity binding fail closed on dead workers or mismatches", () => {
  const agentUrl = "https://health.example/erc8183";
  const common = {
    health: { ok: true, body: { ok: true, chainId: 97, endpointAlive: true } },
    readiness: { ok: true, body: { network: "bsc-testnet", chainId: 97, endpoint: { transport: "public_http", url: agentUrl }, worker: { alive: true }, watcher: { alive: true }, storage: { public: true, localFilesystemPresentedAsEvidence: false }, providerAddress: account } },
    status: { ok: true, body: { chainId: 97, provider: account, paymentToken: REFERENCE_PAYMENT_TOKEN } },
    metadata: { ok: true, body: { origin: REFERENCE_ORIGIN, chainId: 97, category: "Health Factor Monitoring", protocols: [{ endpoint: agentUrl, verifyingContract: REFERENCE_ERC8183_COMMERCE_PROXY }] } },
  };
  assert.deepEqual(publicReadinessFailures({ agentUrl, ...common }), []);
  assert.equal(publicReadinessFailures({ agentUrl, ...common, readiness: { ...common.readiness, body: { ...common.readiness.body, watcher: { alive: false } } } }).includes("watcher_not_alive"), true);
  assert.equal(publicReadinessFailures({ agentUrl: "http://127.0.0.1:8790/erc8183", ...common }).includes("public_https_erc8183_url"), true);
  assert.deepEqual(referenceIdentityBindingFailures({ identity: { agentId: 1927, registry: commerce, provider: account, endpoint: agentUrl }, status: common.status.body, metadata: common.metadata.body, agentUrl }), []);
  assert.equal(referenceIdentityBindingFailures({ identity: { agentId: 1927, registry: commerce, provider: router, endpoint: agentUrl }, status: common.status.body, metadata: common.metadata.body, agentUrl }).includes("identity_provider_mismatch"), true);
});

test("worker and watcher health reset after a controlled process restart", () => {
  const first = new ReferenceAgentRuntime({ spec: REFERENCE_AGENT_SPECS[0], taskHandler: async () => ({ ok: true }) });
  first.heartbeat({ state: "idle" });
  first.watcherHeartbeat({ state: "watching" });
  assert.equal(first.readiness().worker.alive, true);
  assert.equal(first.readiness().watcher.alive, true);
  const restarted = new ReferenceAgentRuntime({ spec: REFERENCE_AGENT_SPECS[0], taskHandler: async () => ({ ok: true }) });
  assert.equal(restarted.readiness().worker.alive, false);
  assert.equal(restarted.readiness().watcher.alive, false);
});
