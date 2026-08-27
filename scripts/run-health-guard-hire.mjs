import path from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { verifyQuoteSignature } from "@bnbagent/sdk/erc8183";
import { createPrecommitManifest, runBenchmark } from "../src/benchmark/framework.mjs";
import { extractProviderDeliverable, validateSubmittedDeliverable } from "../src/benchmark/validation.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";
import { contentHashes, id, isPublicHttpUrl, nowIso, requestJson, safeError } from "../src/core.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { selectHiringAdapter } from "../src/marketplace/adapters.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { appendProtocolEvent, createFundedJob, loadSdk, preflightGuards, readJob, txShape, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { referenceAgentCandidate, referenceSpec, REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { healthBenchAgentInput, healthBenchControlTask, healthBenchProviderTask, healthBenchRunDefinition, validateHealthBenchAgentInput, baselineContainsSecretAnswer, HEALTH_BENCHMARK_ID, HEALTH_CONTROL_VERSION, HEALTH_EVALUATOR_VERSION } from "../src/reference/health-benchmark.mjs";
import { buildIndependentHealthFactorControl } from "../src/reference/health-factor.mjs";

const MAX_PRICE_RAW = 10_000_000_000_000_000n; // 0.01 U hard ceiling for this directive.
const EXPECTED_PRICE_RAW = 1_000_000_000_000_000n; // 0.001 U service class.

const env = process.env;
const root = path.resolve(process.cwd());
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(root, "data"));
const store = await new FileStore(dataDir).init();
let buyerWallet = null;

function stop(reason, details = {}) {
  console.log(JSON.stringify({ status: "blocked", reason, ...details }, null, 2));
  buyerWallet?.destroy();
  process.exit(2);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (body) => console.log(JSON.stringify(body, null, 2));

// 1. Frozen benchmark and its precommit must be intact before anything else.
const definition = await store.loadJson("state/healthbench-v1.json", null);
if (!definition) stop("HealthBench v1 has not been frozen.");
const recomputed = contentHashes({ ...definition, precommit: undefined, hashes: undefined });
const { precommit, ...withoutPrecommit } = definition;
const definitionHashes = contentHashes(withoutPrecommit);
if (definitionHashes.sha256 !== precommit?.canonicalSha256 || definitionHashes.keccak256 !== precommit?.manifestKeccak256) {
  stop("The frozen HealthBench v1 definition no longer matches its own precommit hashes; refusing to spend.", { expected: precommit, recomputed: definitionHashes, recomputedWithPrecommitField: recomputed.sha256 });
}

// 2. The human baseline must already be sealed. The agent never runs first.
const baseline = await store.loadJson("state/health-baseline.json", null);
if (baseline?.status !== "submitted") stop("The human baseline is not sealed; the agent run is not authorized.");
if (baseline.benchmarkId !== HEALTH_BENCHMARK_ID) stop("The sealed baseline is bound to a different benchmark.");
const baselineManifest = await store.loadJson("evidence/healthbench-v1/human-baseline/manifest.json", null);
if (!baselineManifest) stop("The sealed human-baseline evidence manifest is missing.");
if (contentHashes(baseline.rawSubmissionJson).sha256 !== baselineManifest.rawSubmission.sha256) stop("The sealed human baseline no longer matches its evidence hash; refusing to proceed.");

// 3. Registered ERC-8004 identity record.
const identityRecord = await store.loadJson("state/reference-health-identity.json", null);
if (!identityRecord?.agentId) stop("The Health Guard ERC-8004 identity record is missing.");
const spec = referenceSpec("health-factor");

// 4. Live provider surface.
const agentUrl = identityRecord.endpoint;
if (!isPublicHttpUrl(agentUrl)) stop("The Health Guard endpoint is not a public HTTPS URL.");
const surface = (suffix) => new URL(suffix, `${agentUrl.replace(/\/$/, "")}/`).toString();
const [health, readiness, status, metadata] = await Promise.all(["/health", "/readiness", "/status", "/metadata"].map((suffix) => requestJson(surface(suffix))));
if (!health.ok || !readiness.ok || !status.ok || !metadata.ok) stop("The Health Guard public surface did not answer completely.", { health: health.status, readiness: readiness.status, status: status.status, metadata: metadata.status });
if (readiness.body?.worker?.alive !== true) stop("The Health Guard worker is not alive; refusing to fund a job it cannot serve.");
if (readiness.body?.watcher?.alive !== true) stop("The Health Guard funded-job watcher is not alive; refusing to fund a job it cannot detect.");
if (readiness.body?.storage?.mode !== "ipfs") stop("The Health Guard is not using content-addressed IPFS storage.", { storage: readiness.body?.storage });
if (Number(status.body?.chainId) !== REFERENCE_CHAIN_ID) stop("The Health Guard is not serving BSC Testnet.");
if (String(status.body?.provider).toLowerCase() !== String(identityRecord.provider).toLowerCase()) stop("The live provider address does not match the registered identity.");

// 5. Independent onchain ERC-8004 verification.
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com"] } } };
const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 15_000 }) });
const registryAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function getAgentWallet(uint256 agentId) view returns (address)"]);
const [registryOwner, registryWallet] = await Promise.all([
  publicClient.readContract({ address: identityRecord.registry, abi: registryAbi, functionName: "ownerOf", args: [BigInt(identityRecord.agentId)] }),
  publicClient.readContract({ address: identityRecord.registry, abi: registryAbi, functionName: "getAgentWallet", args: [BigInt(identityRecord.agentId)] }),
]);
if (registryOwner.toLowerCase() !== String(identityRecord.provider).toLowerCase() || registryWallet.toLowerCase() !== String(identityRecord.provider).toLowerCase()) {
  stop("ERC-8004 owner/provider mismatch; refusing the paid run.", { registryOwner, registryWallet, expected: identityRecord.provider });
}

