import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatEther, formatUnits, createPublicClient, http } from "viem";
import { BENCHMARKS } from "../src/benchmark/definitions.mjs";
import { createPrecommitManifest, runBenchmark } from "../src/benchmark/framework.mjs";
import { classifyCategories, Eight004ScanAdapter, extractServices } from "../src/discovery/8004scan.mjs";
import { buildCandidateMatrix, buildProviderHistory, buildReadinessChecklist, deriveDeadlinePlan, detectSystemicFailure, rankCandidateMatrix, summarizeProviderHistory } from "../src/discovery/readiness.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";
import { id, isPublicHttpUrl, nowIso, requestJson, safeError } from "../src/core.mjs";
import { extractProviderDeliverable, validateSubmittedDeliverable } from "../src/benchmark/validation.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { appendProtocolEvent, createFundedJob, loadSdk, preflightGuards, readJob, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { negotiateA2A, notifyFundedA2A } from "../src/protocol/a2a.mjs";

const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(root, "data"));
const store = await new FileStore(dataDir).init();
const sdk = await loadSdk();
let readWallet = null;

function stop(message, details = {}) {
  console.log(JSON.stringify({ status: "blocked", reason: message, ...details }, null, 2));
  readWallet?.destroy();
  process.exit(2);
}

const inventory = await store.loadJson("inventory/verified-candidates.json", null);
if (!inventory?.candidates?.length) stop("Verified candidate inventory is missing; run npm run inventory first.");
const priorRuns = await store.loadRuns();
const providerHistory = buildProviderHistory(priorRuns);
const systemicGuard = detectSystemicFailure(priorRuns);
if (systemicGuard.triggered) stop("Systemic ERC-8183 failure guard is active; two independent providers failed after accepted notification without submission. Investigate the integration before spending again.", { systemicGuard });

const readClient = await (async () => {
  if (!process.env.CANNED_EXECUTION_WALLET_PASSWORD || !process.env.CANNED_EXECUTION_WALLET_ADDRESS) stop("Canned execution wallet is not configured; no funding attempted.");
  readWallet = new sdk.EVMWalletProvider({ password: process.env.CANNED_EXECUTION_WALLET_PASSWORD, address: process.env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: process.env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });
  return sdk.ERC8183Client.create({ network: "bsc-testnet", walletProvider: readWallet });
})();
const network = readClient.network;
const chain = { id: network.chainId, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [network.rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl, { timeout: 12_000 }) });
const [rpcChainId, nativeBalance, gasPriceWei, tokenAddress, tokenDecimals, tokenSymbol, tokenBalance, allowance, disputeWindow] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: readWallet.address }),
  publicClient.getGasPrice(),
  readClient.paymentToken(),
  readClient.tokenDecimals(),
  readClient.tokenSymbol(),
  readClient.tokenBalance(readWallet.address),
  readClient.tokenAllowance(readWallet.address, readClient.commerce.address),
  readClient.policy.disputeWindow(),
]);
const candidateAdapter = new Eight004ScanAdapter();
const observations = {};
const freshCandidates = [];
for (const candidate of inventory.candidates.filter((item) => item.selectionGate?.genuinelyCallable || item.probes?.some((probe) => probe.callable))) {
  const detailResponse = await candidateAdapter.detail(97, candidate.tokenId);
  const detail = detailResponse.body;
  const services = detail ? extractServices(detail) : [];
  const a2aServices = services.filter((service) => /a2a/i.test(service.type)).slice(0, 3);
  const probes = [];
  for (const service of a2aServices) probes.push(await candidateAdapter.probeService(service));
  const a2a = probes.find((probe) => probe.reachable && probe.callable && probe.card);
  const provider = detail?.agent_wallet || detail?.owner_address || null;
  const freshCandidate = detail ? { ...candidate, identity: detail.agent_id, name: detail.name, description: detail.description, agentWallet: provider, ownerAddress: detail.owner_address, chainId: detail.chain_id, network: detail.is_testnet === true ? "bsc-testnet" : "unknown", services, probes, categoryHypotheses: classifyCategories(detail) } : candidate;
  let quoteProbe = null;
  let quoteVerification = null;
  if (a2a) {
    const category = freshCandidate.categoryHypotheses?.[0]?.category || CATEGORIES.REBALANCING;
    quoteProbe = await negotiateA2A({ endpoint: a2a.endpoint, card: a2a.card, taskDescription: `Canned fresh readiness quote probe for ${freshCandidate.name}. Return a signed quote only; do not execute an onchain action.`, deliverables: `signed quote only for ${category}`, qualityStandards: "no execution" });
    const quoteData = quoteProbe.rawResponse?.result?.parts?.find((part) => part.kind === "data")?.data || null;
    if (quoteData && provider) {
      try {
        const sdkErc8183 = await import("@bnbagent/sdk/erc8183");
        quoteVerification = await sdkErc8183.verifyQuoteSignature({ envelope: quoteData, provider, publicClient, expectedVerifyingContract: readClient.commerce.address });
      } catch (error) {
        quoteVerification = { valid: false, reason: safeError(error) };
      }
    } else quoteVerification = { valid: false, reason: "quote data or provider address unavailable" };
  }
  const category = freshCandidate.categoryHypotheses?.[0]?.category || null;
  const readiness = buildReadinessChecklist({ candidate: freshCandidate, probe: a2a, quoteProbe, quoteVerification, chainId: rpcChainId, expectedCategory: category });
  observations[freshCandidate.identity] = { probe: a2a || null, quoteProbe, quoteVerification, readiness };
  freshCandidates.push(freshCandidate);
}

