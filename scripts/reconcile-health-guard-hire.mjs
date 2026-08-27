import path from "node:path";
import { nowIso, safeError } from "../src/core.mjs";
import { deriveQualificationFlags } from "../src/benchmark/framework.mjs";
import { extractProviderDeliverable, validateSubmittedDeliverable } from "../src/benchmark/validation.mjs";
import { RUN_TYPES, terminalStateFor } from "../src/domain.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { appendProtocolEvent, fetchDeliverable, loadSdk, readJob, txShape, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { HEALTH_BENCHMARK_ID } from "../src/reference/health-benchmark.mjs";

const EXPECTED_CHAIN_ID = 97;
const OUTPUT_FIELDS = ["position", "assessment", "changes", "recommendation", "evidence"];

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (body) => console.log(JSON.stringify(body, null, 2));

const runs = await store.loadRuns();
const targetRunId = process.argv[2] || null;
const index = targetRunId
  ? runs.findIndex((item) => item.runId === targetRunId)
  : runs.map((item, position) => ({ item, position })).filter(({ item }) => item?.benchmark?.id === HEALTH_BENCHMARK_ID && item?.runType === RUN_TYPES.BENCHMARK).sort((left, right) => Date.parse(right.item.createdAt) - Date.parse(left.item.createdAt))[0]?.position ?? -1;
if (index < 0) throw new Error("No HealthBench benchmark run is recorded.");
const run = runs[index];
const runId = run.runId;
const jobId = String(run.protocolJob?.jobId ?? "");
if (!/^\d+$/.test(jobId)) throw new Error(`Run ${runId} has no recoverable ERC-8183 job ID.`);
const runRecord = await store.loadJson(`state/healthbench-run-${runId}.json`, null);
if (!runRecord) throw new Error(`Run ${runId} has no HealthBench run record.`);

const sdk = await loadSdk();
const safety = writeSafety(env);
const settleRequested = env.CANNED_ALLOW_TESTNET_WRITES === "true";
const wallet = settleRequested
  ? new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true })
  : null;
const client = await sdk.ERC8183Client.create({ network: "bsc-testnet", ...(wallet ? { walletProvider: wallet } : {}) });
const chainId = await client.publicClient.getChainId();
if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`Reconciliation observed chain ${chainId}; expected ${EXPECTED_CHAIN_ID}.`);

let snapshot = await readJob({ client, jobId });
await appendProtocolEvent({ store, runId, event: "reconciliation_chain_state_observed", extra: { snapshot } });
log({ status: "observed", runId, jobId, chainState: snapshot.status, submittedAt: snapshot.submittedAt });

