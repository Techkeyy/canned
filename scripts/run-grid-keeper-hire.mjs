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
import { referenceAgentCandidate, referenceSpec, REFERENCE_CHAIN_ID, REFERENCE_IDENTITY_FILES, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { buildGridBenchmarkDefinition, publicGridBenchPacket, GRID_BENCHMARK_ID } from "../src/reference/grid-benchmark.mjs";
import { computeGridGroundTruth, GRID_EVALUATOR_VERSION } from "../src/reference/grid-evaluator.mjs";
import { GRID_EXECUTION_MODEL } from "../src/reference/grid-keeper.mjs";

const MAX_PRICE_RAW = 10_000_000_000_000_000n; // 0.01 U hard ceiling.
const EXPECTED_PRICE_RAW = 1_000_000_000_000_000n; // 0.001 U service class.
const OUTPUT_FIELDS = ["benchmarkId", "benchmarkPrecommit", "strategy", "levels", "answers", "execution", "executionModel"];
const REFERENCE_KEY = "grid";
const ANSWER_KEY_FIELD = `"${"expect"}"`;

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

// 1. The frozen benchmark must still reproduce its own precommit. GridBench
//    lives in code and is content addressed, so it is rebuilt and checked
//    rather than read from a file that could drift.
const definition = buildGridBenchmarkDefinition();
const precommit = definition.precommit;
const { precommit: _omit, ...withoutPrecommit } = definition;
const definitionHashes = contentHashes(withoutPrecommit);
if (definitionHashes.sha256 !== precommit?.sha256 || definitionHashes.keccak256 !== precommit?.keccak256) {
  stop("The frozen GridBench definition no longer matches its own precommit; refusing to spend.", { expected: precommit, recomputed: definitionHashes });
}
if (definition.market.readOnly !== true || definition.market.chainId !== 56) stop("The frozen market observation is not a read-only mainnet read.");
if (definition.strategy.chainId !== REFERENCE_CHAIN_ID) stop("The GridBench strategy is not bound to BSC Testnet.");

// 2. GridBench has no human baseline, by design: TermiX is already satisfied
//    by three paired tasks, so this run is a capability benchmark and is not
//    a fourth pair. There is therefore nothing a hire could contaminate, and
//    no baseline gate to check.

// 3. Registered identity, distinct from every sibling agent.
const identityRecord = await store.loadJson(REFERENCE_IDENTITY_FILES[REFERENCE_KEY], null);
if (!identityRecord?.agentId) stop("The Grid Keeper ERC-8004 identity record is missing.");
for (const [otherKey, file] of Object.entries(REFERENCE_IDENTITY_FILES)) {
  if (otherKey === REFERENCE_KEY) continue;
  const other = await store.loadJson(file, null);
  if (!other) continue;
  if (Number(other.agentId) === Number(identityRecord.agentId)) stop(`Grid Keeper must not share ${otherKey}'s ERC-8004 identity.`);
  if (other.endpoint === identityRecord.endpoint) stop(`Grid Keeper must not share ${otherKey}'s endpoint.`);
  if (String(other.provider).toLowerCase() === String(identityRecord.provider).toLowerCase()) stop(`Grid Keeper must not share ${otherKey}'s provider wallet.`);
}
const spec = referenceSpec(REFERENCE_KEY);
const expectedCategory = CATEGORY_LABELS[spec.category];

// 4. Live provider surface. Transport failure is reported separately from a
//    readiness verdict, so a dropped request never reads as a broken agent.
const agentUrl = identityRecord.endpoint;
if (!isPublicHttpUrl(agentUrl)) stop("The Grid Keeper endpoint is not a public HTTPS URL.");
const at = (suffix) => new URL(suffix, `${agentUrl.replace(/\/$/, "")}/`).toString();
async function probeSurface(suffix, attempts = 3) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await requestJson(at(suffix), { timeoutMs: 20_000 });
    if (last.ok && last.body !== undefined && last.body !== null) return { ...last, attempts: attempt };
    if (attempt < attempts) await delay(2_000 * attempt);
  }
  return { ...last, attempts };
}
const [health, readiness, status, metadata] = await Promise.all(["/health", "/readiness", "/status", "/metadata"].map((suffix) => probeSurface(suffix)));
const unreachable = [["health", health], ["readiness", readiness], ["status", status], ["metadata", metadata]].filter(([, response]) => !response.ok || response.body === undefined || response.body === null);
if (unreachable.length) {
  stop("The Grid Keeper public surface did not answer after retries; this is a transport failure, not a readiness verdict. No transaction was attempted.", {
    unreachable: unreachable.map(([name, response]) => ({ surface: name, httpStatus: response.status ?? null, attempts: response.attempts, error: response.error ?? null })),
  });
}
const readinessFailures = publicReadinessFailures({ agentUrl, health, readiness, status, metadata, expectedCategory });
if (readinessFailures.length) stop("Grid Keeper public readiness failed; refusing to fund.", { failures: readinessFailures });
// Grid Keeper is the one reference agent that CAN move capital, so the check
// here is not "capital movement is impossible". It is that this job does not
// use it: no Altana session exists, and the deliverable must say so.
if (status.body?.executionPolicy?.capitalMovement !== true) stop("Grid Keeper should declare capital movement; the live policy disagrees with its spec.", { policy: status.body?.executionPolicy });
if (status.body?.executionModel?.isNativeLimitOrder !== false) stop("The live service claims native limit orders; refusing.");
if (Number(metadata.body?.identity?.agentId) !== Number(identityRecord.agentId)) stop("The live service does not publish the registered identity.", { published: metadata.body?.identity, expected: identityRecord.agentId });