const matrix = rankCandidateMatrix(buildCandidateMatrix({ candidates: freshCandidates, observations, providerHistory, runs: priorRuns, nowSeconds: Math.floor(Date.now() / 1000) }));
const selected = matrix.find((candidate) => candidate.eligible) || null;
const preflightBase = {
  schemaVersion: 2,
  kind: "canned_paid_run_preflight",
  observedAt: nowIso(),
  network: { name: network.name, chainId: rpcChainId, rpcUrl: network.rpcUrl },
  balances: { walletAddress: readWallet.address, tBNBBalanceWei: nativeBalance.toString(), paymentToken: tokenAddress, paymentTokenSymbol: tokenSymbol, paymentTokenDecimals: tokenDecimals, paymentTokenBalanceRaw: tokenBalance.toString(), allowanceToCommerceRaw: allowance.toString(), gasPriceWei: gasPriceWei.toString(), planningGasUnits: "500000", planningGasWei: (gasPriceWei * 500_000n).toString(), disputeWindowSeconds: disputeWindow.toString() },
  providerHistory: summarizeProviderHistory(providerHistory),
  systemicGuard,
  candidateMatrix: matrix,
  selectedCandidate: selected,
};
if (!selected) {
  await store.saveJson("state/paid-run-preflight.json", { ...preflightBase, guard: { ok: false, errors: ["no_fresh_candidate_passed_readiness_gate"] } });
  stop("No remaining candidate passed the fresh readiness gate; no transaction was attempted.", { chainId: rpcChainId, tBNBBalance: formatEther(nativeBalance), paymentToken: tokenAddress, paymentTokenBalance: formatUnits(tokenBalance, tokenDecimals), candidateMatrix: matrix.map((candidate) => ({ identity: candidate.identity, name: candidate.name, category: candidate.category, rank: candidate.rank, eligible: candidate.eligible, readinessScore: candidate.readinessScore, liveness: candidate.liveness.status, cooldownActive: candidate.cooldown.active })) });
}

