import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const stateDir = path.join(dataDir, "state");
const outputDir = path.resolve(process.env.CANNED_PUBLIC_TERMIX_DIR || path.join(process.cwd(), "evidence", "termix"));

const records = [
  {
    directory: "01-range-keeper",
    gradingFile: "rebalancebench-grading-run_08399351-0f8a-4888-bbe2-74b4ac68c086.json",
    role: "Trading Agent-vs-Control / ROI proof",
  },
  {
    directory: "02-health-guard",
    gradingFile: "healthbench-grading-run_9e0283a1-0f2f-4c88-850a-3f74fee9e558.json",
    role: "Agent-vs-Control + payment-flow proof",
  },
  {
    directory: "03-yield-scout",
    gradingFile: "yieldbench-grading-run_7fe9e15f-4001-428b-bd29-c687528127ee.json",
    role: "High-ROI optimization comparison",
  },
];

const sensitivePatterns = [
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /"(?:privateKey|mnemonic|password|accessToken|clientSecret|apiSecret|secretKey|walletKey)"\s*:\s*(?!null)/i,
  /(?:authorization|bearer)\s*[:=]\s*[A-Za-z0-9._-]{12,}/i,
  /(?:seed phrase|recovery phrase|keystore|pinata[_ -]?jwt|STORAGE_API_KEY)/i,
];

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function loadJson(relativePath) {
  return JSON.parse(await readFile(path.join(stateDir, relativePath), "utf8"));
}

async function sourceSha256(relativePath) {
  return sha256(await readFile(path.join(stateDir, relativePath)));
}

function scan(label, value) {
  for (const pattern of sensitivePatterns) {
    if (pattern.test(value)) throw new Error(`Sensitive material detected in ${label}; publication stopped.`);
  }
}

function cost(value) {
  return value ? {
    declaredOperatorCost: value.declaredOperatorCost ?? null,
    serviceFeeRaw: value.serviceFeeRaw ?? null,
    serviceFeeTokenDecimals: value.serviceFeeTokenDecimals ?? null,
    networkGasWei: value.networkGasWei ?? null,
  } : null;
}

function txs(run) {
  return (run?.protocolJob?.events || [])
    .filter((event) => event?.tx?.transactionHash)
    .map((event) => ({ event: event.event ?? null, transactionHash: event.tx.transactionHash }));
}

async function writeJson(relativePath, value) {
  const file = path.join(outputDir, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const runs = await loadJson("benchmark-runs.json");
const published = [];

for (const record of records) {
  const grading = await loadJson(record.gradingFile);
  const run = runs.find((candidate) => candidate.runId === grading.runId) || null;
  const folder = path.join(outputDir, record.directory);
  const task = String(grading.pair.task);
  const agentOutput = `${JSON.stringify(grading.agent.rawOutput, null, 2)}\n`;
  const controlOutput = String(grading.human.rawSubmission);
  scan(`${record.directory}/task.txt`, task);
  scan(`${record.directory}/agent-output.json`, agentOutput);
  scan(`${record.directory}/control-output.json`, controlOutput);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "task.txt"), task, "utf8");
  await writeFile(path.join(folder, "agent-output.json"), agentOutput, "utf8");
  await writeFile(path.join(folder, "control-output.json"), controlOutput, "utf8");

  const agentFile = `${record.directory}/agent-output.json`;
  const controlFile = `${record.directory}/control-output.json`;
  const metrics = {
    schemaVersion: 1,
    task: {
      runId: grading.runId,
      jobId: grading.jobId,
      benchmarkId: grading.benchmarkId,
      benchmarkVersion: grading.benchmarkVersion,
      category: grading.pair.category ?? null,
      role: record.role,
    },
    agent: {
      identity: grading.identity,
      elapsedMs: grading.agent.elapsedMs,
      cost: cost(grading.pair.withAgent.cost),
      qualityScore: grading.agent.score?.qualityScore ?? null,
      rawFile: agentFile,
      publishedSha256: sha256(agentOutput),
      canonicalRawSha256: grading.pair.withAgent.evidence?.sha256 ?? null,
    },
    control: {
      responder: grading.human.score?.responder ?? "human",
      elapsedMs: grading.human.elapsedMs,
      cost: cost(grading.pair.withoutAgent.cost),
      qualityScore: grading.human.score?.qualityScore ?? null,
      rawFile: controlFile,
      publishedSha256: sha256(controlOutput),
      canonicalRawSha256: grading.pair.withoutAgent.evidence?.sha256 ?? null,
    },
    comparison: grading.pair.comparison,
  };
  const provenance = {
    schemaVersion: 1,
    sourceType: "canonical-grading-record",
    sourceGradingRecord: `data/state/${record.gradingFile}`,
    sourceGradingRecordSha256: await sourceSha256(record.gradingFile),
    sourcePairSha256: grading.pair.hashes?.sha256 ?? null,
    sourcePairEvidence: grading.pairEvidence ?? null,
    runId: grading.runId,
    jobId: grading.jobId,
    benchmarkId: grading.benchmarkId,
    agentIdentity: grading.identity,
    provider: grading.provider ?? null,
    referenceBlock: grading.referenceBlock ?? null,
    evaluatorVersion: grading.evaluatorVersion ?? null,
    groundTruthHash: grading.pair.groundTruthHash ?? null,
    termix: grading.termix ?? null,
    verifiedRun: grading.verifiedRun ?? null,
    protocol: {
      protocol: run?.protocolJob?.protocol ?? null,
      network: run?.protocolJob?.network ?? null,
      paymentToken: run?.protocolJob?.paymentToken ?? null,
      currentState: run?.protocolJob?.currentState ?? null,
      transactions: txs(run),
    },
    publishedFiles: {
      task: `${record.directory}/task.txt`,
      agentOutput: { path: agentFile, sha256: sha256(agentOutput) },
      controlOutput: { path: controlFile, sha256: sha256(controlOutput) },
      metrics: `${record.directory}/metrics.json`,
      provenance: `${record.directory}/provenance.json`,
    },
  };
  await writeJson(`${record.directory}/metrics.json`, metrics);
  await writeJson(`${record.directory}/provenance.json`, provenance);
  if (record.directory === "02-health-guard") {
    const mpp = await readFile(path.join(stateDir, "mpp-payment-reconciliation.json"));
    scan("02-health-guard/mpp-proof.json", mpp.toString("utf8"));
    await writeFile(path.join(folder, "mpp-proof.json"), mpp);
  }
  published.push({ directory: record.directory, runId: grading.runId, jobId: grading.jobId, benchmarkId: grading.benchmarkId });
}

console.log(JSON.stringify({ status: "public_termix_evidence_built", outputDir, filesPerTask: 5, tasks: published }, null, 2));