// 6. Marketplace hire preparation. The reference agent goes through the same
//    record derivation and hiring adapter as any third-party listing, and its
//    readiness is derived from what was just observed rather than asserted.
const candidate = referenceAgentCandidate(spec, { providerAddress: identityRecord.provider, identityRecord, allowLocalProbe: false, publicReadinessVerified: readiness.body.worker.alive === true && readiness.body.watcher.alive === true && readiness.body.endpoint?.alive === true, baselineSealed: baseline.status === "submitted" });
const priorRuns = await store.loadRuns();
const agentRecord = deriveAgentRecord(candidate, priorRuns);
const adapter = selectHiringAdapter(candidate, { chainId: REFERENCE_CHAIN_ID });
const hirePreparation = { attemptId: id("hire"), agent: { identity: candidate.identity, name: candidate.name }, protocol: adapter.protocol || "ERC-8183", adapterStatus: adapter.status, adapterReason: adapter.reason || null, readinessConditions: candidate.selectionGate.readiness.conditions, trustBefore: agentRecord.trust.reached, statusBefore: agentRecord.status.label, preparedAt: nowIso() };
if (candidate.identity !== `${REFERENCE_CHAIN_ID}:${String(identityRecord.registry).toLowerCase()}:${identityRecord.agentId}`) stop("Marketplace identity does not resolve to the registered ERC-8004 agent.", { candidate: candidate.identity });
if (adapter.status !== "ready") stop("The marketplace hiring adapter is not ready for this agent.", { adapter, conditions: candidate.selectionGate.readiness.conditions });

// 7. Buyer readiness.
const sdk = await loadSdk();
const safety = writeSafety(env);
if (safety.network !== REFERENCE_NETWORK) stop("Canned is not configured for BSC Testnet; no mainnet path is authorized.", { network: safety.network });
if (!env.CANNED_EXECUTION_WALLET_PASSWORD || !env.CANNED_EXECUTION_WALLET_ADDRESS) stop("The Canned buyer wallet is not configured.");
buyerWallet = new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });
const buyerClient = await sdk.ERC8183Client.create({ network: REFERENCE_NETWORK, walletProvider: buyerWallet });
const [rpcChainId, nativeBalance, gasPriceWei, paymentToken, tokenDecimals, tokenSymbol, tokenBalance, allowanceBefore, disputeWindow] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: buyerWallet.address }),
  publicClient.getGasPrice(),
  buyerClient.paymentToken(),
  buyerClient.tokenDecimals(),
  buyerClient.tokenSymbol(),
  buyerClient.tokenBalance(buyerWallet.address),
  buyerClient.tokenAllowance(buyerWallet.address, buyerClient.commerce.address),
  buyerClient.policy.disputeWindow(),
]);
if (rpcChainId !== REFERENCE_CHAIN_ID) stop(`Refusing to operate on chain ${rpcChainId}.`);
if (paymentToken.toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase()) stop("The live ERC-8183 payment token is not the expected U contract.", { paymentToken });