const observation = observations[selected.identity];
const quoteProbe = observation.quoteProbe;
const quoteVerification = observation.quoteVerification;
const quoteTerms = quoteProbe.quote?.terms || quoteProbe.quote || null;
const quoteData = quoteProbe.rawResponse?.result?.parts?.find((part) => part.kind === "data")?.data || {};
const quoteExpiresAt = Number(quoteProbe.quote?.quote_expires_at || quoteTerms?.quote_expires_at || 0);
const budget = BigInt(quoteTerms.price);
const estimatedGasWei = gasPriceWei * 500_000n;
const safety = writeSafety(process.env);
const guard = preflightGuards({ chainId: rpcChainId, provider: selected.provider, expectedProvider: selected.provider, tokenAddress, quoteCurrency: quoteTerms.currency, quoteAccepted: quoteProbe.accepted === true, quoteSignaturePresent: Boolean(quoteProbe.providerSignature), quoteExpiresAt, tokenBalance, requiredBudget: budget, nativeBalance, estimatedGasWei });
if (Number(quoteData.chain_id) !== 97) guard.errors.push("quote_chain_or_commerce_mismatch");
if (String(quoteData.verifying_contract || "").toLowerCase() !== readClient.commerce.address.toLowerCase()) guard.errors.push("quote_chain_or_commerce_mismatch");
if (selected.readiness.ready !== true) guard.errors.push("candidate_readiness_gate_failed");
if (safety.network !== "bsc-testnet" || rpcChainId !== 97 || network.chainId !== 97) guard.errors.push("testnet_chain_guard_failed");
guard.ok = guard.errors.length === 0 && quoteVerification?.valid === true;
const preflightEvidence = await store.saveEvidence({ source: "fresh_8004scan_a2a_sdk", observedAt: nowIso(), selected, quote: quoteData, quoteVerification, guard });
await store.saveJson("state/paid-run-preflight.json", { ...preflightBase, selectedCandidate: selected, quote: { accepted: quoteProbe.accepted === true, priceRaw: quoteTerms.price, currency: quoteTerms.currency, quoteExpiresAt, estimatedCompletionSeconds: quoteProbe.quote?.estimated_completion_seconds || null, negotiationHash: quoteProbe.negotiationHash, providerSignaturePresent: Boolean(quoteProbe.providerSignature), verification: quoteVerification, chainId: quoteData.chain_id || null, verifyingContract: quoteData.verifying_contract || null }, guard, rawEvidence: preflightEvidence });
if (!guard.ok) stop("Preflight security, chain, quote, readiness, or funding gate failed; no transaction was attempted.", { errors: guard.errors, chainId: rpcChainId, paymentToken: tokenAddress, paymentTokenBalance: tokenBalance.toString(), requiredBudget: budget.toString(), tBNBBalance: nativeBalance.toString(), estimatedGasWei: estimatedGasWei.toString(), selectedCandidate: { identity: selected.identity, name: selected.name, readinessScore: selected.readinessScore } });
if (process.env.CANNED_ALLOW_TESTNET_WRITES !== "true") stop("CANNED_ALLOW_TESTNET_WRITES is not true; preflight is complete and no transaction was attempted.", { selectedCandidate: selected.identity, requiredBudget: quoteTerms.price, paymentToken: tokenAddress });

