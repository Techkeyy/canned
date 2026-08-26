import { canonicalJson, contentHashes, nowIso } from "../core.mjs";
import { RUN_TYPES } from "../domain.mjs";

export const CONTROL_RUN_TYPE = RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL;
export const CONTROL_IDENTITY = "CANNED_PROTOCOL_CONTROL";
export const CONTROL_BENCHMARK = Object.freeze({
  id: "erc8183-protocol-control",
  version: "1.0.0",
  category: "infrastructure_control",
  task: "Use the official ERC-8183 provider watcher to compute the sum of a precommitted number list and submit the result onchain.",
  control: { id: "no-llm-deterministic-v1", description: "Deterministic local computation; no LLM, capital movement, or marketplace behavior." },
});

export function deterministicControlOutput({ input, jobId, provider }) {
  const numbers = Array.isArray(input?.numbers) ? input.numbers : [];
  if (numbers.length === 0 || numbers.some((value) => !Number.isSafeInteger(value))) {
    throw new Error("Control input must contain a non-empty array of safe integer numbers.");
  }
  const inputHash = contentHashes(input).sha256;
  return {
    jobId: Number(jobId),
    input: numbers,
    inputHash,
    count: numbers.length,
    sum: numbers.reduce((total, value) => total + value, 0),
    algorithm: "integer-sum-v1",
    provider,
  };
}

export function controlResponseContent(output) {
  return canonicalJson(output);
}

export function validateDeterministicControl({ output, expectedInput, expectedJobId, expectedProvider }) {
  const errors = [];
  const expected = deterministicControlOutput({ input: expectedInput, jobId: expectedJobId, provider: expectedProvider });
  if (!output || typeof output !== "object" || Array.isArray(output)) errors.push("output_not_object");
  if (Number(output?.jobId) !== Number(expectedJobId)) errors.push("job_id_mismatch");
  if (String(output?.provider || "").toLowerCase() !== String(expectedProvider || "").toLowerCase()) errors.push("provider_mismatch");
  if (JSON.stringify(output?.input) !== JSON.stringify(expected.input)) errors.push("input_mismatch");
  if (output?.inputHash !== expected.inputHash) errors.push("input_hash_mismatch");
  if (output?.count !== expected.count) errors.push("count_mismatch");
  if (output?.sum !== expected.sum) errors.push("sum_mismatch");
  if (output?.algorithm !== expected.algorithm) errors.push("algorithm_mismatch");
  return { valid: errors.length === 0, errors, expected, output };
}

export function buildControlQualification({ protocolJob, deliverableValidation, providerSignerMatches = false } = {}) {
  const submitted = ["SUBMITTED", "COMPLETED"].includes(protocolJob?.currentState);
  const valid = deliverableValidation?.valid === true;
  return {
    isInfrastructureProtocolControl: true,
    excludedFromProductMetrics: true,
    isFixture: false,
    isInfrastructureSmokeTest: false,
    isComplete: submitted && valid && providerSignerMatches,
    hasRealControlJob: Boolean(protocolJob?.jobId),
    hasActualDeliverable: valid,
    hasOnchainProvenance: Boolean(protocolJob?.events?.some((event) => event.tx?.transactionHash || event.snapshot?.status)),
    hasPrecommit: Boolean(protocolJob?.precommitHash),
    providerSignerMatches,
    protocolSubmitted: submitted,
    publicMetricsEligible: false,
    termixEligible: false,
    reason: submitted && valid && providerSignerMatches ? "Known-good control seller reached SUBMITTED with a validated deliverable." : "Control seller did not satisfy every FUNDED-to-SUBMITTED validation gate.",
  };
}

export function lifecyclePhaseSummary(protocolJob) {
  const events = protocolJob?.events || [];
  const txFor = (name) => events.find((event) => event.event === name)?.tx?.transactionHash || null;
  const snapshotFor = (name) => events.find((event) => event.event === name)?.snapshot?.status || null;
  const notify = events.find((event) => event.event === "notify_funded");
  const submit = events.find((event) => event.event === "provider_submit_result");
  return {
    create: txFor("create_job") ? "succeeded" : "not observed",
    register: txFor("register_job") ? "succeeded" : "not observed",
    budget: txFor("set_budget") ? "succeeded" : "not observed",
    fund: txFor("fund_job") ? "succeeded" : "not observed",
    providerDetected: events.some((event) => event.event === "provider_detected"),
    notification: notify ? (notify.accepted === true ? "accepted" : "rejected") : "not used",
    providerWork: events.some((event) => event.event === "provider_work_completed"),
    submitTx: submit?.result?.txHash || null,
    submitted: ["SUBMITTED", "COMPLETED"].includes(protocolJob?.currentState) || Boolean(snapshotFor("chain_state_observed") === "SUBMITTED"),
    deliverable: events.some((event) => event.event === "deliverable_observed") ? "validated or attempted" : "not observed",
  };
}

export function buildInfrastructureControlRun({ runId, precommit, protocolJob, provider, quote, readiness, deliverable, validation, qualification, economics, lifecycle, createdAt = nowIso() }) {
  return {
    kind: "infrastructure_control_run",
    runId,
    runType: CONTROL_RUN_TYPE,
    provenance: { mode: "INFRASTRUCTURE_CONTROL", fixture: false, infrastructureSmokeTest: false, productMetricsExcluded: true },
    agent: { identity: CONTROL_IDENTITY, name: CONTROL_IDENTITY, category: CONTROL_BENCHMARK.category },
    benchmark: CONTROL_BENCHMARK,
    manifest: { hash: precommit.manifestHash, offchainContentHash: precommit.offchainContentHash, level: "offchain_content_addressed", publicPrecommitAnchor: "control_job.description" },
    protocolJob,
    controlSeller: { providerAddress: provider.address, network: "bsc-testnet", chainId: 97, sdk: "@bnbagent/sdk", sdkVersion: "0.5.4", watcher: "fundedJobWatcher", providerOps: "ERC8183JobOps", storage: "LocalStorageProvider + loopback delivery endpoint", readiness },
    quote: { price: String(quote.price), currency: quote.currency, negotiationHash: quote.negotiationHash, signed: quote.signed === true },
    deliverable: deliverable || null,
    deliverableValidation: validation || null,
    lifecycle,
    economics,
    qualification,
    createdAt,
  };
}