// 5. RPC capability on both sides, the Verified Run #1 lesson.
if (readiness.body?.rpc?.capable !== true) stop("The Grid Keeper watcher cannot serve the verifyJob log range; refusing to fund a job it cannot observe.", { rpc: readiness.body?.rpc });
if (readiness.body?.rpc?.usingSdkDefault === true) stop("Grid Keeper is on the SDK default RPC; refusing to fund.");
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
  baselineSealed: false,
});
const priorRuns = await store.loadRuns();
const agentRecord = deriveAgentRecord(candidate, priorRuns);
const adapter = selectHiringAdapter(candidate, { chainId: REFERENCE_CHAIN_ID });
const hirePreparation = { attemptId: id("hire"), agent: { identity: candidate.identity, name: candidate.name }, protocol: adapter.protocol || "ERC-8183", adapterStatus: adapter.status, adapterReason: adapter.reason || null, readinessConditions: candidate.selectionGate.readiness.conditions, trustBefore: agentRecord.trust.reached, statusBefore: agentRecord.status.label, preparedAt: nowIso() };
if (candidate.identity !== `${REFERENCE_CHAIN_ID}:${String(identityRecord.registry).toLowerCase()}:${identityRecord.agentId}`) stop("Marketplace identity does not resolve to the registered ERC-8004 agent.", { candidate: candidate.identity });
if (adapter.status !== "ready") stop("The marketplace hiring adapter is not ready for Grid Keeper.", { adapter, conditions: candidate.selectionGate.readiness.conditions });

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
  task_description: `Canned paid hire for ${GRID_BENCHMARK_ID} (${definition.version}). Benchmark precommit ${precommit.keccak256}. Run ${runId}. Answer every frozen GridBench scenario: construct the grid, state each level's side, and for each situation say whether the level may execute and why. Read-only judgement; no capital movement and no swap.`,
  terms: { deliverables: "Grid construction plus an allow or refuse decision with a reason for every frozen GridBench v1 scenario", quality_standards: "Deterministic engine decisions bound to the frozen precommit; refusals must carry their reason", success_criteria: ["Deliverable submitted onchain", "No capital movement", "Bound to the frozen GridBench precommit"] },
  request_id: `${runId}-${quoteRequestedAt}`,
};
const quoteResponse = await requestJson(at("/negotiate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: quoteRequest });
const envelope = quoteResponse.body || {};
const quoted = envelope.response || {};
const quoteTerms = quoted.terms || {};
const priceRaw = String(quoteTerms.price ?? "");
const quoteExpiresAt = Number(quoted.quote_expires_at ?? 0);
if (!quoteResponse.ok || quoted.accepted !== true || !envelope.provider_sig || !envelope.negotiation_hash) stop("Grid Keeper did not return an accepted signed quote.", { httpStatus: quoteResponse.status });
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

// 10. The provider task. GridBench carries no hidden answer to leak: the
//     public packet has no expect field, and grading happens elsewhere against
//     ground truth recomputed from the specification. There is no human
//     baseline, so there is no contamination guard to run.
const sourcePacket = publicGridBenchPacket(definition);
const providerTask = { benchmarkId: definition.benchmarkId, precommit: definition.precommit, packet: sourcePacket };
const agentInput = sourcePacket;
const answerKeyLeaked = JSON.stringify(sourcePacket).includes(ANSWER_KEY_FIELD);
if (answerKeyLeaked) stop("The public GridBench packet carries the answer key; refusing to fund.");
const leakageChecks = {
  publicPacketCarriesNoAnswerKey: !answerKeyLeaked,
  scenarioCountMatchesDefinition: sourcePacket.scenarios.length === definition.scenarios.length,
  groundTruthComputedIndependently: definition.policy.groundTruthSource === "recomputed_from_this_specification_not_from_the_agent_engine",
  humanBaselineNotApplicable: true,
};
if (!Object.values(leakageChecks).every(Boolean)) stop("The GridBench provider payload failed its integrity checks.", { leakageChecks });

// 11. Precommit, persisted before any funding.
const deliveryDeadlineSeconds = Math.max(600, Number(quoted.estimated_completion_seconds || 120) * 5);
const nowSeconds = Math.floor(Date.now() / 1000);
const observationDeadlineAtUnixSeconds = nowSeconds + deliveryDeadlineSeconds;
const expiryBufferSeconds = 300;
const deadlineAtUnixSeconds = observationDeadlineAtUnixSeconds + Number(disputeWindow) + expiryBufferSeconds;
const benchmark = {
  id: GRID_BENCHMARK_ID,
  version: definition.version,
  category: CATEGORIES.GRID_TRADING,
  task: "Construct the frozen grid and decide every scenario, with a reason for each refusal.",
  control: { id: GRID_EVALUATOR_VERSION, description: "Recompute the correct answer for every scenario from the frozen specification alone, without running the agent's engine, with no payment and no capital movement.", sameFrozenEvidence: true, inputHash: contentHashes(sourcePacket).keccak256 },
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
  expectedEvidenceSchema: { deliverable: "ERC-8183 submitted manifest with GridBench answers JSON", storage: "IPFS content-addressed", requiredOutputKeys: OUTPUT_FIELDS },
  validityCriteria: ["frozen GridBench v1 precommit intact", "no human baseline exists or is required", `ERC-8004 identity ${identityRecord.agentId} verified onchain`, "fresh provider-signed quote verified", "watcher RPC capability verified", "funded ERC-8183 job", "observed onchain submission", "ground truth recomputed independently of the agent engine", "deliverable must not claim any swap occurred"],
  costAccounting: { agentFee: `${priceRaw} raw ${tokenSymbol}`, networkGas: "sum of actual buyer receipts", control: "zero payment and zero gas" },
});
const precommitRecord = {
  manifest,
  benchmarkPrecommit: precommit,
  venue: "PancakeSwap",
  frozenMarket: definition.market,
  strategy: definition.strategy,
  erc8004: { identity: candidate.identity, agentId: identityRecord.agentId, registry: identityRecord.registry, provider: identityRecord.provider, owner: registryOwner },
  taskHash: contentHashes(providerTask).keccak256,
  agentInputHash: contentHashes(agentInput).keccak256,
  sourcePacketHash: contentHashes(sourcePacket).keccak256,
  snapshotHash: contentHashes(definition.market).keccak256,
  outputSchema: OUTPUT_FIELDS,
  evaluatorVersion: GRID_EVALUATOR_VERSION,
  policyVersion: definition.version,
  executionModel: GRID_EXECUTION_MODEL.id,
  humanBaselineReference: null,
  humanBaselineNote: "GridBench is a deterministic capability benchmark with no human baseline. This run is not a TermiX pair and adds no Agent Advantage pair.",
  quote: { priceRaw, currency: quoteTerms.currency, quoteExpiresAt, negotiationHash: envelope.negotiation_hash, signatureVerified: true, signer: signature.signer },
  hirePreparation,
  leakageChecks,
  leakageBoundary: { rule: "No human answer exists for GridBench, so there is nothing to withhold. The public packet omits the answer key and grading recomputes ground truth from the specification." },
  rpcCapability: { provider: readiness.body.rpc, buyer: { capable: buyerRpcCapability.capable, configuredVia: buyerRpcEnvironment.perNetworkKey } },
  deadlineAtUnixSeconds,
  runId,
  createdAt: nowIso(),
};
const precommitEvidence = await store.saveEvidence({ kind: "gridbench_agent_run_precommit", ...precommitRecord });
await store.saveJson(`state/precommit-${runId}.json`, { ...precommitRecord, evidence: precommitEvidence });
log({ status: "precommitted", runId, hireAttemptId: hirePreparation.attemptId, manifestHash: manifest.manifestHash, precommitEvidence: precommitEvidence.sha256, priceRaw, provider: identityRecord.provider, identity: candidate.identity, benchmarkPrecommit: precommit.sha256, scenarios: definition.scenarios.length });

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
    deliverableEvidence = await store.saveEvidence({ kind: "grid_keeper_deliverable_raw", runId, jobId, reference: deliverableRef, cid: resolved.cid, contentAddressed: resolved.contentAddressed, retrievedFrom: resolved.url, httpStatus: fetched.status, body: fetched.body, rawText: fetched.rawText });
    deliverableValidation = validateSubmittedDeliverable({ body: fetched.body, jobId, onchainDeliverable: latest.deliverable, expectedOutputFields: OUTPUT_FIELDS });
    agentOutput = extractProviderDeliverable(fetched.body).output;
    // The deliverable has to be bound to the exact frozen benchmark, answer
    // every scenario, and state plainly that nothing was traded. A grid
    // agent's deliverable is the easiest place in this project to imply a
    // fill that never happened, so that is checked rather than assumed.
    const boundToBenchmark = String(agentOutput?.benchmarkId ?? "") === String(definition.benchmarkId);
    const boundToPrecommit = String(agentOutput?.benchmarkPrecommit?.sha256 ?? "") === String(definition.precommit.sha256);
    const answeredEveryScenario = definition.scenarios.every((scenario) => agentOutput?.answers?.[scenario.id] !== undefined);
    const levelsStrictlyIncreasing = Array.isArray(agentOutput?.levels)
      && agentOutput.levels.length > 1
      && agentOutput.levels.every((level, index) => index === 0 || BigInt(level.priceMinor) > BigInt(agentOutput.levels[index - 1].priceMinor));
    const claimsNoSwap = agentOutput?.execution?.capitalMoved === false
      && Number(agentOutput?.execution?.onchainSwapsPerformed) === 0
      && agentOutput?.execution?.altanaSessionUsed === false;
    const notNativeOrder = agentOutput?.executionModel?.isNativeLimitOrder === false;
    const noFabricatedOrderId = !/"order(Id|_id)"/i.test(JSON.stringify(agentOutput ?? {}));

    if (!boundToBenchmark) deliverableValidation.errors.push("deliverable_benchmark_id_mismatch");
    if (!boundToPrecommit) deliverableValidation.errors.push("deliverable_precommit_mismatch");
    if (!answeredEveryScenario) deliverableValidation.errors.push("deliverable_missing_scenario_answers");
    if (!levelsStrictlyIncreasing) deliverableValidation.errors.push("deliverable_levels_not_strictly_increasing");
    if (!claimsNoSwap) deliverableValidation.errors.push("deliverable_claims_capital_movement");
    if (!notNativeOrder) deliverableValidation.errors.push("deliverable_claims_native_limit_order");
    if (!noFabricatedOrderId) deliverableValidation.errors.push("deliverable_contains_an_order_id");
    deliverableValidation.valid = deliverableValidation.errors.length === 0;
    deliverableValidation.hasActualDeliverable = deliverableValidation.valid && Boolean(deliverableValidation.manifestHash);
    Object.assign(deliverableValidation, { boundToBenchmark, boundToPrecommit, answeredEveryScenario, levelsStrictlyIncreasing, claimsNoSwap, notNativeOrder, noFabricatedOrderId, contentAddressed: resolved.contentAddressed });
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
// The control is the correct answer recomputed from the frozen specification
// alone. It never calls the agent's engine, which is what makes agreement
// between them evidence rather than a tautology.
const control = computeGridGroundTruth(definition);
const controlOutput = {
  answers: control.answers,
  hashes: control.hashes,
  provenance: { independent: true, method: "ground_truth_recomputed_from_frozen_specification", callsAgentEngine: false, evaluatorVersion: control.evaluatorVersion },
  status: "completed",
  elapsedMs: Date.now() - controlStart,
  cost: { paymentTokenRaw: "0", nativeGasWei: "0" },
  dataLimitations: ["Deterministic recomputation from the frozen specification. It moves no capital and pays no fee.", "GridBench has no human baseline, so this control is not one."],
};
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
await store.saveJson(`state/gridbench-run-${runId}.json`, {
  kind: "gridbench_agent_run",
  runId, jobId,
  hireAttemptId: hirePreparation.attemptId,
  benchmarkId: GRID_BENCHMARK_ID,
  venue: "PancakeSwap",
  frozenMarketBlock: definition.market.blockNumber,
  executionModel: GRID_EXECUTION_MODEL.id,
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
log({ status: "complete", runId, jobId, chainState: latest?.status || "UNKNOWN", terminalState: run.terminalState, qualification: run.qualification, deliverableValid: deliverableValidation?.valid ?? false, cid: deliverableCid, serviceFeeRaw: priceRaw, buyerGasWei: buyerGasWei.toString(), allowanceAfterRaw: allowanceAfter.toString(), next: "npm run grid:grade" });
