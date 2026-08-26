import { id, canonicalJson, contentHashes, nowIso } from "../core.mjs";
import { publicMetrics, RUN_TYPES, terminalStateFor } from "../domain.mjs";
import { evaluateBenchmark } from "./definitions.mjs";

export function createPrecommitManifest({ runId = id("run"), agent, benchmark, input, limits, startAt = nowIso(), deadlineAtUnixSeconds, runType = RUN_TYPES.BENCHMARK, provenanceMode = "LIVE_CANDIDATE" }) {
  const inputHash = contentHashes(input);
  const controlHash = contentHashes(benchmark.control);
  const body = {
    schemaVersion: 1,
    runId,
    runType,
    provenanceMode,
    benchmarkId: benchmark.id,
    benchmarkVersion: benchmark.version,
    category: benchmark.category,
    agentIdentity: agent.identity,
    agentEndpoint: agent.services?.find((service) => service.type.toLowerCase().includes("a2a"))?.endpoint || agent.services?.[0]?.endpoint || null,
    task: benchmark.task,
    taskInput: input,
    taskInputHash: inputHash.keccak256,
    control: benchmark.control,
    controlHash: controlHash.keccak256,
    limits,
    startAt,
    deadlineAtUnixSeconds,
    evaluatorVersion: "canned-deterministic-v1",
  };
  const hashes = contentHashes(body);
  return {
    ...body,
    manifestHash: hashes.keccak256,
    offchainContentHash: hashes.sha256,
    evidenceLevel: "offchain_content_addressed",
    publicPrecommitAnchor: "none_until_associated_with_an_onchain_job_transaction",
  };
}

export async function runBenchmark({ agent, benchmark, input, agentOutput, controlOutput, store, runType = RUN_TYPES.BENCHMARK, provenanceMode = "LIVE_CANDIDATE", qualification = {}, executionStatus }) {
  const runId = id("run");
  const manifest = createPrecommitManifest({ runId, agent, benchmark, input, limits: input.limits || {}, deadlineAtUnixSeconds: input.deadlineAtUnixSeconds || Math.floor(Date.now() / 1000) + 900, runType, provenanceMode });
  const manifestEvidence = await store.saveEvidence(manifest);
  const agentEvidence = await store.saveEvidence({ kind: "agent_output", runId, output: agentOutput });
  const controlEvidence = await store.saveEvidence({ kind: "control_output", runId, output: controlOutput });
  const evaluation = evaluateBenchmark({ benchmark, input, agentOutput, controlOutput });
  const terminalState = terminalStateFor({ executionStatus, evaluationStatus: evaluation.status });
  const run = {
    kind: "benchmark_run",
    runId,
    runType,
    provenance: {
      mode: provenanceMode,
      fixture: runType === RUN_TYPES.FIXTURE,
      infrastructureSmokeTest: runType === RUN_TYPES.INFRASTRUCTURE_SMOKE_TEST,
    },
    agent: { identity: agent.identity, name: agent.name, category: benchmark.category },
    benchmark: { id: benchmark.id, version: benchmark.version, category: benchmark.category, task: benchmark.task, control: benchmark.control },
    manifest: { hash: manifest.manifestHash, offchainContentHash: manifest.offchainContentHash, evidence: manifestEvidence, level: manifest.evidenceLevel, publicPrecommitAnchor: manifest.publicPrecommitAnchor },
    artifacts: { agentOutput: agentEvidence, controlOutput: controlEvidence },
    evaluation,
    terminalState,
    protocolJob: null,
    qualification: { allGatesPassed: qualification.allGatesPassed === true, ...qualification },
    createdAt: nowIso(),
  };
  await store.saveRun(run);
  return run;
}

export async function metricsFromStore(store) {
  return publicMetrics(await store.loadRuns());
}