const category = selected.category;
const benchmarkBase = BENCHMARKS[category];
const taskDescription = {
  [CATEGORIES.REBALANCING]: "For the declared BSC testnet PancakeSwap V3 range position, return a JSON-only rebalancing recommendation and the benchmark metrics requested in expectedOutputFields. Do not send transactions or move capital. State data limitations explicitly.",
  [CATEGORIES.GRID_TRADING]: "For the declared BSC testnet PancakeSwap V3 grid, return a JSON-only grid decision with filled rungs, total rungs, spread capture, execution cost, and data limitations. Do not send transactions or move capital.",
  [CATEGORIES.YIELD_OPTIMISATION]: "For the declared stablecoin yield route, return a JSON-only route decision with realized yield, execution cost, and data limitations. Do not move capital.",
  [CATEGORIES.HEALTH_FACTOR_MONITORING]: "For the declared lending health-factor scenario, return a JSON-only monitoring decision with alert timing, false alerts, missed thresholds, execution cost, and data limitations. Do not send transactions or move capital.",
}[category];
const benchmark = { ...benchmarkBase, task: taskDescription, control: { ...benchmarkBase.control, procedure: `Independently execute the ${category} baseline for the same declared input and observation window without agent intervention; preserve any missing-data limitation.` } };
const input = {
  mode: "analysis_only_declared_task",
  network: "bsc-testnet",
  chainId: 97,
  category,
  startingCapitalUsdCents: 10_000,
  observationWindowSeconds: 300,
  expectedOutputFields: benchmark.expectedOutputFields,
  maxSlippageBps: 50,
  maxPriceImpactBps: 50,
  taskState: category === CATEGORIES.GRID_TRADING ? { poolReference: "declared-pancakeswap-v3-grid", rungs: [-600, -300, 0, 300, 600], inventoryLimitBps: 2500 } : category === CATEGORIES.YIELD_OPTIMISATION ? { baselineVenue: "declared-stablecoin-baseline", candidateVenues: ["declared-venus-market"] } : category === CATEGORIES.HEALTH_FACTOR_MONITORING ? { protocol: "declared-lending-market", threshold: 1.25, alertWindowSeconds: 60 } : { poolReference: "declared-stablecoin-range-position", tokenPair: "stablecoin/stablecoin", feeTierBps: 5, currentTick: 0, lowerTick: -600, upperTick: 600 },
  expectedOutputSchema: Object.fromEntries(benchmark.expectedOutputFields.map((field) => [field, "number"])),
  validity: "This is a bounded paid analysis execution over declared state; no agent transaction or capital movement is authorized.",
};
const deadlinePlan = deriveDeadlinePlan({ estimatedCompletionSeconds: selected.quote.estimatedCompletionSeconds, observationWindowSeconds: input.observationWindowSeconds, disputeWindowSeconds: Number(disputeWindow) });
input.providerDeliveryDeadlineSeconds = deadlinePlan.providerDeliveryDeadlineSeconds;
input.deadlineAtUnixSeconds = deadlinePlan.providerDeliveryDeadlineAtUnixSeconds;
const runId = id("run");
const manifest = createPrecommitManifest({ runId, agent: { ...freshCandidates.find((candidate) => candidate.identity === selected.identity), services: observation.probe ? [observation.probe] : [] }, benchmark, input, limits: { maxBudgetRaw: quoteTerms.price, maxSlippageBps: input.maxSlippageBps, maxPriceImpactBps: input.maxPriceImpactBps, noTransactionByAgent: true }, startAt: nowIso(), deadlineAtUnixSeconds: deadlinePlan.providerDeliveryDeadlineAtUnixSeconds, deadlinePlan, runType: RUN_TYPES.BENCHMARK, provenanceMode: "LIVE_QUALIFYING", providerIdentity: selected.identity, providerAddress: selected.provider, quoteTerms: { ...quoteTerms, negotiationHash: quoteProbe.negotiationHash, providerSignature: quoteProbe.providerSignature, quoteExpiresAt }, expectedEvidenceSchema: input.expectedOutputSchema, validityCriteria: ["fresh identity/provider match", "fresh signed quote verified by official SDK", "fresh readiness checklist passed", "funded ERC-8183 job", "independent control", "deterministic evaluator result"], costAccounting: { agentFee: `${quoteTerms.price} raw ${tokenSymbol}`, networkGas: "sum of actual ERC-8183 receipts", control: "zero payment and zero chain gas for analysis-only control" } });
const precommitEvidenceRecord = await store.saveEvidence(manifest);
await store.saveJson(`state/precommit-${runId}.json`, { manifest, evidence: precommitEvidenceRecord, createdAt: nowIso() });
console.log(JSON.stringify({ status: "precommitted", runId, manifestHash: manifest.manifestHash, provider: selected.provider, candidate: selected.identity, category, budget: quoteTerms.price, paymentToken: tokenAddress, deliveryDeadlineSeconds: deadlinePlan.providerDeliveryDeadlineSeconds, observationWindowSeconds: input.observationWindowSeconds }, null, 2));

