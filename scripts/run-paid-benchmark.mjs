import { readFile } from "node:fs/promises";
import path from "node:path";
import { BENCHMARKS } from "../src/benchmark/definitions.mjs";
import { createPrecommitManifest, runBenchmark } from "../src/benchmark/framework.mjs";
import { classifyCategories, Eight004ScanAdapter, extractServices } from "../src/discovery/8004scan.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";
import { id, isPublicHttpUrl, nowIso, requestJson, safeError } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { appendProtocolEvent, createFundedJob, loadSdk, preflightGuards, readJob } from "../src/protocol/erc8183-buyer.mjs";
import { negotiateA2A, notifyFundedA2A } from "../src/protocol/a2a.mjs";

const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(root, "data"));
const store = await new FileStore(dataDir).init();
const sdk = await loadSdk();
const targetTokenId = "1923";
const identityPrefix = `97:`;
const taskDescription = "For the declared BSC testnet PancakeSwap V3 range position in taskInput, return a JSON-only rebalancing recommendation. Do not send transactions or move capital. Include recommendation, target lower and upper ticks, rationale, confidence, and explicit data limitations.";
const benchmark = { ...BENCHMARKS[CATEGORIES.REBALANCING], task: taskDescription, control: { ...BENCHMARKS[CATEGORIES.REBALANCING].control, procedure: "Independently hold the declared starting range unchanged for the same stated observation window; take no active rebalancing intervention." } };
const input = {
  mode: "analysis_only_declared_position",
  network: "bsc-testnet",
  chainId: 97,
  protocol: "PancakeSwap V3",
  position: { poolReference: "declared-stablecoin-range-position", tokenPair: "stablecoin/stablecoin", feeTierBps: 5, currentTick: 0, lowerTick: -600, upperTick: 600 },
  startingCapitalUsdCents: 10_000,
  observationWindowSeconds: 300,
  maxPriceImpactBps: 50,
  maxSlippageBps: 50,
  expectedOutputSchema: { recommendation: "hold|rebalance", targetLowerTick: "integer", targetUpperTick: "integer", rationale: "string", confidence: "number 0..1", dataLimitations: "string[]" },
  validity: "This is a paid analysis execution over a declared state, not an onchain position-management or profitability sample.",
};
const deadlineAtUnixSeconds = Math.floor(Date.now() / 1000) + 3_600;

function fail(message, details = {}) {
  console.log(JSON.stringify({ status: "blocked", reason: message, ...details }, null, 2));
  process.exitCode = 2;
}

const inventory = await store.loadJson("inventory/verified-candidates.json", null);
const prior = inventory?.candidates?.find((candidate) => candidate.tokenId === targetTokenId);
if (!prior) { fail("Selected candidate identity 1923 is missing from the verified inventory artifact."); process.exit(); }

const adapter = new Eight004ScanAdapter();
const detailResponse = await adapter.detail(97, targetTokenId);
if (!detailResponse.ok || !detailResponse.body) { fail("Fresh 8004scan identity resolution failed.", { error: detailResponse.error || `HTTP ${detailResponse.status}` }); process.exit(); }
const detail = detailResponse.body;
const services = extractServices(detail);
const probes = [];
for (const service of services.filter((service) => /a2a/i.test(service.type)).slice(0, 3)) probes.push(await adapter.probeService(service));
const categoryHypotheses = classifyCategories(detail);
const provider = detail.agent_wallet || detail.owner_address || null;
const identity = detail.agent_id;
if (identity !== prior.identity || !identity?.startsWith(identityPrefix) || detail.chain_id !== 97 || detail.is_testnet !== true) { fail("Fresh identity or network mismatch; no funding attempted.", { expectedIdentity: prior.identity, actualIdentity: identity, chainId: detail.chain_id, isTestnet: detail.is_testnet }); process.exit(); }
if (!provider || provider.toLowerCase() !== String(prior.agentWallet || prior.ownerAddress).toLowerCase()) { fail("Fresh provider address does not match the verified inventory; no funding attempted.", { expectedProvider: prior.agentWallet || prior.ownerAddress, actualProvider: provider }); process.exit(); }
const a2a = probes.find((probe) => probe.reachable && probe.callable && probe.card);
if (!a2a || !isPublicHttpUrl(a2a.endpoint)) { fail("Fresh A2A liveness/callability check failed; no funding attempted."); process.exit(); }

