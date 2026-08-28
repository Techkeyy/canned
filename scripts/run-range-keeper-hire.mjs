import path from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { verifyQuoteSignature } from "@bnbagent/sdk/erc8183";
import { createPrecommitManifest, runBenchmark } from "../src/benchmark/framework.mjs";
import { extractProviderDeliverable, validateSubmittedDeliverable } from "../src/benchmark/validation.mjs";
import { CATEGORIES, CATEGORY_LABELS, RUN_TYPES } from "../src/domain.mjs";
import { contentHashes, id, isPublicHttpUrl, nowIso, requestJson, safeError } from "../src/core.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { selectHiringAdapter } from "../src/marketplace/adapters.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { appendProtocolEvent, createFundedJob, fetchDeliverable, loadSdk, preflightGuards, readJob, txShape, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { probeRpcCapability, rpcReadinessFailures, sdkRpcEnvironment } from "../src/deploy/rpc-capability.mjs";
import { publicReadinessFailures } from "../src/deploy/readiness.mjs";
import { referenceAgentCandidate, referenceSpec, REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { buildIndependentRangeControl, REBALANCE_POLICY } from "../src/reference/range-keeper.mjs";
import { publicRebalanceBenchSource, rebalanceBenchAgentInput, rebalanceBenchControlTask, rebalanceBenchProviderTask, rebalanceContainsSecretAnswer, validateRebalanceBenchAgentInput, REBALANCE_BENCHMARK_ID, REBALANCE_CONTROL_VERSION, REBALANCE_EVALUATOR_VERSION } from "../src/reference/rebalance-benchmark.mjs";

const MAX_PRICE_RAW = 10_000_000_000_000_000n; // 0.01 U hard ceiling.
const EXPECTED_PRICE_RAW = 1_000_000_000_000_000n; // 0.001 U service class.
const OUTPUT_FIELDS = ["position", "rangeStatus", "marketContext", "decision", "tradeoffs", "execution", "evidence"];
const REFERENCE_KEY = "rebalancing";

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
let buyerWallet = null;

function stop(reason, details = {}) {
  console.log(JSON.stringify({ status: "blocked", reason, ...details }, null, 2));
  buyerWallet?.destroy();
  process.exit(2);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (body) => console.log(JSON.stringify(body, null, 2));

// 1. The frozen benchmark must still reproduce its own precommit.
const definition = await store.loadJson("state/rebalancebench-v1.json", null);
if (!definition) stop("RebalanceBench v1 has not been frozen.");
const { precommit, ...withoutPrecommit } = definition;
const definitionHashes = contentHashes(withoutPrecommit);
if (definitionHashes.sha256 !== precommit?.canonicalSha256 || definitionHashes.keccak256 !== precommit?.manifestKeccak256) {
  stop("The frozen RebalanceBench definition no longer matches its own precommit; refusing to spend.", { expected: precommit, recomputed: definitionHashes });
}
if (definition.executionBoundary.mainnetWriteAuthorized !== false) stop("The benchmark claims mainnet write authorization; refusing.");

// 2. The human baseline must already be sealed and hash-intact.
const baseline = await store.loadJson("state/rebalance-baseline.json", null);
if (baseline?.status !== "submitted") stop("The RebalanceBench human baseline is not sealed; the agent run is not authorized.");
if (baseline.benchmarkId !== REBALANCE_BENCHMARK_ID) stop("The sealed baseline is bound to a different benchmark.");
if (contentHashes(baseline.rawSubmissionJson).sha256 !== baseline.evidence?.sha256) stop("The sealed human baseline no longer matches its evidence hash; refusing to proceed.");
if (baseline.groundTruth !== null || baseline.agentOutput !== null) stop("The sealed baseline already carries an agent output or ground truth.");

// 3. Registered identity.
const identityRecord = await store.loadJson("state/reference-range-identity.json", null);
if (!identityRecord?.agentId) stop("The Range Keeper ERC-8004 identity record is missing.");
const healthRecord = await store.loadJson("state/reference-health-identity.json", null);
if (healthRecord && Number(healthRecord.agentId) === Number(identityRecord.agentId)) stop("Range Keeper must not share Health Guard's ERC-8004 identity.");
if (healthRecord && healthRecord.endpoint === identityRecord.endpoint) stop("Range Keeper must not share Health Guard's endpoint.");
const spec = referenceSpec(REFERENCE_KEY);
const expectedCategory = CATEGORY_LABELS[spec.category];

// 4. Live provider surface.
const agentUrl = identityRecord.endpoint;
if (!isPublicHttpUrl(agentUrl)) stop("The Range Keeper endpoint is not a public HTTPS URL.");
const at = (suffix) => new URL(suffix, `${agentUrl.replace(/\/$/, "")}/`).toString();

/**
 * A dropped request is not the same thing as an unready provider. Without this
 * distinction a single transient network failure makes every readiness check
 * fail at once and reads like a broken agent. Transport is retried a bounded
 * number of times; a provider that genuinely answers and is unready still
 * blocks the run.
 */
async function probeSurface(suffix, attempts = 3) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await requestJson(at(suffix), { timeoutMs: 20_000 });
    if (last.ok && last.body !== undefined && last.body !== null) return { ...last, attempts: attempt };
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
  }
  return { ...last, attempts };
}

const [health, readiness, status, metadata] = await Promise.all(["/health", "/readiness", "/status", "/metadata"].map((suffix) => probeSurface(suffix)));
const unreachable = [["health", health], ["readiness", readiness], ["status", status], ["metadata", metadata]].filter(([, response]) => !response.ok || response.body === undefined || response.body === null);
if (unreachable.length) {
  stop("The Range Keeper public surface did not answer after retries; this is a transport failure, not a readiness verdict. No transaction was attempted.", {
    unreachable: unreachable.map(([name, response]) => ({ surface: name, httpStatus: response.status ?? null, attempts: response.attempts, error: response.error ?? null })),
  });
}
const readinessFailures = publicReadinessFailures({ agentUrl, health, readiness, status, metadata, expectedCategory });
if (readinessFailures.length) stop("Range Keeper public readiness failed; refusing to fund.", { failures: readinessFailures });
if (status.body?.executionPolicy?.capitalMovement !== false) stop("The Range Keeper execution policy allows capital movement; refusing.");
if (Number(metadata.body?.identity?.agentId) !== Number(identityRecord.agentId)) stop("The live service does not publish the registered identity.", { published: metadata.body?.identity, expected: identityRecord.agentId });

// 5. RPC capability, the Verified Run #1 lesson, checked on both sides.
if (readiness.body?.rpc?.capable !== true) stop("The Range Keeper watcher cannot serve the verifyJob log range; refusing to fund a job it cannot observe.", { rpc: readiness.body?.rpc });
if (readiness.body?.rpc?.usingSdkDefault === true) stop("The Range Keeper is on the SDK default RPC; refusing to fund.");
const buyerRpcEnvironment = sdkRpcEnvironment(env, REFERENCE_NETWORK);
const buyerRpcCapability = await probeRpcCapability({ rpcUrl: buyerRpcEnvironment.effectiveRpcUrl });
const buyerRpcFailures = rpcReadinessFailures({ environment: buyerRpcEnvironment, capability: buyerRpcCapability });
if (buyerRpcFailures.length) stop("The buyer RPC cannot serve the queries this run needs.", { failures: buyerRpcFailures });

// 6. Independent onchain ERC-8004 verification.
const rpcUrl = buyerRpcEnvironment.effectiveRpcUrl;
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000 }) });
const registryAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function getAgentWallet(uint256 agentId) view returns (address)"]);
const [registryOwner, registryWallet] = await Promise.all([
  publicClient.readContract({ address: identityRecord.registry, abi: registryAbi, functionName: "ownerOf", args: [BigInt(identityRecord.agentId)] }),
  publicClient.readContract({ address: identityRecord.registry, abi: registryAbi, functionName: "getAgentWallet", args: [BigInt(identityRecord.agentId)] }),
]);
if (registryOwner.toLowerCase() !== String(identityRecord.provider).toLowerCase() || registryWallet.toLowerCase() !== String(identityRecord.provider).toLowerCase()) {
  stop("ERC-8004 owner/provider mismatch; refusing the paid run.", { registryOwner, registryWallet, expected: identityRecord.provider });
}
if (String(status.body.provider).toLowerCase() !== registryOwner.toLowerCase()) stop("The live provider does not match the registered owner.");