const funded = await createFundedJob({ agent: { ...freshCandidates.find((candidate) => candidate.identity === selected.identity), agentWallet: selected.provider, ownerAddress: selected.provider, services: observation.probe ? [observation.probe] : [] }, precommit: manifest, quote: quoteProbe, store, env: process.env });
if (!funded.ok) stop("ERC-8183 buyer lifecycle did not reach funded state.", { runId, error: funded.error || null, state: funded.record?.state || null });
const jobId = funded.record.jobId;
console.log(JSON.stringify({ status: "funded", runId, jobId }, null, 2));
const notify = await notifyFundedA2A({ endpoint: observation.probe.endpoint, card: observation.probe.card, jobId });
const notifyEvidence = await store.saveEvidence({ kind: "a2a_notify_funded", runId, jobId, response: notify.response, rawResponse: notify.rawResponse });
const notifyAccepted = notify.ok && /accepted/i.test(JSON.stringify(notify.response || {}));
await appendProtocolEvent({ store, runId, event: "notify_funded", extra: { accepted: notifyAccepted, evidence: notifyEvidence, response: notify.response, error: notify.error || null } });

async function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function observeUntilTerminal() {
  let previous = null;
  let latest = null;
  while (Date.now() < deadlinePlan.providerDeliveryDeadlineAtUnixSeconds * 1000) {
    try {
      latest = await readJob({ client: funded.client, jobId });
      if (latest.status !== previous) {
        previous = latest.status;
        await appendProtocolEvent({ store, runId, event: "chain_state_observed", extra: { snapshot: latest } });
        console.log(JSON.stringify({ status: "chain_state", runId, jobId, chainState: latest.status }, null, 2));
      }
      if (["SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"].includes(latest.status)) return { latest, timedOut: false };
    } catch (error) {
      await appendProtocolEvent({ store, runId, event: "chain_read_error", extra: { error: safeError(error) } });
    }
    await delay(15_000);
  }
  return { latest, timedOut: true };
}

const observed = await observeUntilTerminal();
let latest = observed.latest;
let agentOutput = {};
let agentDeliverableValidation = null;
let agentExecution = { status: observed.timedOut ? "timeout" : "pending", elapsedMs: null, cost: { feeRaw: quoteTerms.price, paymentToken: tokenSymbol }, evidence: null };
if (latest && ["SUBMITTED", "COMPLETED"].includes(latest.status)) {
  const deliverableUrl = await funded.client.getDeliverableUrl(BigInt(jobId));
  if (deliverableUrl && isPublicHttpUrl(deliverableUrl)) {
    const deliverable = await requestJson(deliverableUrl, { timeoutMs: 20_000 });
    const deliverableEvidence = await store.saveEvidence({ kind: "provider_deliverable_raw", runId, jobId, url: deliverableUrl, status: deliverable.status, body: deliverable.body, rawText: deliverable.rawText });
    agentDeliverableValidation = validateSubmittedDeliverable({ body: deliverable.body, jobId, onchainDeliverable: latest.deliverable, expectedOutputFields: benchmark.expectedOutputFields });
    agentOutput = extractProviderDeliverable(deliverable.body).output;
    agentExecution = { status: deliverable.ok && agentDeliverableValidation.valid ? "completed" : "error", elapsedMs: deliverable.elapsedMs, cost: { feeRaw: quoteTerms.price, paymentToken: tokenSymbol }, deliverableUrl, evidence: deliverableEvidence, deliverableValidation: { ...agentDeliverableValidation, output: undefined } };
    await appendProtocolEvent({ store, runId, event: "deliverable_observed", extra: { deliverableUrl, evidence: deliverableEvidence, httpStatus: deliverable.status, validation: { ...agentDeliverableValidation, output: undefined } } });
  } else {
    agentExecution = { status: "error", elapsedMs: null, cost: { feeRaw: quoteTerms.price, paymentToken: tokenSymbol }, error: "Submitted job did not expose a public deliverable URL." };
  }
}