// The provider submitted after the local observation window closed. Retrieve
// and validate the raw deliverable before anything is graded or settled.
let deliverable = runRecord.deliverable;
if (["SUBMITTED", "COMPLETED"].includes(snapshot.status) && deliverable?.validation?.valid !== true) {
  const definition = await store.loadJson("state/healthbench-v1.json", null);
  const baseline = await store.loadJson("state/health-baseline.json", null);
  let deliverableRef = null;
  try { deliverableRef = await client.getDeliverableUrl(BigInt(jobId)); } catch (error) { await appendProtocolEvent({ store, runId, event: "reconciliation_deliverable_url_error", extra: { error: safeError(error) } }); }
  const resolved = await fetchDeliverable(deliverableRef);
  if (!resolved.ok) throw new Error(`Job ${jobId} is ${snapshot.status} but its deliverable ${deliverableRef} could not be retrieved: ${JSON.stringify(resolved.attempts)}`);
  const deliverableUrl = deliverableRef;
  const fetched = resolved.response;
  const evidence = await store.saveEvidence({ kind: "health_guard_deliverable_raw", runId, jobId, reference: deliverableRef, cid: resolved.cid, contentAddressed: resolved.contentAddressed, retrievedFrom: resolved.url, httpStatus: fetched.status, body: fetched.body, rawText: fetched.rawText, reconciled: true });
  const validation = validateSubmittedDeliverable({ body: fetched.body, jobId, onchainDeliverable: snapshot.deliverable, expectedOutputFields: OUTPUT_FIELDS });
  const output = extractProviderDeliverable(fetched.body).output;
  const boundToBenchmark = String(output?.position?.asOfBlock ?? "") === String(definition.frozenEvidence.snapshot.asOfBlock);
  const boundToAccount = String(output?.position?.account || "").toLowerCase() === String(definition.position.account).toLowerCase();
  const noHumanLeakage = !JSON.stringify(output ?? {}).includes(String(baseline.submission.positionFacts));
  if (!boundToBenchmark) validation.errors.push("deliverable_reference_block_mismatch");
  if (!boundToAccount) validation.errors.push("deliverable_account_mismatch");
  if (!noHumanLeakage) validation.errors.push("deliverable_contains_human_answer");
  validation.valid = validation.errors.length === 0;
  validation.hasActualDeliverable = validation.valid && Boolean(validation.manifestHash);
  validation.boundToBenchmark = boundToBenchmark;
  validation.boundToAccount = boundToAccount;
  deliverable = { url: deliverableUrl, cid: resolved.cid, contentAddressed: resolved.contentAddressed, retrievedFrom: resolved.url, evidence, validation, rawOutput: output };
  await appendProtocolEvent({ store, runId, event: "deliverable_observed", extra: { deliverableUrl, evidence, httpStatus: fetched.status, validation: { ...validation, output: undefined }, reconciled: true } });
  log({ status: "deliverable_reconciled", runId, jobId, valid: validation.valid, errors: validation.errors, url: deliverableUrl });
}

// Settle once the dispute window has elapsed. Settlement is the only write here.
if (snapshot.status === "SUBMITTED" && settleRequested) {
  if (!safety.safe || safety.network !== "bsc-testnet") throw new Error(`Refusing settlement: ${safety.errors.join(" ") || safety.network}`);
  const disputeWindow = Number(await client.policy.disputeWindow());
  const settleAt = Number(snapshot.submittedAt) + disputeWindow;
  log({ status: "awaiting_dispute_window", runId, jobId, settleAtUnixSeconds: settleAt, disputeWindowSeconds: disputeWindow });
  while (Math.floor(Date.now() / 1000) < settleAt + 2) await delay(3_000);
  for (let attempt = 1; attempt <= 8 && snapshot.status === "SUBMITTED"; attempt += 1) {
    try {
      const settled = await client.settle(BigInt(jobId));
      await appendProtocolEvent({ store, runId, event: "settle_job", extra: { tx: txShape(settled), attempt, reconciled: true } });
      snapshot = await readJob({ client, jobId });
      await appendProtocolEvent({ store, runId, event: "chain_state_observed", extra: { snapshot } });
      log({ status: "settled", runId, jobId, chainState: snapshot.status, attempt });
    } catch (error) {
      await appendProtocolEvent({ store, runId, event: "settle_error", extra: { error: safeError(error), attempt } });
      log({ status: "settle_error", runId, jobId, attempt, error: safeError(error) });
      await delay(5_000);
      snapshot = await readJob({ client, jobId });
    }
  }
}
wallet?.destroy();

// Elapsed time runs to the provider's own onchain submission, not to whenever
// the local loop happened to stop. Any operator intervention counts against the
// agent path rather than being excused from it.
const quoteRequestedAtMs = Date.parse(runRecord.agentExecution?.timing?.quoteRequestedAt || run.createdAt);
const onchainSubmittedAtMs = Number(snapshot.submittedAt) > 0 ? Number(snapshot.submittedAt) * 1000 : null;
const trueElapsedMs = onchainSubmittedAtMs && Number.isFinite(quoteRequestedAtMs) ? onchainSubmittedAtMs - quoteRequestedAtMs : runRecord.agentExecution?.elapsedMs ?? null;
const timing = {
  ...(runRecord.agentExecution?.timing || {}),
  onchainSubmittedAtUnixSeconds: Number(snapshot.submittedAt) || null,
  hireToOnchainSubmissionMs: trueElapsedMs,
  localObservationWindowExpiredMs: runRecord.agentExecution?.timing?.endToEndMs ?? null,
  elapsedBasis: "quote requested to the provider's onchain submission, including any provider downtime and operator intervention",
};

