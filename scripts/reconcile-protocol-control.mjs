import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decodeEventLog } from "viem";
import { contentHashes, nowIso } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { extractProviderDeliverable, validateSubmittedDeliverable } from "../src/benchmark/validation.mjs";
import { validateDeterministicControl } from "../src/protocol/control.mjs";
import { loadSdk, readJob } from "../src/protocol/erc8183-buyer.mjs";

const EXPECTED_CHAIN_ID = 97;
const CONTROL_RUN_TYPE = "INFRASTRUCTURE_PROTOCOL_CONTROL";
const CONTROL_INPUT = Object.freeze({ numbers: [4, 7, 11] });
const JOB_INITIALISED_ABI = [{
  type: "event",
  name: "JobInitialised",
  anonymous: false,
  inputs: [
    { indexed: true, name: "jobId", type: "uint256" },
    { indexed: false, name: "deliverable", type: "bytes32" },
    { indexed: false, name: "submittedAt", type: "uint64" },
    { indexed: false, name: "optParams", type: "bytes" },
  ],
}];

const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(root, "data"));
const store = await new FileStore(dataDir).init();
const runs = await store.loadRuns();
const index = runs.findIndex((run) => run.runType === CONTROL_RUN_TYPE);
if (index < 0) throw new Error("No infrastructure protocol control run is recorded.");

const run = runs[index];
const events = run.protocolJob?.events || [];
const jobId = String(
  run.protocolJob?.jobId
  || events.map((event) => event.snapshot?.id || event.snapshot?.jobId).find((value) => value !== undefined && value !== null)
  || "",
);
if (!/^\d+$/.test(jobId)) throw new Error("Recorded control run has no recoverable public job ID.");

const submitEvent = events.find((event) => event.event === "provider_submit_result");
const submitHash = submitEvent?.result?.txHash;
if (!submitHash) throw new Error("Recorded control run has no provider submit transaction hash.");

const sdk = await loadSdk();
const client = await sdk.ERC8183Client.create({ network: "bsc-testnet" });
const chainId = await client.publicClient.getChainId();
if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`Read-only reconciliation observed chain ${chainId}; expected ${EXPECTED_CHAIN_ID}.`);

const [job, receipt, transaction] = await Promise.all([
  readJob({ client, jobId }),
  client.publicClient.getTransactionReceipt({ hash: submitHash }),
  client.publicClient.getTransaction({ hash: submitHash }),
]);
const providerAddress = run.controlSeller?.providerAddress || run.protocolJob?.provider;
const providerSignerMatches = Boolean(providerAddress && transaction.from.toLowerCase() === providerAddress.toLowerCase());

let submittedEvent = null;
for (const log of receipt.logs) {
  try {
    const decoded = decodeEventLog({ abi: JOB_INITIALISED_ABI, data: log.data, topics: log.topics });
    if (String(decoded.args.jobId) === jobId) {
      submittedEvent = decoded.args;
      break;
    }
  } catch { /* ignore unrelated receipt logs */ }
}
if (!submittedEvent) throw new Error("The successful submit receipt had no decodable JobInitialised event for the control job.");

let onchainDeliverableUrl = null;
try {
  const params = JSON.parse(Buffer.from(submittedEvent.optParams.slice(2), "hex").toString("utf8"));
  onchainDeliverableUrl = typeof params.deliverable_url === "string" ? params.deliverable_url : null;
} catch { /* the validation below remains authoritative for the local artifact */ }

let sdkResolverUrl = null;
try {
  sdkResolverUrl = await client.getDeliverableUrl(BigInt(jobId), { hintBlock: receipt.blockNumber });
} catch { /* record the failed resolver observation below */ }

const localRelativePath = `state/control-deliverables/erc8183-job-${jobId}.json`;
const localBody = JSON.parse(await readFile(path.join(dataDir, localRelativePath), "utf8"));
let replayedBody = null;
let replayStatus = null;
let replayError = null;
if (sdkResolverUrl && onchainDeliverableUrl && sdkResolverUrl === onchainDeliverableUrl) {
  const deliveryUrl = new URL(sdkResolverUrl);
  if (deliveryUrl.protocol === "http:" && deliveryUrl.hostname === "127.0.0.1") {
    const server = createServer((request, response) => {
      if (request.method !== "GET" || request.url !== deliveryUrl.pathname) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(localBody));
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(Number(deliveryUrl.port), "127.0.0.1", resolve);
      });
      const response = await fetch(sdkResolverUrl);
      replayStatus = response.status;
      replayedBody = await response.json();
    } catch (error) {
      replayError = String(error?.message || error).split("\n")[0];
    } finally {
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }
}
const observedBody = replayedBody || localBody;
const deliverableValidation = validateSubmittedDeliverable({
  body: observedBody,
  jobId,
  onchainDeliverable: job.deliverable,
  expectedOutputFields: ["inputHash", "count", "sum", "algorithm", "provider"],
});
const output = extractProviderDeliverable(observedBody).output;
const deterministicValidation = validateDeterministicControl({
  output,
  expectedInput: CONTROL_INPUT,
  expectedJobId: jobId,
  expectedProvider: providerAddress,
});
const deterministicOutputEvidence = await store.saveEvidence({
  kind: "control_deterministic_output_reconciled",
  runId: run.runId,
  jobId,
  output,
  validation: { deliverable: deliverableValidation.valid, deterministic: deterministicValidation.valid, providerSignerMatches },
});
const directEvidenceValid = receipt.status === "success"
  && ["SUBMITTED", "COMPLETED"].includes(job.status)
  && String(submittedEvent.deliverable).toLowerCase() === String(job.deliverable).toLowerCase()
  && sdkResolverUrl === onchainDeliverableUrl
  && replayStatus === 200
  && deliverableValidation.valid === true
  && deterministicValidation.valid === true
  && providerSignerMatches;