const agent = { ...prior, identity, name: detail.name, description: detail.description, agentWallet: provider, ownerAddress: detail.owner_address, services, probes, categoryHypotheses };
const sdkErc8183 = await import("@bnbagent/sdk/erc8183");
const readWallet = new sdk.EVMWalletProvider({ password: process.env.CANNED_EXECUTION_WALLET_PASSWORD, address: process.env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: path.resolve(process.env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets")), persist: true });
const readClient = await sdk.ERC8183Client.create({ network: "bsc-testnet", walletProvider: readWallet });
const quoteProbe = await negotiateA2A({ endpoint: a2a.endpoint, card: a2a.card, taskDescription, deliverables: "JSON recommendation plus data limitations; no transaction", qualityStandards: "schema-conforming, bounded, analysis-only" });
const quoteTerms = quoteProbe.quote?.terms || quoteProbe.quote || null;
const quoteExpiresAt = Number(quoteProbe.quote?.quote_expires_at || quoteTerms?.quote_expires_at || 0);
if (!quoteProbe.accepted || !quoteTerms?.price || !quoteTerms.currency || !quoteProbe.providerSignature || (quoteExpiresAt && Math.floor(Date.now() / 1000) >= quoteExpiresAt)) { readWallet.destroy(); fail("Fresh quote was not accepted, signed, complete, or unexpired; no funding attempted.", { accepted: quoteProbe.accepted === true, providerSignaturePresent: Boolean(quoteProbe.providerSignature), quoteExpiresAt: quoteExpiresAt || null }); process.exit(); }
const [rpcChainId, tokenAddress, tokenDecimals, tokenSymbol, tokenBalance, nativeBalance, gasPriceWei, allowance, disputeWindow] = await Promise.all([
  readClient.publicClient.getChainId(),
  readClient.paymentToken(),
  readClient.tokenDecimals(),
  readClient.tokenSymbol(),
  readClient.tokenBalance(readWallet.address),
  readClient.publicClient.getBalance({ address: readWallet.address }),
  readClient.publicClient.getGasPrice(),
  readClient.tokenAllowance(readWallet.address, readClient.commerce.address),
  readClient.policy.disputeWindow(),
]);
const budget = BigInt(quoteTerms.price);
const estimatedGasWei = gasPriceWei * 500_000n;
const quoteData = quoteProbe.rawResponse?.result?.parts?.find((part) => part.kind === "data")?.data || {};
let quoteVerification;
try {
  quoteVerification = await sdkErc8183.verifyQuoteSignature({ envelope: quoteData, provider, publicClient: readClient.publicClient, expectedVerifyingContract: readClient.commerce.address });
} catch (error) {
  quoteVerification = { valid: false, reason: safeError(error) };
}
const guard = preflightGuards({ chainId: rpcChainId, provider, expectedProvider: prior.agentWallet || prior.ownerAddress, tokenAddress, quoteCurrency: quoteTerms.currency, quoteAccepted: quoteProbe.accepted === true, quoteSignaturePresent: Boolean(quoteProbe.providerSignature), quoteExpiresAt, tokenBalance, requiredBudget: budget, nativeBalance, estimatedGasWei });
if (Number(quoteData.chain_id) !== 97 || String(quoteData.verifying_contract || "").toLowerCase() !== readClient.commerce.address.toLowerCase()) guard.errors.push("quote_chain_or_commerce_mismatch");
guard.ok = guard.errors.length === 0;
const preflightEvidence = await store.saveEvidence({ source: "8004scan_and_a2a", observedAt: nowIso(), detail, services, probes, quote: quoteData, quoteVerification, guard });
await store.saveJson("state/paid-run-preflight.json", {
  schemaVersion: 1,
  kind: "canned_paid_run_preflight",
  observedAt: nowIso(),
  agent: { identity, tokenId: targetTokenId, name: detail.name, provider, endpoint: a2a.endpoint, liveness: { status: a2a.status, reachable: a2a.reachable, callable: a2a.callable, elapsedMs: a2a.elapsedMs }, categoryHypotheses },
  network: { name: readClient.network.name, chainId: rpcChainId, rpcUrl: readClient.network.rpcUrl },
  quote: { accepted: quoteProbe.accepted === true, priceRaw: quoteTerms.price, currency: quoteTerms.currency, quoteExpiresAt: quoteExpiresAt || null, estimatedCompletionSeconds: quoteProbe.quote?.estimated_completion_seconds || null, negotiationHash: quoteProbe.negotiationHash, providerSignaturePresent: Boolean(quoteProbe.providerSignature), verification: quoteVerification, chainId: quoteData.chain_id || null, verifyingContract: quoteData.verifying_contract || null },
  balances: { walletAddress: readWallet.address, tBNBBalanceWei: nativeBalance.toString(), paymentToken: tokenAddress, paymentTokenSymbol: tokenSymbol, paymentTokenDecimals: tokenDecimals, paymentTokenBalanceRaw: tokenBalance.toString(), allowanceToCommerceRaw: allowance.toString(), requiredBudgetRaw: budget.toString(), gasPriceWei: gasPriceWei.toString(), estimatedGasWei: estimatedGasWei.toString(), disputeWindowSeconds: disputeWindow.toString() },
  guard,
  rawEvidence: preflightEvidence,
});
if (!guard.ok || readClient.network.chainId !== 97 || quoteVerification.valid !== true) {
  readWallet.destroy();
  fail("Preflight security or funding gate failed; no transaction attempted.", { errors: guard.errors, chainId: rpcChainId, token: tokenAddress, quoteCurrency: quoteTerms.currency, quoteVerification, paymentTokenBalance: tokenBalance.toString(), requiredBudget: budget.toString(), tBNBBalance: nativeBalance.toString(), estimatedGasWei: estimatedGasWei.toString() });
  process.exit();
}
readWallet.destroy();
if (process.env.CANNED_ALLOW_TESTNET_WRITES !== "true") { fail("CANNED_ALLOW_TESTNET_WRITES is not true; preflight is complete and no transaction was attempted.", { walletAddress: process.env.CANNED_EXECUTION_WALLET_ADDRESS, requiredBudget: quoteTerms.price, paymentToken: tokenAddress }); process.exit(); }

const runId = id("run");
const manifest = createPrecommitManifest({
  runId,
  agent,
  benchmark,
  input,
  limits: { maxBudgetRaw: quoteTerms.price, maxSlippageBps: input.maxSlippageBps, maxPriceImpactBps: input.maxPriceImpactBps, noTransactionByAgent: true },
  startAt: nowIso(),
  deadlineAtUnixSeconds,
  runType: RUN_TYPES.BENCHMARK,
  provenanceMode: "LIVE_QUALIFYING",
  providerIdentity: identity,
  providerAddress: provider,
  quoteTerms: { ...quoteTerms, negotiationHash: quoteProbe.negotiationHash, providerSignature: quoteProbe.providerSignature, quoteExpiresAt },
  expectedEvidenceSchema: input.expectedOutputSchema,
  validityCriteria: ["fresh identity/provider match", "fresh signed quote verified by official SDK", "funded ERC-8183 job", "independent no-intervention control", "deterministic evaluator result"],
  costAccounting: { agentFee: `${quoteTerms.price} raw ${tokenSymbol}`, networkGas: "sum of actual ERC-8183 receipts", control: "zero payment and zero chain gas for analysis-only no-op" },
});
const precommitEvidenceRecord = await store.saveEvidence(manifest);
await store.saveJson(`state/precommit-${runId}.json`, { manifest, evidence: precommitEvidenceRecord, createdAt: nowIso() });
console.log(JSON.stringify({ status: "precommitted", runId, manifestHash: manifest.manifestHash, evidenceLevel: manifest.evidenceLevel, provider, budget: quoteTerms.price, paymentToken: tokenAddress }, null, 2));

const funded = await createFundedJob({ agent, precommit: manifest, quote: quoteProbe, store, env: process.env });
if (!funded.ok) { fail("ERC-8183 buyer lifecycle did not reach funded state.", { runId, error: funded.error || null, state: funded.record?.state || null }); process.exit(); }
const jobId = funded.record.jobId;
console.log(JSON.stringify({ status: "funded", runId, jobId }, null, 2));
const notify = await notifyFundedA2A({ endpoint: a2a.endpoint, card: a2a.card, jobId });
const notifyEvidence = await store.saveEvidence({ kind: "a2a_notify_funded", runId, jobId, response: notify.response, rawResponse: notify.rawResponse });
const notifyAccepted = notify.ok && /accepted/i.test(JSON.stringify(notify.response || {}));
await appendProtocolEvent({ store, runId, event: "notify_funded", extra: { accepted: notifyAccepted, evidence: notifyEvidence, response: notify.response, error: notify.error || null } });
if (!notifyAccepted) console.log(JSON.stringify({ status: "provider_notify_rejected", runId, jobId, error: notify.error || "Provider did not accept the funded-job notification." }, null, 2));

async function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function observeUntilTerminal() {
  let previous = null;
  let latest = null;
  while (Date.now() < deadlineAtUnixSeconds * 1000) {
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

const observed = notifyAccepted ? await observeUntilTerminal() : { latest: await readJob({ client: funded.client, jobId }), timedOut: false };
let latest = observed.latest;
let agentOutput = {};
let agentExecution = { status: observed.timedOut ? "timeout" : "pending", elapsedMs: null, cost: { feeRaw: quoteTerms.price, paymentToken: tokenSymbol }, evidence: null };
if (latest && ["SUBMITTED", "COMPLETED"].includes(latest.status)) {
  const deliverableUrl = await funded.client.getDeliverableUrl(BigInt(jobId));
  if (deliverableUrl && isPublicHttpUrl(deliverableUrl)) {
    const deliverable = await requestJson(deliverableUrl, { timeoutMs: 20_000 });
    const deliverableEvidence = await store.saveEvidence({ kind: "provider_deliverable", runId, jobId, url: deliverableUrl, status: deliverable.status, body: deliverable.body, rawText: deliverable.rawText });
    const body = deliverable.body && typeof deliverable.body === "object" && !Array.isArray(deliverable.body) ? (deliverable.body.output && typeof deliverable.body.output === "object" ? deliverable.body.output : deliverable.body.result && typeof deliverable.body.result === "object" ? deliverable.body.result : deliverable.body) : {};
    agentOutput = body;
    agentExecution = { status: deliverable.ok ? "completed" : "error", elapsedMs: deliverable.elapsedMs, cost: { feeRaw: quoteTerms.price, paymentToken: tokenSymbol }, deliverableUrl, evidence: deliverableEvidence };
    await appendProtocolEvent({ store, runId, event: "deliverable_observed", extra: { deliverableUrl, evidence: deliverableEvidence, httpStatus: deliverable.status } });
  } else {
    agentExecution = { status: "error", elapsedMs: null, cost: { feeRaw: quoteTerms.price, paymentToken: tokenSymbol }, error: "Submitted job did not expose a public deliverable URL." };
  }
}

const controlStart = Date.now();
const controlOutput = {
  provenance: { independent: true, procedure: "No active rebalancing intervention; hold the declared starting range for the same stated window." },
  status: "completed",
  recommendation: "hold",
  targetLowerTick: input.position.lowerTick,
  targetUpperTick: input.position.upperTick,
  observationWindowSeconds: input.observationWindowSeconds,
  elapsedMs: Date.now() - controlStart,
  cost: { paymentTokenRaw: "0", nativeGasWei: "0" },
  dataLimitations: ["Analysis-only control performs no capital movement.", "No realized fees, time-in-range, or price impact can be observed in this one-off task."],
};

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
const executionStatus = observed.timedOut ? "timeout" : latest?.status === "REJECTED" ? "rejected" : latest?.status === "EXPIRED" ? "expired" : agentExecution.status === "error" ? "error" : undefined;
const run = await runBenchmark({ agent, benchmark, input, agentOutput, controlOutput, store, runType: RUN_TYPES.BENCHMARK, provenanceMode: "LIVE_QUALIFYING", precommit: manifest, precommitEvidence: precommitEvidenceRecord, protocolJob, executionStatus, agentExecution, controlExecution: { status: "completed", elapsedMs: controlOutput.elapsedMs, cost: controlOutput.cost, methodology: controlOutput.provenance } , termixEligiblePair: false, termixReason: "Analysis-only task has no observed performance window and is not TermiX-ready." });
console.log(JSON.stringify({ status: "complete", runId, jobId, chainState: latest?.status || "UNKNOWN", terminalState: run.terminalState, evaluation: run.evaluation, qualification: run.qualification, manifestHash: run.manifest.hash, agentArtifact: run.artifacts.agentOutput, controlArtifact: run.artifacts.controlOutput }, null, 2));