const controlStart = Date.now();
const controlOutput = { provenance: { independent: true, procedure: benchmark.control.procedure }, status: "completed", observationWindowSeconds: input.observationWindowSeconds, elapsedMs: Date.now() - controlStart, cost: { paymentTokenRaw: "0", nativeGasWei: "0" }, dataLimitations: ["Analysis-only control performs no capital movement.", "No numeric performance values are fabricated when the declared state does not support them."] };
if (latest?.status === "FUNDED" && Number(latest.expiredAt) <= Math.floor(Date.now() / 1000)) {
  try {
    const refunded = await funded.client.claimRefund(BigInt(jobId));
    latest = await readJob({ client: funded.client, jobId });
    await appendProtocolEvent({ store, runId, event: "claim_refund", extra: { tx: { transactionHash: refunded.transactionHash || null, status: refunded.status ?? null }, snapshot: latest, refundedBudget: String(funded.record.budget) } });
    if (latest.status === "EXPIRED") {
      try {
        const reconciled = await funded.client.markExpired(BigInt(jobId));
        await appendProtocolEvent({ store, runId, event: "mark_expired", extra: { tx: { transactionHash: reconciled.transactionHash || null, status: reconciled.status ?? null }, snapshot: latest } });
      } catch (error) {
        await appendProtocolEvent({ store, runId, event: "mark_expired_error", extra: { error: safeError(error), snapshot: latest } });
      }
    }
  } catch (error) {
    await appendProtocolEvent({ store, runId, event: "claim_refund_error", extra: { error: safeError(error), snapshot: latest } });
  }
}
if (latest?.status === "SUBMITTED") {
  const submittedAt = Number(latest.submittedAt);
  const settleAt = (Number.isFinite(submittedAt) && submittedAt > 0 ? submittedAt : Math.floor(Date.now() / 1000)) + Number(disputeWindow);
  while (Date.now() < settleAt * 1000) await delay(15_000);
  try {
    const settled = await funded.client.settle(BigInt(jobId));
    await appendProtocolEvent({ store, runId, event: "settle_job", extra: { tx: { transactionHash: settled.transactionHash || null, status: settled.status ?? null } } });
    latest = await readJob({ client: funded.client, jobId });
    await appendProtocolEvent({ store, runId, event: "chain_state_observed", extra: { snapshot: latest } });
  } catch (error) {
    await appendProtocolEvent({ store, runId, event: "settle_error", extra: { error: safeError(error) } });
  }
}
const protocolJob = await store.loadJson(`state/protocol-job-${runId}.json`, funded.record);
const executionStatus = observed.timedOut ? "timeout" : latest?.status === "REJECTED" ? "rejected" : latest?.status === "EXPIRED" ? "expired" : latest?.status === "COMPLETED" ? "completed" : agentExecution.status === "error" ? "error" : undefined;
const run = await runBenchmark({ agent: { ...freshCandidates.find((candidate) => candidate.identity === selected.identity), identity: selected.identity, name: selected.name }, benchmark, input, agentOutput, agentDeliverableValidation, controlOutput, store, runType: RUN_TYPES.BENCHMARK, provenanceMode: "LIVE_QUALIFYING", precommit: manifest, precommitEvidence: precommitEvidenceRecord, protocolJob, executionStatus, agentExecution, controlExecution: { status: "completed", elapsedMs: controlOutput.elapsedMs, cost: controlOutput.cost, methodology: controlOutput.provenance }, termixEligiblePair: false, termixReason: "A single bounded analysis run does not establish the three-run TermiX Agent Advantage pair.", deadlinePlan });
await store.saveJson("state/provider-history.json", { schemaVersion: 1, kind: "canned_provider_history", observedAt: nowIso(), providers: summarizeProviderHistory(buildProviderHistory(await store.loadRuns())) });
console.log(JSON.stringify({ status: "complete", runId, jobId, chainState: latest?.status || "UNKNOWN", terminalState: run.terminalState, evaluation: run.evaluation, qualification: run.qualification, manifestHash: run.manifest.hash, agentArtifact: run.artifacts.agentOutput, controlArtifact: run.artifacts.controlOutput }, null, 2));