// 7. Marketplace hire preparation, through the same path any listing uses.
const candidate = referenceAgentCandidate(spec, {
  providerAddress: identityRecord.provider,
  identityRecord,
  allowLocalProbe: false,
  publicReadinessVerified: readiness.body.worker.alive === true && readiness.body.watcher.alive === true && readiness.body.endpoint?.alive === true,
  baselineSealed: baseline.status === "submitted",
});
const priorRuns = await store.loadRuns();
const agentRecord = deriveAgentRecord(candidate, priorRuns);
const adapter = selectHiringAdapter(candidate, { chainId: REFERENCE_CHAIN_ID });
const hirePreparation = { attemptId: id("hire"), agent: { identity: candidate.identity, name: candidate.name }, protocol: adapter.protocol || "ERC-8183", adapterStatus: adapter.status, adapterReason: adapter.reason || null, readinessConditions: candidate.selectionGate.readiness.conditions, trustBefore: agentRecord.trust.reached, statusBefore: agentRecord.status.label, preparedAt: nowIso() };
if (candidate.identity !== `${REFERENCE_CHAIN_ID}:${String(identityRecord.registry).toLowerCase()}:${identityRecord.agentId}`) stop("Marketplace identity does not resolve to the registered ERC-8004 agent.", { candidate: candidate.identity });
if (adapter.status !== "ready") stop("The marketplace hiring adapter is not ready for Range Keeper.", { adapter, conditions: candidate.selectionGate.readiness.conditions });