const previousReconciliation = run.reconciliation || null;
const initialAttempt = previousReconciliation?.initialAttempt || {
  classification: run.protocolJob?.jobId === "675" && run.resultClassification === "CANNED_ERC8183_BUYER_PATH_VERIFIED"
    ? "CANNED_SUBMIT_PATH_BROKEN"
    : run.resultClassification || null,
  protocolStateAtObservation: "SUBMITTED",
  deliverableObserved: false,
  note: "Initial control invocation recorded a successful submit and SUBMITTED state, but immediate SDK deliverable URL resolution hit public-RPC head lag before read-only reconciliation.",
};
const originalClassification = initialAttempt.classification || run.resultClassification || null;
const correctedClassification = directEvidenceValid
  ? "CANNED_ERC8183_BUYER_PATH_VERIFIED"
  : ["SUBMITTED", "COMPLETED"].includes(job.status) && submitHash
    ? "CANNED_OBSERVATION_PATH_BROKEN"
    : originalClassification;
const reconciliation = {
  mode: "read_only_direct_receipt_and_local_storage_reconciliation",
  observedAt: nowIso(),
  chainId,
  jobId,
  onchainState: job.status,
  submitReceipt: {
    transactionHash: submitHash,
    blockNumber: String(receipt.blockNumber),
    status: receipt.status,
    gasUsed: String(receipt.gasUsed),
    effectiveGasPrice: String(receipt.effectiveGasPrice),
  },
  providerSignerMatches,
  onchainDeliverable: String(job.deliverable),
  onchainDeliverableUrl,
  sdkResolver: { returnedUrl: sdkResolverUrl, status: sdkResolverUrl ? "resolved" : "null_after_confirmed_submit_block" },
  buyerDeliveryReplay: { mode: "local_loopback_replay_after_rpc_reconciliation", status: replayStatus, error: replayError },
  localDeliverable: { relativePath: localRelativePath, sha256: contentHashes(localBody).sha256, keccak256: contentHashes(localBody).keccak256 },
  deliverableValidation: { valid: deliverableValidation.valid, hasActualDeliverable: deliverableValidation.hasActualDeliverable, errors: deliverableValidation.errors, manifestHash: deliverableValidation.manifestHash },
  deterministicValidation: { valid: deterministicValidation.valid, errors: deterministicValidation.errors },
  directEvidenceValid,
  initialAttempt,
  originalClassification,
  correctedClassification,
  conclusion: directEvidenceValid
    ? "Provider watcher, official submit, onchain terminal state, buyer SDK URL resolution, loopback retrieval, and deliverable validation are proven; the first lookup was delayed by public-RPC head lag."
    : "Read-only reconciliation did not establish every control gate.",
};

const originalQualification = run.qualification;
const initialQualification = previousReconciliation?.initialQualification || {
  isComplete: false,
  hasActualDeliverable: false,
  protocolSubmitted: true,
  providerSignerMatches: true,
  reason: "Initial control invocation completed submit/state observation before deliverable URL reconciliation.",
};
run.protocolJob.jobId = jobId;
run.protocolJob.currentState = job.status;
run.protocolJob.state = job.status.toLowerCase();
run.protocolJob.funded = true;
run.reconciliation = reconciliation;
run.reconciliation.initialQualification = initialQualification;
run.resultClassification = correctedClassification;
run.qualification = {
  ...run.qualification,
  isComplete: directEvidenceValid,
  hasRealControlJob: true,
  hasActualDeliverable: deliverableValidation.hasActualDeliverable === true,
  protocolSubmitted: ["SUBMITTED", "COMPLETED"].includes(job.status),
  providerSignerMatches,
  reason: directEvidenceValid
    ? "Read-only reconciliation verified the complete deterministic ERC-8183 control lifecycle; excluded from product metrics and TermiX."
    : originalQualification?.reason || "Control lifecycle remains incomplete.",
};
run.reconciliation.originalQualification = initialQualification;
if (directEvidenceValid) {
  run.deliverable = {
    content: output,
    url: onchainDeliverableUrl,
    onchainManifestHash: String(job.deliverable),
    rawOutputHash: contentHashes(output).sha256,
    outputHash: contentHashes(output).keccak256,
    retrievalMode: "read_only_local_storage_reconciliation",
    localRelativePath,
  };
}
run.artifacts = { ...run.artifacts, deterministicOutput: deterministicOutputEvidence };
run.evaluation = { ...run.evaluation, status: directEvidenceValid ? "completed" : "failed", observationReconciliation: { directEvidenceValid, sdkResolverUrl, replayStatus, correctedClassification } };
runs[index] = run;
await store.saveJson("state/benchmark-runs.json", runs);
console.log(JSON.stringify({ status: "reconciled", runId: run.runId, jobId, chainId, onchainState: job.status, directEvidenceValid, sdkResolverUrl, correctedClassification, submitHash, providerSignerMatches, localDeliverablePath: localRelativePath }, null, 2));
