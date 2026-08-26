import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatEther } from "viem";
import { contentHashes, canonicalJson, id, nowIso, requestJson, safeError } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { createPrecommitManifest } from "../src/benchmark/framework.mjs";
import { extractProviderDeliverable, validateSubmittedDeliverable } from "../src/benchmark/validation.mjs";
import { CONTROL_BENCHMARK, CONTROL_IDENTITY, CONTROL_RUN_TYPE, buildControlQualification, buildInfrastructureControlRun, controlResponseContent, deterministicControlOutput, lifecyclePhaseSummary, validateDeterministicControl } from "../src/protocol/control.mjs";
import { appendProtocolEvent, createBuyer, loadSdk, readJob, sendNativeTransfer, txShape, writeSafety } from "../src/protocol/erc8183-buyer.mjs";

const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(root, "data"));
const store = await new FileStore(dataDir).init();
const EXPECTED_CHAIN_ID = 97;
const EXPECTED_PAYMENT_TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const CONTROL_INPUT = Object.freeze({ numbers: [4, 7, 11] });
const CONTROL_TIMEOUT_SECONDS = 180;
const CONTROL_JOB_DEADLINE_SECONDS = 3_600;
const SUBMISSION_GAS_UNITS_PLAN = 300_000n;
const SUBMISSION_GAS_BUFFER_BPS = 12_500n;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function fileExists(file) {
  try { await readFile(file); return true; } catch (error) { return error?.code !== "ENOENT"; }
}