// 8. Buyer readiness.
const sdk = await loadSdk();
const safety = writeSafety(env);
if (safety.network !== REFERENCE_NETWORK) stop("Canned is not configured for BSC Testnet; no mainnet path is authorized.", { network: safety.network });
if (!env.CANNED_EXECUTION_WALLET_PASSWORD || !env.CANNED_EXECUTION_WALLET_ADDRESS) stop("The Canned buyer wallet is not configured.");
buyerWallet = new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });
const buyerClient = await sdk.ERC8183Client.create({ network: REFERENCE_NETWORK, walletProvider: buyerWallet });
const [rpcChainId, nativeBalance, gasPriceWei, paymentToken, tokenDecimals, tokenSymbol, tokenBalance, allowanceBefore, disputeWindow] = await Promise.all([
  publicClient.getChainId(), publicClient.getBalance({ address: buyerWallet.address }), publicClient.getGasPrice(),
  buyerClient.paymentToken(), buyerClient.tokenDecimals(), buyerClient.tokenSymbol(),
  buyerClient.tokenBalance(buyerWallet.address), buyerClient.tokenAllowance(buyerWallet.address, buyerClient.commerce.address), buyerClient.policy.disputeWindow(),
]);
if (rpcChainId !== REFERENCE_CHAIN_ID) stop(`Refusing to operate on chain ${rpcChainId}.`);
if (paymentToken.toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase()) stop("The live payment token is not the expected U contract.", { paymentToken });