// 8. Fresh signed quote. Nothing older is reused.
const runId = id("run");
const quoteRequestedAt = Date.now();
const quoteRequest = {
  task_description: `Canned paid hire for ${HEALTH_BENCHMARK_ID} (${definition.version}). Benchmark precommit ${precommit.manifestKeccak256}. Run ${runId}. Assess the frozen Venus position at block ${definition.frozenEvidence.snapshot.asOfBlock}; read-only, no capital movement.`,
  terms: { deliverables: "Structured Health Factor assessment for the frozen HealthBench v1 snapshot", quality_standards: "Authoritative Venus reads only; bounded, non-transactional recommendation", success_criteria: ["Deliverable submitted onchain", "No capital movement", "Bound to the frozen snapshot"] },
  request_id: `${runId}-${quoteRequestedAt}`,
};
const quoteResponse = await requestJson(surface("/negotiate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: quoteRequest });
const envelope = quoteResponse.body || {};
const quoted = envelope.response || {};
const quoteTerms = quoted.terms || {};
const priceRaw = String(quoteTerms.price ?? "");
const quoteExpiresAt = Number(quoted.quote_expires_at ?? 0);
if (!quoteResponse.ok || quoted.accepted !== true || !envelope.provider_sig || !envelope.negotiation_hash) stop("The Health Guard did not return an accepted signed quote.", { httpStatus: quoteResponse.status });
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

// 9. Contamination guard. The provider payload carries the frozen task only.
const agentInput = healthBenchAgentInput(definition);
const inputValidation = validateHealthBenchAgentInput({ definition, input: agentInput });
const providerTask = healthBenchProviderTask(definition);
const leakageChecks = {
  agentInputMatchesFrozenDefinition: inputValidation.valid,
  noForbiddenAnswerKeys: !baselineContainsSecretAnswer(agentInput) && !baselineContainsSecretAnswer(providerTask) && !baselineContainsSecretAnswer(quoteRequest),
  humanSubmissionAbsent: !JSON.stringify({ agentInput, providerTask, quoteRequest }).includes(String(baseline.submission.positionFacts)),
  groundTruthAbsent: baseline.groundTruth === null,
};
if (!Object.values(leakageChecks).every(Boolean)) stop("The provider payload failed the human-answer contamination guard.", { leakageChecks, errors: inputValidation.errors });

// 10. Precommit, persisted before any funding.
const benchmarkDefinition = healthBenchRunDefinition(definition);
// The provider may only submit before expiredAt - disputeWindow, so the onchain
// expiry has to clear the provider window, the dispute window, and a buffer.
const deliveryDeadlineSeconds = Math.max(600, Number(quoted.estimated_completion_seconds || 120) * 5);
const nowSeconds = Math.floor(Date.now() / 1000);
const observationDeadlineAtUnixSeconds = nowSeconds + deliveryDeadlineSeconds;
const expiryBufferSeconds = 300;
const deadlineAtUnixSeconds = observationDeadlineAtUnixSeconds + Number(disputeWindow) + expiryBufferSeconds;
const benchmark = {
  id: benchmarkDefinition.id,
  version: benchmarkDefinition.version,
  category: CATEGORIES.HEALTH_FACTOR_MONITORING,
  task: definition.task.question,
  control: { id: HEALTH_CONTROL_VERSION, description: benchmarkDefinition.control.description, procedure: "Recompute the same frozen Venus position deterministically with no agent, no payment, and no capital movement.", sameFrozenEvidence: true, inputHash: benchmarkDefinition.control.inputHash },
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
  expectedEvidenceSchema: { deliverable: "ERC-8183 submitted manifest with Health Factor assessment JSON", storage: "IPFS content-addressed", requiredOutputKeys: ["position", "assessment", "changes", "recommendation", "evidence"] },
  validityCriteria: ["frozen HealthBench v1 precommit intact", "human baseline sealed before the agent run", "ERC-8004 identity 2003 verified onchain", "fresh provider-signed quote verified", "funded ERC-8183 job", "observed onchain submission", "deterministic evaluator", "no human answer in the provider payload"],
  costAccounting: { agentFee: `${priceRaw} raw ${tokenSymbol}`, networkGas: "sum of actual buyer receipts", control: "zero payment and zero gas" },
});
const precommitRecord = {
  manifest,
  benchmarkPrecommit: precommit,
  referenceBlock: definition.frozenEvidence.snapshot.asOfBlock,
  erc8004: { identity: candidate.identity, agentId: identityRecord.agentId, registry: identityRecord.registry, provider: identityRecord.provider, owner: registryOwner },
  taskHash: contentHashes(providerTask).keccak256,
  outputSchema: ["position", "assessment", "changes", "recommendation", "evidence"],
  evaluatorVersion: HEALTH_EVALUATOR_VERSION,
  humanBaselineReference: { attemptId: baseline.attemptId, evidenceSha256: baselineManifest.rawSubmission.sha256, sealedAt: baseline.submittedAt, answerWithheldFromProvider: true },
  quote: { priceRaw, currency: quoteTerms.currency, quoteExpiresAt, negotiationHash: envelope.negotiation_hash, signatureVerified: true, signer: signature.signer },
  hirePreparation,
  leakageChecks,
  deadlineAtUnixSeconds,
  runId,
  createdAt: nowIso(),
};
const precommitEvidence = await store.saveEvidence({ kind: "healthbench_agent_run_precommit", ...precommitRecord });
await store.saveJson(`state/precommit-${runId}.json`, { ...precommitRecord, evidence: precommitEvidence });
log({ status: "precommitted", runId, manifestHash: manifest.manifestHash, precommitEvidence: precommitEvidence.sha256, priceRaw, provider: identityRecord.provider, identity: candidate.identity, referenceBlock: precommitRecord.referenceBlock });

if (env.CANNED_ALLOW_TESTNET_WRITES !== "true") stop("CANNED_ALLOW_TESTNET_WRITES is not true; the precommit is stored and no transaction was attempted.", { runId, priceRaw });

// 11. Real ERC-8183 buyer lifecycle.
const hireStartedAt = Date.now();
const quoteForBuyer = { quote: { terms: quoteTerms, quote_expires_at: quoteExpiresAt }, negotiationHash: envelope.negotiation_hash, rawResponse: { result: { parts: [{ kind: "data", data: envelope }] } } };
const funded = await createFundedJob({ agent: { ...candidate, agentWallet: identityRecord.provider, ownerAddress: identityRecord.provider }, precommit: { ...manifest, deadlineAtUnixSeconds }, quote: quoteForBuyer, store, env });
if (!funded.ok) stop("The ERC-8183 buyer lifecycle did not reach funded state.", { runId, error: funded.error || null, state: funded.record?.state || null });
const jobId = funded.record.jobId;
const fundedAt = Date.now();
log({ status: "funded", runId, jobId, priceRaw });

// 12. Observe the provider's own watcher.
let latest = null;
let previous = null;
let submittedAt = null;
while (Date.now() < observationDeadlineAtUnixSeconds * 1000) {
  try {
    latest = await readJob({ client: funded.client, jobId });
    if (latest.status !== previous) {
      previous = latest.status;
      await appendProtocolEvent({ store, runId, event: "chain_state_observed", extra: { snapshot: latest } });
      log({ status: "chain_state", runId, jobId, chainState: latest.status });
    }
    if (["SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"].includes(latest.status)) { submittedAt = Date.now(); break; }
  } catch (error) {
    await appendProtocolEvent({ store, runId, event: "chain_read_error", extra: { error: safeError(error) } });
  }
  await delay(10_000);
}
const timedOut = !latest || !["SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"].includes(latest.status);

// 13. Retrieve and validate the raw deliverable before any grading.
let agentOutput = null;
let deliverableValidation = null;
let deliverableEvidence = null;
let deliverableUrl = null;
let deliverableRetrievedAt = null;
if (latest && ["SUBMITTED", "COMPLETED"].includes(latest.status)) {
  try {
    deliverableUrl = await funded.client.getDeliverableUrl(BigInt(jobId));
  } catch (error) {
    await appendProtocolEvent({ store, runId, event: "deliverable_url_error", extra: { error: safeError(error) } });
  }
  if (deliverableUrl && isPublicHttpUrl(deliverableUrl)) {
    const fetched = await requestJson(deliverableUrl, { timeoutMs: 30_000 });
    deliverableRetrievedAt = Date.now();
    deliverableEvidence = await store.saveEvidence({ kind: "health_guard_deliverable_raw", runId, jobId, url: deliverableUrl, httpStatus: fetched.status, body: fetched.body, rawText: fetched.rawText });
    deliverableValidation = validateSubmittedDeliverable({ body: fetched.body, jobId, onchainDeliverable: latest.deliverable, expectedOutputFields: ["position", "assessment", "changes", "recommendation", "evidence"] });
    agentOutput = extractProviderDeliverable(fetched.body).output;
    const boundToBenchmark = agentOutput?.position?.asOfBlock !== undefined && String(agentOutput.position.asOfBlock) === String(definition.frozenEvidence.snapshot.asOfBlock);
    const boundToAccount = String(agentOutput?.position?.account || "").toLowerCase() === String(definition.position.account).toLowerCase();
    const noHumanLeakage = !JSON.stringify(agentOutput ?? {}).includes(String(baseline.submission.positionFacts));
    if (!boundToBenchmark) deliverableValidation.errors.push("deliverable_reference_block_mismatch");
    if (!boundToAccount) deliverableValidation.errors.push("deliverable_account_mismatch");
    if (!noHumanLeakage) deliverableValidation.errors.push("deliverable_contains_human_answer");
    deliverableValidation.valid = deliverableValidation.errors.length === 0;
    deliverableValidation.hasActualDeliverable = deliverableValidation.valid && deliverableValidation.hasActualDeliverable;
    deliverableValidation.boundToBenchmark = boundToBenchmark;
    deliverableValidation.boundToAccount = boundToAccount;
    await appendProtocolEvent({ store, runId, event: "deliverable_observed", extra: { deliverableUrl, evidence: deliverableEvidence, httpStatus: fetched.status, validation: { ...deliverableValidation, output: undefined } } });
    log({ status: "deliverable_observed", runId, jobId, valid: deliverableValidation.valid, errors: deliverableValidation.errors, cid: deliverableUrl });
  } else {
    await appendProtocolEvent({ store, runId, event: "deliverable_url_missing", extra: { deliverableUrl } });
  }
}

// 14. Refund an expired job; settle a submitted one.
if (latest?.status === "FUNDED" && Number(latest.expiredAt) <= Math.floor(Date.now() / 1000)) {
  try {
    const refunded = await funded.client.claimRefund(BigInt(jobId));
    latest = await readJob({ client: funded.client, jobId });
    await appendProtocolEvent({ store, runId, event: "claim_refund", extra: { tx: txShape(refunded), snapshot: latest } });
  } catch (error) {
    await appendProtocolEvent({ store, runId, event: "claim_refund_error", extra: { error: safeError(error) } });
  }
}
if (latest?.status === "SUBMITTED") {
  const submittedAtChain = Number(latest.submittedAt);
  const settleAt = (Number.isFinite(submittedAtChain) && submittedAtChain > 0 ? submittedAtChain : Math.floor(Date.now() / 1000)) + Number(disputeWindow);
  log({ status: "awaiting_dispute_window", runId, jobId, settleAtUnixSeconds: settleAt, disputeWindowSeconds: Number(disputeWindow) });
  while (Date.now() < settleAt * 1000 + 5_000) await delay(15_000);
  try {
    const settled = await funded.client.settle(BigInt(jobId));
    await appendProtocolEvent({ store, runId, event: "settle_job", extra: { tx: txShape(settled) } });
    latest = await readJob({ client: funded.client, jobId });
    await appendProtocolEvent({ store, runId, event: "chain_state_observed", extra: { snapshot: latest } });
    log({ status: "settled", runId, jobId, chainState: latest.status });
  } catch (error) {
    await appendProtocolEvent({ store, runId, event: "settle_error", extra: { error: safeError(error) } });
    log({ status: "settle_error", runId, jobId, error: safeError(error) });
  }
}

// 15. Independent control, then the persisted run record.
const controlStart = Date.now();
const control = buildIndependentHealthFactorControl({ task: healthBenchControlTask(definition) });
const controlOutput = { ...control.output, provenance: control.provenance, status: control.status, elapsedMs: Date.now() - controlStart, cost: { paymentTokenRaw: "0", nativeGasWei: "0" }, dataLimitations: ["Deterministic protocol-read control. It moves no capital and pays no fee.", "It is not the human baseline."] };
const [allowanceAfter, tokenBalanceAfter, nativeAfter] = await Promise.all([
  buyerClient.tokenAllowance(buyerWallet.address, buyerClient.commerce.address),
  buyerClient.tokenBalance(buyerWallet.address),
  publicClient.getBalance({ address: buyerWallet.address }),
]);
const protocolJob = await store.loadJson(`state/protocol-job-${runId}.json`, funded.record);
const buyerGasWei = (protocolJob.events || []).reduce((total, event) => total + BigInt(event.tx?.gasCostWei || "0"), 0n);
const endToEndMs = (deliverableRetrievedAt || submittedAt || Date.now()) - quoteRequestedAt;
const agentExecution = {
  status: timedOut ? "timeout" : deliverableValidation?.valid ? "completed" : deliverableValidation ? "error" : latest?.status === "EXPIRED" ? "expired" : "error",
  elapsedMs: endToEndMs,
  timing: { quoteRequestedAt: new Date(quoteRequestedAt).toISOString(), hireStartedAtMs: hireStartedAt - quoteRequestedAt, fundedAtMs: fundedAt - quoteRequestedAt, submittedObservedAtMs: submittedAt ? submittedAt - quoteRequestedAt : null, deliverableRetrievedAtMs: deliverableRetrievedAt ? deliverableRetrievedAt - quoteRequestedAt : null, fundedToSubmittedMs: submittedAt ? submittedAt - fundedAt : null, endToEndMs },
  cost: { serviceFeeRaw: priceRaw, paymentToken: tokenSymbol, paymentTokenDecimals: tokenDecimals, gasWei: buyerGasWei.toString() },
  deliverableUrl,
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
await store.saveJson(`state/healthbench-run-${runId}.json`, {
  kind: "healthbench_agent_run",
  runId,
  jobId,
  benchmarkId: HEALTH_BENCHMARK_ID,
  referenceBlock: definition.frozenEvidence.snapshot.asOfBlock,
  identity: candidate.identity,
  provider: identityRecord.provider,
  hirePreparation,
  quote: precommitRecord.quote,
  agentExecution,
  deliverable: { url: deliverableUrl, evidence: deliverableEvidence, validation: deliverableValidation, rawOutput: agentOutput },
  economics: { serviceFeeRaw: priceRaw, buyerGasWei: buyerGasWei.toString(), tokenBalanceBeforeRaw: tokenBalance.toString(), tokenBalanceAfterRaw: tokenBalanceAfter.toString(), nativeBalanceBeforeWei: nativeBalance.toString(), nativeBalanceAfterWei: nativeAfter.toString(), allowanceBeforeRaw: allowanceBefore.toString(), allowanceAfterRaw: allowanceAfter.toString() },
  chainState: latest?.status || "UNKNOWN",
  terminalState: run.terminalState,
  createdAt: nowIso(),
});
buyerWallet.destroy();
log({ status: "complete", runId, jobId, chainState: latest?.status || "UNKNOWN", terminalState: run.terminalState, qualification: run.qualification, deliverableValid: deliverableValidation?.valid ?? false, serviceFeeRaw: priceRaw, buyerGasWei: buyerGasWei.toString(), allowanceAfterRaw: allowanceAfter.toString(), next: "npm run health:grade" });