async function loadOrCreateControlWallet(sdk) {
  const walletsDir = path.join(dataDir, "state", "control-provider-wallets");
  const passwordFile = path.join(dataDir, "state", "control-provider-wallet-password.txt");
  await mkdir(walletsDir, { recursive: true });
  const addresses = sdk.EVMWalletProvider.listWallets(walletsDir);
  if (addresses.length > 1) throw new Error("Control provider wallet directory contains more than one wallet; refusing to guess.");
  let password = null;
  try { password = (await readFile(passwordFile, "utf8")).trim(); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (addresses.length === 1 && !password) throw new Error("Control provider keystore exists but its password reference is missing.");
  const created = addresses.length === 0;
  if (!password) password = randomBytes(48).toString("base64url");
  const wallet = new sdk.EVMWalletProvider({ password, ...(addresses.length === 1 ? { address: addresses[0] } : {}), walletsDir, persist: true });
  if (created && !(await fileExists(passwordFile))) {
    await writeFile(passwordFile, `${password}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(passwordFile, 0o600);
  }
  return { wallet, walletsDir, passwordFile, created };
}

async function startLocalDeliveryServer(storageDir) {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const match = pathname.match(/^\/erc8183\/job\/(\d+)\/response$/);
    if (request.method !== "GET" || !match) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    try {
      const file = path.join(storageDir, `erc8183-job-${match[1]}.json`);
      const body = await readFile(file, "utf8");
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "deliverable not yet available" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine local delivery server port.");
  return { server, agentUrl: `http://127.0.0.1:${address.port}/erc8183` };
}

function publicTx(result) {
  if (!result) return null;
  return { transactionHash: result.transactionHash || null, blockNumber: result.receipt?.blockNumber === undefined ? null : String(result.receipt.blockNumber), status: result.receipt?.status || result.status || null, gasUsed: result.receipt?.gasUsed === undefined ? null : String(result.receipt.gasUsed), effectiveGasPrice: result.receipt?.effectiveGasPrice === undefined ? null : String(result.receipt.effectiveGasPrice), gasCostWei: result.receipt?.gasUsed !== undefined && result.receipt?.effectiveGasPrice !== undefined ? (BigInt(result.receipt.gasUsed) * BigInt(result.receipt.effectiveGasPrice)).toString() : null };
}

const sdk = await loadSdk();
const sdkErc8183 = await import("@bnbagent/sdk/erc8183");
const sdkStorage = await import("@bnbagent/sdk/storage");
const safety = writeSafety(process.env);
if (!safety.writesRequested || !safety.safe || safety.network !== "bsc-testnet") {
  console.log(JSON.stringify({ status: "blocked", reason: "Control execution requires explicit safe BSC testnet writes.", network: safety.network, errors: safety.errors }, null, 2));
  process.exit(2);
}

const existingRuns = await store.loadRuns();
const existingControl = existingRuns.find((run) => run.runType === CONTROL_RUN_TYPE);
if (existingControl) {
  console.log(JSON.stringify({ status: "already_exists", runId: existingControl.runId, jobId: existingControl.protocolJob?.jobId || null, chainState: existingControl.protocolJob?.currentState || null, classification: existingControl.resultClassification || null }, null, 2));
  process.exit(0);
}

let providerWallet = null;
let buyerWallet = null;
let deliveryServer = null;
let watcherController = null;
let watcherPromise = null;
let controlRunSaved = false;
let protocolRecord = null;
let runId = id("run");
let jobId = null;

try {
  const controlWallet = await loadOrCreateControlWallet(sdk);
  providerWallet = controlWallet.wallet;
  const providerClient = await sdk.ERC8183Client.create({ network: "bsc-testnet", walletProvider: providerWallet });
  const buyer = await createBuyer({ env: process.env, dataDir });
  buyerWallet = buyer.wallet;
  const [buyerRpcChainId, providerRpcChainId] = await Promise.all([buyer.client.publicClient.getChainId(), providerClient.publicClient.getChainId()]);
  const chainIds = { buyerClient: buyer.client.network.chainId, buyerRpc: buyerRpcChainId, providerClient: providerClient.network.chainId, providerRpc: providerRpcChainId };
  if (Object.values(chainIds).some((value) => value !== EXPECTED_CHAIN_ID)) throw new Error(`Control chain guard failed: ${JSON.stringify(chainIds)}`);
  const [buyerCommerce, providerCommerce, buyerToken, providerToken] = [buyer.client.commerce.address, providerClient.commerce.address, await buyer.client.paymentToken(), await providerClient.paymentToken()];
  if (buyerCommerce.toLowerCase() !== providerCommerce.toLowerCase()) throw new Error("Buyer and provider Commerce deployments differ.");
  if (buyerToken.toLowerCase() !== EXPECTED_PAYMENT_TOKEN.toLowerCase() || providerToken.toLowerCase() !== EXPECTED_PAYMENT_TOKEN.toLowerCase()) throw new Error("Control payment token does not match the expected BSC testnet U contract.");
  const [tokenDecimals, buyerNativeBefore, buyerTokenBefore, buyerAllowanceBefore, gasPrice, providerNativeBefore] = await Promise.all([
    buyer.client.tokenDecimals(),
    buyer.client.publicClient.getBalance({ address: buyerWallet.address }),
    buyer.client.tokenBalance(buyerWallet.address),
    buyer.client.tokenAllowance(buyerWallet.address, buyerCommerce),
    buyer.client.publicClient.getGasPrice(),
    providerClient.publicClient.getBalance({ address: providerWallet.address }),
  ]);
  if (tokenDecimals !== 18) throw new Error(`Control expected 18 U decimals, observed ${tokenDecimals}.`);

  const storageDir = path.join(dataDir, "state", "control-deliverables");
  await mkdir(storageDir, { recursive: true });
  deliveryServer = await startLocalDeliveryServer(storageDir);
  const providerJobOps = await sdkErc8183.ERC8183JobOps.create({ walletProvider: providerWallet, network: "bsc-testnet", storageProvider: new sdkStorage.LocalStorageProvider(storageDir), servicePrice: 0n, agentUrl: deliveryServer.agentUrl });
  const providerInitialScan = await providerJobOps.getPendingJobs();
  if (!providerInitialScan.success) throw new Error(`Control provider initial chain scan failed: ${providerInitialScan.error || "unknown error"}`);
  const providerReadyAt = nowIso();
  const providerGasPlanWei = (gasPrice * SUBMISSION_GAS_UNITS_PLAN * SUBMISSION_GAS_BUFFER_BPS) / 10_000n;
  let providerFunding = null;
  if (providerNativeBefore < providerGasPlanWei) {
    providerFunding = await sendNativeTransfer({ wallet: buyerWallet, publicClient: buyer.client.publicClient, to: providerWallet.address, valueWei: providerGasPlanWei - providerNativeBefore, expectedChainId: EXPECTED_CHAIN_ID });
  }

  const inputHash = contentHashes(CONTROL_INPUT).sha256;
  const requestData = { task_description: `CANNED_PROTOCOL_CONTROL deterministic integer sum; input_hash=${inputHash}; input=${canonicalJson(CONTROL_INPUT)}`, terms: { deliverables: "JSON result containing the original input hash, count, sum, algorithm, provider, and decimal job ID.", quality_standards: "Exact deterministic integer computation; no LLM; no capital movement." } };
  const negotiationHandler = await sdkErc8183.NegotiationHandler.fromErc8183Client(providerClient, { servicePrice: "0", estimatedCompletionSeconds: 30, quoteTtlSeconds: 300, walletProvider: providerWallet });
  const quoteResult = await negotiationHandler.negotiate(requestData);
  const quoteEnvelope = quoteResult.toDict();
  const quoteVerification = await sdkErc8183.verifyQuoteSignature({ envelope: quoteEnvelope, provider: providerWallet.address, publicClient: buyer.client.publicClient, expectedVerifyingContract: buyerCommerce });
  const quoteTerms = quoteEnvelope.response?.terms || {};
  const quoteExpiry = Number(quoteEnvelope.quote_expires_at || quoteEnvelope.response?.quote_expires_at || 0);
  if (!quoteResult.accepted || String(quoteTerms.price) !== "0" || String(quoteTerms.currency).toLowerCase() !== buyerToken.toLowerCase() || quoteVerification.valid !== true || quoteExpiry <= Math.floor(Date.now() / 1000)) throw new Error("Control signed quote verification failed.");
  const description = sdkErc8183.buildJobDescription(quoteEnvelope);
  const descriptionHash = contentHashes(description).keccak256;
  // ERC-8183's OptimisticPolicy reserves a 900-second dispute window before
  // submission. Keep the buyer observation timeout short, but give the job
  // expiry enough runway for that protocol guard.
  const deadlineAtUnixSeconds = Math.floor(Date.now() / 1000) + CONTROL_JOB_DEADLINE_SECONDS;
  const agent = { identity: CONTROL_IDENTITY, name: CONTROL_IDENTITY, agentWallet: providerWallet.address, ownerAddress: providerWallet.address, services: [{ type: "headless", endpoint: deliveryServer.agentUrl }] };
  const manifest = createPrecommitManifest({ runId, agent, benchmark: CONTROL_BENCHMARK, input: { ...CONTROL_INPUT, inputHash, chainId: EXPECTED_CHAIN_ID, commerce: buyerCommerce, providerAddress: providerWallet.address, sdk: "@bnbagent/sdk", sdkVersion: "0.5.4", providerImplementation: "ERC8183JobOps + fundedJobWatcher", timeoutSeconds: CONTROL_TIMEOUT_SECONDS, budgetRaw: "0", classification: CONTROL_RUN_TYPE }, limits: { maxBudgetRaw: "0", maxProviderGasWei: providerGasPlanWei.toString(), noAgentTransactions: true, noMarketplaceIdentity: true }, startAt: nowIso(), deadlineAtUnixSeconds, runType: CONTROL_RUN_TYPE, provenanceMode: "INFRASTRUCTURE_CONTROL", providerIdentity: CONTROL_IDENTITY, providerAddress: providerWallet.address, quoteTerms: { price: "0", currency: buyerToken, quoteExpiresAt: quoteExpiry, negotiationHash: quoteEnvelope.negotiation_hash }, expectedEvidenceSchema: { providerOutput: "SDK DeliverableManifest with deterministic JSON content", onchain: "ERC-8183 SUBMITTED job and submit transaction", control: "No LLM and no product metric contribution" }, validityCriteria: ["chain 97", "separate provider wallet", "fresh provider-signed quote", "precommit before funding", "official fundedJobWatcher detected FUNDED", "official submitResult produced SUBMITTED", "buyer retrieved and validated deliverable", "control remains excluded from product metrics"], costAccounting: { uEscrow: "zero-price control; no U transfer", providerGas: "bounded native transfer and actual submit receipt" } });
  const precommitEvidence = await store.saveEvidence(manifest);
  await store.saveJson(`state/precommit-${runId}.json`, { manifest, evidence: precommitEvidence, createdAt: nowIso() });
  protocolRecord = { kind: "protocol_control_job", protocol: "ERC-8183", network: "bsc-testnet", chainId: EXPECTED_CHAIN_ID, runId, agentIdentity: CONTROL_IDENTITY, provider: providerWallet.address, buyer: buyerWallet.address, budget: "0", paymentToken: buyerToken, quote: { price: "0", currency: buyerToken, quoteExpiresAt: quoteExpiry, negotiationHash: quoteEnvelope.negotiation_hash, signed: true, verified: quoteVerification.valid === true }, descriptionHash, precommitHash: manifest.manifestHash, state: "not_started", funded: false, control: true, events: [], createdAt: nowIso() };
  await store.saveJson(`state/protocol-job-${runId}.json`, protocolRecord);
  const saveEvent = async (event, extra = {}) => { protocolRecord = await appendProtocolEvent({ store, runId, event, extra }); return protocolRecord; };
  await saveEvent("provider_ready", { readiness: { readyAt: providerReadyAt, initialScanSuccess: true, chainIds, commerce: buyerCommerce, paymentToken: buyerToken, tokenDecimals, providerAddress: providerWallet.address, watcher: "fundedJobWatcher", providerOps: "ERC8183JobOps", storage: "LocalStorageProvider", localDeliveryEndpoint: deliveryServer.agentUrl, gasPriceWei: gasPrice.toString(), submissionGasUnitsPlan: SUBMISSION_GAS_UNITS_PLAN.toString(), submissionGasBufferBps: SUBMISSION_GAS_BUFFER_BPS.toString(), providerNativeBefore: providerNativeBefore.toString(), providerGasPlanWei: providerGasPlanWei.toString(), providerFunding: publicTx(providerFunding) } });

  const created = await buyer.client.createJob({ provider: providerWallet.address, expiredAt: BigInt(deadlineAtUnixSeconds), description });
  if (created.jobId === null || created.jobId === undefined) throw new Error("Control createJob returned no job ID.");
  jobId = String(created.jobId);
  protocolRecord.jobId = jobId;
  await store.saveJson(`state/protocol-job-${runId}.json`, protocolRecord);
  await saveEvent("create_job", { tx: txShape(created), snapshot: await readJob({ client: buyer.client, jobId }), precommitBinding: { level: "CONTROL_SIGNED_QUOTE_BOUND_PRECOMMIT", method: "ERC-8183 job.description", manifestHash: manifest.manifestHash, signedQuoteDescriptionHash: descriptionHash } });
  await saveEvent("register_job", { tx: txShape(await buyer.client.registerJob(BigInt(jobId))), snapshot: await readJob({ client: buyer.client, jobId }) });
  await saveEvent("set_budget", { tx: txShape(await buyer.client.setBudget(BigInt(jobId), 0n)), snapshot: await readJob({ client: buyer.client, jobId }), budget: "0" });

  watcherController = new AbortController();
  watcherPromise = sdkErc8183.fundedJobWatcher(providerJobOps, async (job) => {
    if (Number(job.jobId) !== Number(jobId)) return undefined;
    await saveEvent("provider_detected", { snapshot: { ...job, status: "FUNDED" }, providerAddress: providerWallet.address, detectedAt: nowIso() });
    const parsed = sdkErc8183.parseJobDescription(job.description);
    if (!parsed || !String(parsed.task || "").includes(inputHash)) {
      await saveEvent("provider_work_error", { error: "Control job description did not contain the precommitted input hash." });
      return undefined;
    }
    const output = deterministicControlOutput({ input: CONTROL_INPUT, jobId, provider: providerWallet.address });
    await saveEvent("provider_work_completed", { outputHash: contentHashes(output).sha256, algorithm: output.algorithm });
    const result = await providerJobOps.submitResult(Number(jobId), controlResponseContent(output), { classification: CONTROL_RUN_TYPE, inputHash, algorithm: output.algorithm, sdk: "@bnbagent/sdk@0.5.4" });
    let submitReceipt = null;
    let submitTransaction = null;
    if (result.txHash) {
      submitReceipt = await providerClient.publicClient.getTransactionReceipt({ hash: result.txHash });
      submitTransaction = await providerClient.publicClient.getTransaction({ hash: result.txHash });
    }
    await saveEvent("provider_submit_result", { result: { success: result.success === true, txHash: result.txHash || null, deliverable: result.deliverable || null, deliverableUrl: result.deliverableUrl || null, error: result.error || null, errorCode: result.error_code || null, retryable: result.retryable === true }, tx: result.txHash && submitReceipt ? txShape({ transactionHash: result.txHash, status: submitReceipt.status === "success" ? 1 : 0, receipt: submitReceipt }) : null, submitter: submitTransaction?.from || null });
    return result.success === true ? undefined : { retry: result.retryable === true };
  }, { interval: 3, stop: watcherController.signal });
  const watcherStartedAt = nowIso();
  await saveEvent("watcher_started", { readinessTimestamp: providerReadyAt, watcherStartedAt, watcherIntervalSeconds: 3 });
  const funded = await buyer.client.fund(BigInt(jobId), 0n, { approveFloor: 0n });
  protocolRecord.funded = true;
  protocolRecord.state = "funded";
  await saveEvent("fund_job", { tx: txShape(funded), snapshot: await readJob({ client: buyer.client, jobId }), budget: "0", approval: "skipped_zero_price_control" });

  let latest = null;
  let previousStatus = null;
  const observationDeadline = Date.now() + CONTROL_TIMEOUT_SECONDS * 1000;
  while (Date.now() < observationDeadline) {
    latest = await readJob({ client: buyer.client, jobId });
    if (latest.status !== previousStatus) {
      previousStatus = latest.status;
      await saveEvent("chain_state_observed", { snapshot: latest });
    }
    if (["SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"].includes(latest.status)) break;
    await delay(2_000);
  }
  if (!latest) latest = await readJob({ client: buyer.client, jobId });
  if (watcherController) watcherController.abort();
  if (watcherPromise) await Promise.race([watcherPromise, delay(5_000)]);
  protocolRecord = await store.loadJson(`state/protocol-job-${runId}.json`, protocolRecord);
  latest = await readJob({ client: buyer.client, jobId });
  if (["SUBMITTED", "COMPLETED"].includes(latest.status)) await saveEvent("chain_state_observed", { snapshot: latest });

  let deliverable = null;
  let deliverableValidation = null;
  let deterministicValidation = null;
  let rawDeliverableEvidence = null;
  let submitTransaction = null;
  const submitEvent = protocolRecord.events.find((event) => event.event === "provider_submit_result");
  if (submitEvent?.result?.txHash) {
    submitTransaction = await providerClient.publicClient.getTransaction({ hash: submitEvent.result.txHash });
  }
  const providerSignerMatches = Boolean(submitTransaction?.from && submitTransaction.from.toLowerCase() === providerWallet.address.toLowerCase());
  if (["SUBMITTED", "COMPLETED"].includes(latest.status)) {
    const deliverableUrl = await buyer.client.getDeliverableUrl(BigInt(jobId));
    const fetched = await requestJson(deliverableUrl, { timeoutMs: 20_000 });
    rawDeliverableEvidence = await store.saveEvidence({ kind: "control_provider_deliverable_raw", runId, jobId, deliverableUrl, status: fetched.status, body: fetched.body, rawText: fetched.rawText });
    deliverableValidation = validateSubmittedDeliverable({ body: fetched.body, jobId, onchainDeliverable: latest.deliverable, expectedOutputFields: ["inputHash", "count", "sum", "algorithm", "provider"] });
    deliverable = extractProviderDeliverable(fetched.body).output;
    deterministicValidation = validateDeterministicControl({ output: deliverable, expectedInput: CONTROL_INPUT, expectedJobId: jobId, expectedProvider: providerWallet.address });
    await saveEvent("deliverable_observed", { deliverableUrl, evidence: rawDeliverableEvidence, validation: { ...deliverableValidation, output: undefined }, deterministicValidation: { ...deterministicValidation, expected: undefined, output: undefined }, providerSignerMatches });
  }
  const validation = { valid: deliverableValidation?.valid === true && deterministicValidation?.valid === true && providerSignerMatches, hasActualDeliverable: deliverableValidation?.hasActualDeliverable === true && deterministicValidation?.valid === true && providerSignerMatches, errors: [...(deliverableValidation?.errors || []), ...(deterministicValidation?.errors || []), ...(providerSignerMatches ? [] : ["provider_signer_mismatch"])], manifestHash: deliverableValidation?.manifestHash || null, rawOutputHash: deliverable ? contentHashes(deliverable).sha256 : null, outputHash: deliverable ? contentHashes(deliverable).keccak256 : null };
  const outputEvidence = deliverable ? await store.saveEvidence({ kind: "control_deterministic_output", runId, jobId, output: deliverable, validation }) : null;
  protocolRecord = await store.loadJson(`state/protocol-job-${runId}.json`, protocolRecord);
  protocolRecord.currentState = latest.status;
  protocolRecord.state = latest.status.toLowerCase();
  protocolRecord.funded = true;
  await store.saveJson(`state/protocol-job-${runId}.json`, protocolRecord);
  const qualification = buildControlQualification({ protocolJob: protocolRecord, deliverableValidation: validation, providerSignerMatches });
  const lifecycle = lifecyclePhaseSummary(protocolRecord);
  const prior = await store.loadRuns();
  const comparisons = { knownGoodControl: lifecycle, job669: lifecyclePhaseSummary(prior.find((run) => String(run.protocolJob?.jobId) === "669")?.protocolJob), job673: lifecyclePhaseSummary(prior.find((run) => String(run.protocolJob?.jobId) === "673")?.protocolJob) };
  const submittedOnchain = ["SUBMITTED", "COMPLETED"].includes(latest.status);
  const hasSubmitTransaction = Boolean(submitEvent?.result?.txHash);
  const resultClassification = qualification.isComplete
    ? "CANNED_ERC8183_BUYER_PATH_VERIFIED"
    : latest.status === "FUNDED"
      ? "CANNED_PROVIDER_WATCH_PATH_BROKEN"
      : submittedOnchain && hasSubmitTransaction && !validation.valid
        ? "CANNED_OBSERVATION_PATH_BROKEN"
        : hasSubmitTransaction
          ? "INCONCLUSIVE"
          : "CANNED_SUBMIT_PATH_BROKEN";
  const controlOutputEvidence = outputEvidence || rawDeliverableEvidence;
  const run = buildInfrastructureControlRun({ runId, precommit: manifest, protocolJob: protocolRecord, provider: { address: providerWallet.address }, quote: { price: "0", currency: buyerToken, negotiationHash: quoteEnvelope.negotiation_hash, signed: quoteVerification.valid === true }, readiness: { readyAt: providerReadyAt, watcherStartedAt, chainIds, commerce: buyerCommerce, paymentToken: buyerToken, tokenDecimals, providerAddress: providerWallet.address, providerInitialScan, providerGasPlanWei: providerGasPlanWei.toString(), providerFunding: publicTx(providerFunding) }, deliverable: deliverable ? { content: deliverable, url: protocolRecord.events.find((event) => event.event === "deliverable_observed")?.deliverableUrl || null, onchainManifestHash: latest.deliverable, rawOutputHash: validation.rawOutputHash, outputHash: validation.outputHash, evidence: rawDeliverableEvidence, outputEvidence: controlOutputEvidence, submissionTransaction: submitEvent?.result?.txHash || null } : null, validation, qualification, economics: { uEscrowedRaw: "0", uSpentRaw: "0", uRefundedRaw: "0", tokenDecimals, buyerUBeforeRaw: buyerTokenBefore.toString(), buyerUNetChangeRaw: "0", buyerNativeBeforeWei: buyerNativeBefore.toString(), buyerNativeAfterWei: (await buyer.client.publicClient.getBalance({ address: buyerWallet.address })).toString(), providerNativeBeforeWei: providerNativeBefore.toString(), providerNativeAfterWei: (await providerClient.publicClient.getBalance({ address: providerWallet.address })).toString(), providerGasPlanWei: providerGasPlanWei.toString(), providerFunding: publicTx(providerFunding), submitGas: submitEvent?.tx || null }, lifecycle, createdAt: nowIso() });
  run.artifacts = { precommit: precommitEvidence, rawDeliverable: rawDeliverableEvidence, deterministicOutput: outputEvidence };
  run.quoteVerification = { valid: quoteVerification.valid === true, method: quoteVerification.method || null, signer: quoteVerification.signer || null };
  run.descriptionHash = descriptionHash;
  run.resultClassification = resultClassification;
  run.diagnosticComparison = comparisons;
  run.evaluation = { status: qualification.isComplete ? "completed" : "failed", providerSignerMatches, deliverableValid: validation.valid, comparison: comparisons };
  await store.saveRun(run);
  controlRunSaved = true;
  console.log(JSON.stringify({ status: "complete", runId, jobId, network: "bsc-testnet", chainId: EXPECTED_CHAIN_ID, providerAddress: providerWallet.address, budget: "0 U", finalState: latest.status, resultClassification, providerReadyAt, watcherStartedAt, deliverable: deliverable ? { output: deliverable, rawOutputHash: validation.rawOutputHash, onchainManifestHash: latest.deliverable, submissionTx: submitEvent?.result?.txHash || null, url: run.deliverable?.url || null } : null, qualification, transactions: protocolRecord.events.filter((event) => event.tx?.transactionHash).map((event) => ({ event: event.event, ...publicTx(event.tx) })), economics: run.economics, diagnosticComparison: comparisons }, null, 2));
} catch (error) {
  if (protocolRecord && !controlRunSaved) {
    try {
      protocolRecord = await appendProtocolEvent({ store, runId, event: "control_error", extra: { error: safeError(error), jobId } });
      protocolRecord.currentState = protocolRecord.currentState || "ERROR";
      await store.saveJson(`state/protocol-job-${runId}.json`, protocolRecord);
    } catch { /* preserve the original failure without masking it */ }
  }
  console.error(JSON.stringify({ status: "error", reason: safeError(error), runId, jobId, secretOutput: "none" }, null, 2));
  process.exitCode = 1;
} finally {
  watcherController?.abort();
  if (watcherPromise) await Promise.race([watcherPromise, delay(2_000)]);
  if (deliveryServer) await new Promise((resolve) => deliveryServer.server.close(() => resolve()));
  providerWallet?.destroy();
  buyerWallet?.destroy();
}