// 9. Fresh signed quote. The readiness quote is never reused.
const runId = id("run");
const quoteRequestedAt = Date.now();
const quoteRequest = {
  task_description: `Canned paid hire for ${REBALANCE_BENCHMARK_ID} (${definition.version}). Benchmark precommit ${precommit.manifestKeccak256}. Run ${runId}. Assess PancakeSwap V3 position ${definition.position.tokenId} in pool ${definition.pool.address} frozen at block ${definition.referenceBlock.number}; read-only, no capital movement.`,
  terms: { deliverables: "Structured PancakeSwap V3 range assessment for the frozen RebalanceBench v1 snapshot", quality_standards: "Authoritative pool and position reads only; bounded, non-transactional recommendation", success_criteria: ["Deliverable submitted onchain", "No capital movement", "Bound to the frozen snapshot"] },
  request_id: `${runId}-${quoteRequestedAt}`,
};
const quoteResponse = await requestJson(at("/negotiate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: quoteRequest });
const envelope = quoteResponse.body || {};
const quoted = envelope.response || {};
const quoteTerms = quoted.terms || {};
const priceRaw = String(quoteTerms.price ?? "");
const quoteExpiresAt = Number(quoted.quote_expires_at ?? 0);
if (!quoteResponse.ok || quoted.accepted !== true || !envelope.provider_sig || !envelope.negotiation_hash) stop("Range Keeper did not return an accepted signed quote.", { httpStatus: quoteResponse.status });
if (!/^\d+$/.test(priceRaw)) stop("The quote did not carry a numeric price.");
const price = BigInt(priceRaw);
if (price > MAX_PRICE_RAW) stop("The quoted price exceeds the 0.01 U authorization ceiling; stopping for explicit approval.", { priceRaw, ceilingRaw: MAX_PRICE_RAW.toString() });
if (price !== EXPECTED_PRICE_RAW) log({ status: "notice", note: "The fresh quote differs from the expected 0.001 U service class; the fresh quote governs.", priceRaw });
const signature = await verifyQuoteSignature({ envelope, provider: identityRecord.provider, publicClient, expectedVerifyingContract: buyerClient.commerce.address });
if (signature?.valid !== true || String(signature.signer).toLowerCase() !== String(identityRecord.provider).toLowerCase()) stop("The provider quote signature did not verify against the registered provider.", { signature });
if (Number(envelope.chain_id) !== REFERENCE_CHAIN_ID || String(envelope.verifying_contract).toLowerCase() !== buyerClient.commerce.address.toLowerCase()) stop("The signed quote is not bound to BSC Testnet Commerce.");

const estimatedGasWei = gasPriceWei * 500_000n;
const guard = preflightGuards({ chainId: rpcChainId, provider: identityRecord.provider, expectedProvider: registryOwner, tokenAddress: paymentToken, quoteCurrency: quoteTerms.currency, quoteAccepted: true, quoteSignaturePresent: true, quoteExpiresAt, tokenBalance, requiredBudget: price, nativeBalance, estimatedGasWei });
if (!guard.ok) stop("Preflight gate failed; no transaction was attempted.", { errors: guard.errors });

// 10. Contamination guard, run immediately before the job is created.
const agentInput = rebalanceBenchAgentInput(definition);
const inputValidation = validateRebalanceBenchAgentInput({ definition, input: agentInput });
const providerTask = rebalanceBenchProviderTask(definition);
const sourcePacket = publicRebalanceBenchSource(definition);
const humanText = JSON.stringify(baseline.submission);
const payloadText = JSON.stringify({ agentInput, providerTask, quoteRequest });
const humanValues = Object.entries(baseline.submission).filter(([key]) => key !== "elapsedMs").map(([, value]) => String(value)).filter((value) => value.length > 3);
const leakageChecks = {
  agentInputMatchesFrozenDefinition: inputValidation.valid,
  noForbiddenAnswerKeys: !rebalanceContainsSecretAnswer(agentInput) && !rebalanceContainsSecretAnswer(providerTask) && !rebalanceContainsSecretAnswer(quoteRequest),
  humanSubmissionAbsent: !humanValues.some((value) => payloadText.includes(value)),
  humanTimingAbsent: !payloadText.includes(String(baseline.elapsedMs)) && !payloadText.includes(baseline.submittedAt),
  humanAttemptIdAbsent: !payloadText.includes(baseline.attemptId),
  groundTruthAbsent: baseline.groundTruth === null,
  evaluatorConclusionsAbsent: !payloadText.includes("HOLD") && !payloadText.includes("IN_RANGE"),
};
if (!Object.values(leakageChecks).every(Boolean)) stop("The provider payload failed the human-answer contamination guard.", { leakageChecks, errors: inputValidation.errors });
if (humanText.length === 0) stop("The sealed human submission is empty.");

// 11. Precommit, persisted before any funding.
const deliveryDeadlineSeconds = Math.max(600, Number(quoted.estimated_completion_seconds || 120) * 5);
const nowSeconds = Math.floor(Date.now() / 1000);
const observationDeadlineAtUnixSeconds = nowSeconds + deliveryDeadlineSeconds;
const expiryBufferSeconds = 300;
const deadlineAtUnixSeconds = observationDeadlineAtUnixSeconds + Number(disputeWindow) + expiryBufferSeconds;
const benchmark = {
  id: REBALANCE_BENCHMARK_ID,
  version: definition.version,
  category: CATEGORIES.REBALANCING,
  task: definition.task.question,
  control: { id: REBALANCE_CONTROL_VERSION, description: "Recompute the same frozen PancakeSwap position assessment deterministically with no agent, no payment, and no capital movement.", sameFrozenEvidence: true, inputHash: contentHashes(rebalanceBenchControlTask(definition)).keccak256 },
  expectedOutputFields: [],
  requiredAgentFields: [],
};
const manifest = createPrecommitManifest({
  runId,
  agent: { ...candidate, services: candidate.services },
  benchmark,
  input: { ...agentInput, deadlineAtUnixSeconds, providerDeliveryDeadlineSeconds: deliveryDeadlineSeconds },
  limits: { maxBudgetRaw: priceRaw, authorizationCeilingRaw: MAX_PRICE_RAW.toString(), noTransactionByAgent: true, capitalMovement: false, mainnet: false },
  startAt: nowIso(),
  deadlineAtUnixSeconds,
  deadlinePlan: { providerDeliveryDeadlineSeconds: deliveryDeadlineSeconds, providerDeliveryDeadlineAtUnixSeconds: observationDeadlineAtUnixSeconds, onchainExpiryAtUnixSeconds: deadlineAtUnixSeconds, benchmarkObservationWindowSeconds: deliveryDeadlineSeconds, disputeWindowSeconds: Number(disputeWindow), expiryBufferSeconds },
  runType: RUN_TYPES.BENCHMARK,
  provenanceMode: "LIVE_QUALIFYING",
  providerIdentity: candidate.identity,
  providerAddress: identityRecord.provider,
  quoteTerms: { ...quoteTerms, negotiationHash: envelope.negotiation_hash, providerSignature: envelope.provider_sig, quoteExpiresAt },
  expectedEvidenceSchema: { deliverable: "ERC-8183 submitted manifest with PancakeSwap V3 range assessment JSON", storage: "IPFS content-addressed", requiredOutputKeys: OUTPUT_FIELDS },
  validityCriteria: ["frozen RebalanceBench v1 precommit intact", "human baseline sealed before the agent run", "ERC-8004 identity 2005 verified onchain", "fresh provider-signed quote verified", "watcher RPC capability verified", "funded ERC-8183 job", "observed onchain submission", "deterministic evaluator", "no human answer in the provider payload"],
  costAccounting: { agentFee: `${priceRaw} raw ${tokenSymbol}`, networkGas: "sum of actual buyer receipts", control: "zero payment and zero gas" },
});
const precommitRecord = {
  manifest,
  benchmarkPrecommit: precommit,
  venue: "PancakeSwap",
  pool: definition.pool,
  positionTokenId: definition.position.tokenId,
  referenceBlock: definition.referenceBlock,
  erc8004: { identity: candidate.identity, agentId: identityRecord.agentId, registry: identityRecord.registry, provider: identityRecord.provider, owner: registryOwner },
  taskHash: contentHashes(providerTask).keccak256,
  sourcePacketHash: contentHashes(sourcePacket).keccak256,
  outputSchema: OUTPUT_FIELDS,
  evaluatorVersion: REBALANCE_EVALUATOR_VERSION,
  policyVersion: REBALANCE_POLICY.version,
  humanBaselineReference: { attemptId: baseline.attemptId, evidenceSha256: baseline.evidence.sha256, evidenceKeccak256: baseline.evidence.keccak256, sealedAt: baseline.submittedAt, elapsedMs: baseline.elapsedMs, answerWithheldFromProvider: true },
  quote: { priceRaw, currency: quoteTerms.currency, quoteExpiresAt, negotiationHash: envelope.negotiation_hash, signatureVerified: true, signer: signature.signer },
  hirePreparation,
  leakageChecks,
  rpcCapability: { provider: readiness.body.rpc, buyer: { capable: buyerRpcCapability.capable, configuredVia: buyerRpcEnvironment.perNetworkKey } },
  deadlineAtUnixSeconds,
  runId,
  createdAt: nowIso(),
};
const precommitEvidence = await store.saveEvidence({ kind: "rebalancebench_agent_run_precommit", ...precommitRecord });
await store.saveJson(`state/precommit-${runId}.json`, { ...precommitRecord, evidence: precommitEvidence });
log({ status: "precommitted", runId, hireAttemptId: hirePreparation.attemptId, manifestHash: manifest.manifestHash, precommitEvidence: precommitEvidence.sha256, priceRaw, provider: identityRecord.provider, identity: candidate.identity, referenceBlock: definition.referenceBlock.number, pool: definition.pool.address, positionTokenId: definition.position.tokenId });

if (env.CANNED_ALLOW_TESTNET_WRITES !== "true") stop("CANNED_ALLOW_TESTNET_WRITES is not true; the precommit is stored and no transaction was attempted.", { runId, priceRaw });

// 12. Real ERC-8183 buyer lifecycle.
const hireStartedAt = Date.now();
const quoteForBuyer = { quote: { terms: quoteTerms, quote_expires_at: quoteExpiresAt }, negotiationHash: envelope.negotiation_hash, rawResponse: { result: { parts: [{ kind: "data", data: envelope }] } } };
const funded = await createFundedJob({ agent: { ...candidate, agentWallet: identityRecord.provider, ownerAddress: identityRecord.provider }, precommit: { ...manifest, deadlineAtUnixSeconds }, quote: quoteForBuyer, store, env });
if (!funded.ok) stop("The ERC-8183 buyer lifecycle did not reach funded state.", { runId, error: funded.error || null, state: funded.record?.state || null });
const jobId = funded.record.jobId;
const fundedAt = Date.now();
log({ status: "funded", runId, jobId, priceRaw });

// 13. Observe the provider's own watcher.
let latest = null;
let previous = null;
let submittedObservedAt = null;
while (Date.now() < observationDeadlineAtUnixSeconds * 1000) {
  try {
    latest = await readJob({ client: funded.client, jobId });
    if (latest.status !== previous) {
      previous = latest.status;
      await appendProtocolEvent({ store, runId, event: "chain_state_observed", extra: { snapshot: latest } });
      log({ status: "chain_state", runId, jobId, chainState: latest.status });
    }
    if (["SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"].includes(latest.status)) { submittedObservedAt = Date.now(); break; }
  } catch (error) {
    await appendProtocolEvent({ store, runId, event: "chain_read_error", extra: { error: safeError(error) } });
  }
  await delay(10_000);
}
const timedOut = !latest || !["SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"].includes(latest.status);

// 14. Retrieve and validate the raw deliverable before any grading.
let agentOutput = null;
let deliverableValidation = null;
let deliverableEvidence = null;
let deliverableRef = null;
let deliverableCid = null;
let retrievedFrom = null;
if (latest && ["SUBMITTED", "COMPLETED"].includes(latest.status)) {
  try { deliverableRef = await funded.client.getDeliverableUrl(BigInt(jobId)); }
  catch (error) { await appendProtocolEvent({ store, runId, event: "deliverable_url_error", extra: { error: safeError(error) } }); }
  const resolved = await fetchDeliverable(deliverableRef);
  if (resolved.ok) {
    deliverableCid = resolved.cid;
    retrievedFrom = resolved.url;
    const fetched = resolved.response;
    deliverableEvidence = await store.saveEvidence({ kind: "range_keeper_deliverable_raw", runId, jobId, reference: deliverableRef, cid: resolved.cid, contentAddressed: resolved.contentAddressed, retrievedFrom: resolved.url, httpStatus: fetched.status, body: fetched.body, rawText: fetched.rawText });
    deliverableValidation = validateSubmittedDeliverable({ body: fetched.body, jobId, onchainDeliverable: latest.deliverable, expectedOutputFields: OUTPUT_FIELDS });
    agentOutput = extractProviderDeliverable(fetched.body).output;
    const boundToBlock = String(agentOutput?.position?.asOfBlock ?? "") === String(definition.referenceBlock.number);
    const boundToPool = String(agentOutput?.position?.pool || "").toLowerCase() === String(definition.pool.address).toLowerCase();
    const boundToPosition = String(agentOutput?.position?.tokenId ?? "") === String(definition.position.tokenId);
    const noHumanLeakage = !humanValues.some((value) => JSON.stringify(agentOutput ?? {}).includes(value));
    if (!boundToBlock) deliverableValidation.errors.push("deliverable_reference_block_mismatch");
    if (!boundToPool) deliverableValidation.errors.push("deliverable_pool_mismatch");
    if (!boundToPosition) deliverableValidation.errors.push("deliverable_position_mismatch");
    if (!noHumanLeakage) deliverableValidation.errors.push("deliverable_contains_human_answer");
    if (agentOutput?.execution?.capitalMoved !== false) deliverableValidation.errors.push("deliverable_claims_capital_movement");
    deliverableValidation.valid = deliverableValidation.errors.length === 0;
    deliverableValidation.hasActualDeliverable = deliverableValidation.valid && Boolean(deliverableValidation.manifestHash);
    Object.assign(deliverableValidation, { boundToBlock, boundToPool, boundToPosition, contentAddressed: resolved.contentAddressed });
    await appendProtocolEvent({ store, runId, event: "deliverable_observed", extra: { reference: deliverableRef, cid: resolved.cid, evidence: deliverableEvidence, httpStatus: fetched.status, validation: { ...deliverableValidation, output: undefined } } });
    log({ status: "deliverable_observed", runId, jobId, valid: deliverableValidation.valid, errors: deliverableValidation.errors, cid: resolved.cid });
  } else {
    await appendProtocolEvent({ store, runId, event: "deliverable_unreachable", extra: { reference: deliverableRef, attempts: resolved.attempts } });
  }
}

// 15. Refund an expired job; settle a submitted one.
if (latest?.status === "FUNDED" && Number(latest.expiredAt) <= Math.floor(Date.now() / 1000)) {
  try {
    const refunded = await funded.client.claimRefund(BigInt(jobId));
    latest = await readJob({ client: funded.client, jobId });
    await appendProtocolEvent({ store, runId, event: "claim_refund", extra: { tx: txShape(refunded), snapshot: latest } });
  } catch (error) { await appendProtocolEvent({ store, runId, event: "claim_refund_error", extra: { error: safeError(error) } }); }
}
if (latest?.status === "SUBMITTED") {
  const submittedAtChain = Number(latest.submittedAt);
  const settleAt = (Number.isFinite(submittedAtChain) && submittedAtChain > 0 ? submittedAtChain : Math.floor(Date.now() / 1000)) + Number(disputeWindow);
  log({ status: "awaiting_dispute_window", runId, jobId, settleAtUnixSeconds: settleAt, disputeWindowSeconds: Number(disputeWindow) });
  while (Math.floor(Date.now() / 1000) < settleAt + 2) await delay(5_000);
  for (let attempt = 1; attempt <= 6 && latest.status === "SUBMITTED"; attempt += 1) {
    try {
      const settled = await funded.client.settle(BigInt(jobId));
      await appendProtocolEvent({ store, runId, event: "settle_job", extra: { tx: txShape(settled), attempt } });
      latest = await readJob({ client: funded.client, jobId });
      await appendProtocolEvent({ store, runId, event: "chain_state_observed", extra: { snapshot: latest } });
      log({ status: "settled", runId, jobId, chainState: latest.status, attempt });
    } catch (error) {
      await appendProtocolEvent({ store, runId, event: "settle_error", extra: { error: safeError(error), attempt } });
      await delay(5_000);
      latest = await readJob({ client: funded.client, jobId });
    }
  }
}

// 16. Independent control, then the persisted run record.
const controlStart = Date.now();
const control = buildIndependentRangeControl({ task: rebalanceBenchControlTask(definition) });
const controlOutput = { ...control.output, provenance: control.provenance, status: control.status, elapsedMs: Date.now() - controlStart, cost: { paymentTokenRaw: "0", nativeGasWei: "0" }, dataLimitations: ["Deterministic protocol-read control. It moves no capital and pays no fee.", "It is not the human baseline."] };
const [allowanceAfter, tokenBalanceAfter, nativeAfter, providerNativeAfter] = await Promise.all([
  buyerClient.tokenAllowance(buyerWallet.address, buyerClient.commerce.address),
  buyerClient.tokenBalance(buyerWallet.address),
  publicClient.getBalance({ address: buyerWallet.address }),
  publicClient.getBalance({ address: identityRecord.provider }),
]);
const protocolJob = await store.loadJson(`state/protocol-job-${runId}.json`, funded.record);
const buyerGasWei = (protocolJob.events || []).reduce((total, event) => total + BigInt(event.tx?.gasCostWei || "0"), 0n);
const onchainSubmittedAtMs = Number(latest?.submittedAt) > 0 ? Number(latest.submittedAt) * 1000 : null;
const elapsedMs = onchainSubmittedAtMs ? onchainSubmittedAtMs - quoteRequestedAt : (submittedObservedAt || Date.now()) - quoteRequestedAt;
const agentExecution = {
  status: timedOut ? "timeout" : deliverableValidation?.valid ? "completed" : deliverableValidation ? "error" : latest?.status === "EXPIRED" ? "expired" : "error",
  elapsedMs,
  timing: {
    quoteRequestedAt: new Date(quoteRequestedAt).toISOString(),
    hireStartedAtMs: hireStartedAt - quoteRequestedAt,
    fundedAtMs: fundedAt - quoteRequestedAt,
    submittedObservedAtMs: submittedObservedAt ? submittedObservedAt - quoteRequestedAt : null,
    onchainSubmittedAtUnixSeconds: Number(latest?.submittedAt) || null,
    hireToOnchainSubmissionMs: elapsedMs,
    fundedToSubmittedMs: onchainSubmittedAtMs ? onchainSubmittedAtMs - fundedAt : null,
    elapsedBasis: "quote requested to the provider's onchain submission, including any provider downtime and operator intervention",
  },
  cost: { serviceFeeRaw: priceRaw, paymentToken: tokenSymbol, paymentTokenDecimals: tokenDecimals, gasWei: buyerGasWei.toString() },
  deliverableUrl: deliverableRef,
  cid: deliverableCid,
  retrievedFrom,
  evidence: deliverableEvidence,
  deliverableValidation,
};
const run = await runBenchmark({
  agent: { identity: candidate.identity, name: candidate.name, origin: candidate.origin },
  benchmark,
  input: { ...agentInput, deadlineAtUnixSeconds },
  agentOutput: agentOutput ?? {},
  agentDeliverableValidation: deliverableValidation,
  controlOutput,
  store,
  runType: RUN_TYPES.BENCHMARK,
  provenanceMode: "LIVE_QUALIFYING",
  precommit: manifest,
  precommitEvidence,
  protocolJob,
  executionStatus: agentExecution.status,
  agentExecution,
  controlExecution: { status: "completed", elapsedMs: controlOutput.elapsedMs, cost: controlOutput.cost, methodology: control.provenance },
  termixEligiblePair: false,
  termixReason: "TermiX qualification is computed separately by the grading step from the sealed pair.",
  deadlinePlan: manifest.deadlines,
});
await store.saveJson(`state/rebalancebench-run-${runId}.json`, {
  kind: "rebalancebench_agent_run",
  runId, jobId,
  hireAttemptId: hirePreparation.attemptId,
  benchmarkId: REBALANCE_BENCHMARK_ID,
  venue: "PancakeSwap",
  pool: definition.pool.address,
  positionTokenId: definition.position.tokenId,
  referenceBlock: definition.referenceBlock.number,
  identity: candidate.identity,
  provider: identityRecord.provider,
  hirePreparation,
  quote: precommitRecord.quote,
  agentExecution,
  deliverable: { reference: deliverableRef, cid: deliverableCid, retrievedFrom, evidence: deliverableEvidence, validation: deliverableValidation, rawOutput: agentOutput },
  economics: { serviceFeeRaw: priceRaw, buyerGasWei: buyerGasWei.toString(), tokenBalanceBeforeRaw: tokenBalance.toString(), tokenBalanceAfterRaw: tokenBalanceAfter.toString(), nativeBalanceBeforeWei: nativeBalance.toString(), nativeBalanceAfterWei: nativeAfter.toString(), providerNativeAfterWei: providerNativeAfter.toString(), allowanceBeforeRaw: allowanceBefore.toString(), allowanceAfterRaw: allowanceAfter.toString() },
  chainState: latest?.status || "UNKNOWN",
  terminalState: run.terminalState,
  createdAt: nowIso(),
});
buyerWallet.destroy();
log({ status: "complete", runId, jobId, chainState: latest?.status || "UNKNOWN", terminalState: run.terminalState, qualification: run.qualification, deliverableValid: deliverableValidation?.valid ?? false, cid: deliverableCid, serviceFeeRaw: priceRaw, buyerGasWei: buyerGasWei.toString(), allowanceAfterRaw: allowanceAfter.toString(), next: "npm run range:grade" });