// Update the run in place. The original observation is preserved, not replaced.
const protocolJob = await store.loadJson(`state/protocol-job-${runId}.json`, run.protocolJob);
protocolJob.currentState = snapshot.status;
await store.saveJson(`state/protocol-job-${runId}.json`, protocolJob);
const evaluation = deliverable?.validation?.valid === true ? { ...run.evaluation, status: "completed" } : run.evaluation;
const executionStatus = deliverable?.validation?.valid === true && snapshot.status === "COMPLETED" ? "completed" : snapshot.status === "EXPIRED" ? "expired" : run.executionStatus || run.terminalState;
const qualification = deriveQualificationFlags({
  runType: run.runType,
  provenanceMode: run.provenance?.mode || "LIVE_QUALIFYING",
  precommit: { manifestHash: run.manifest?.hash },
  protocolJob,
  agentOutput: deliverable?.rawOutput ?? null,
  agentDeliverableValidation: deliverable?.validation ?? null,
  controlOutput: { provenance: run.controlExecution?.methodology || { independent: true } },
  evaluation,
  terminalState: terminalStateFor({ executionStatus, evaluationStatus: evaluation?.status }),
  termixEligiblePair: false,
  termixReason: "TermiX qualification is computed by the grading step from the sealed pair.",
});
const priorVerified = runs.some((item) => item.runId !== runId && item.qualification?.isVerifiedRun === true);
const reconciledRun = {
  ...run,
  agentExecution: { ...run.agentExecution, status: executionStatus, elapsedMs: trueElapsedMs, timing, deliverableUrl: deliverable?.url ?? null, evidence: deliverable?.evidence ?? null, deliverableValidation: deliverable?.validation ?? null },
  evaluation,
  executionStatus,
  terminalState: terminalStateFor({ executionStatus, evaluationStatus: evaluation?.status }),
  protocolJob,
  qualification: { ...qualification, isVerifiedRun: qualification.completedBenchmark === true && !priorVerified, verifiedRunNumber: qualification.completedBenchmark === true && !priorVerified ? 1 : null },
  reconciliation: {
    reconciledAt: nowIso(),
    reason: "The provider submitted after the local observation window closed but within the onchain submit deadline. The original observation is preserved below.",
    originalObservation: run.reconciliation?.originalObservation || { terminalState: run.terminalState, executionStatus: run.agentExecution?.status ?? null, chainStateAtTimeout: "FUNDED", observationWindowSeconds: run.manifest?.deadlines?.providerDeliveryDeadlineSeconds ?? null, deliverableObservedInWindow: false },
    finalChainState: snapshot.status,
    method: "read-only chain observation, deliverable retrieval and validation, then settlement",
  },
};
runs[index] = reconciledRun;
await store.saveJson("state/benchmark-runs.json", runs);
await store.saveJson(`state/healthbench-run-${runId}.json`, {
  ...runRecord,
  deliverable,
  chainState: snapshot.status,
  terminalState: reconciledRun.terminalState,
  agentExecution: reconciledRun.agentExecution,
  interventions: runRecord.interventions || [],
  reconciliation: reconciledRun.reconciliation,
  reconciledAt: nowIso(),
});
log({ status: "reconciled", runId, jobId, chainState: snapshot.status, terminalState: reconciledRun.terminalState, deliverableValid: deliverable?.validation?.valid ?? false, qualification: reconciledRun.qualification, next: "npm run health:grade" });
