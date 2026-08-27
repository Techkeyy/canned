import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, contentHashes } from "../src/core.mjs";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const baselinePath = path.join(dataDir, "state", "health-baseline.json");
const benchmarkPath = path.join(dataDir, "state", "healthbench-v1.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8"));
const expectedSha256 = "sha256:fcf1aac042a7d8a8056e348a46f9975cbb37f8a2f608833c63cc4762ce46fd66";
const expectedKeccak = "0x12f1df56926836628fd21fbcfb81c1fd2ff869938d34adb94049f43fb3b5c4cd";
const fields = ["positionFacts", "liquidationProximity", "changeExplanation", "boundedAction", "reasoningNotes"];
if (baseline.status !== "submitted") throw new Error("Human baseline is not sealed as submitted.");
if (baseline.benchmarkId !== benchmark.benchmarkId || benchmark.benchmarkId !== "HealthBench_v1") throw new Error("Human baseline benchmark ID does not match HealthBench v1.");
if (benchmark.precommit?.canonicalSha256 !== expectedSha256 || benchmark.precommit?.manifestKeccak256 !== expectedKeccak) throw new Error("Frozen HealthBench precommit does not match the approved checkpoint.");
if (!baseline.startedAt || !baseline.finishedAt || !baseline.submittedAt || !Number.isFinite(Number(baseline.elapsedMs)) || Number(baseline.elapsedMs) < 0) throw new Error("Human baseline timing is incomplete.");
const timestampElapsed = Date.parse(baseline.finishedAt) - Date.parse(baseline.startedAt);
if (!Number.isFinite(timestampElapsed) || Math.abs(Number(baseline.elapsedMs) - timestampElapsed) > 2_000) throw new Error("Human baseline elapsed time is not consistent with server timestamps.");
if (fields.some((field) => !Object.prototype.hasOwnProperty.call(baseline.submission || {}, field))) throw new Error("Human baseline is missing a required submitted field.");
if (baseline.agentOutput !== null || baseline.groundTruth !== null) throw new Error("Human baseline was not isolated from agent output or ground truth before sealing.");
if (typeof baseline.rawSubmissionJson !== "string" || !baseline.rawSubmissionJson.length) throw new Error("The exact raw human submission is missing.");
let rawSubmission;
try { rawSubmission = JSON.parse(baseline.rawSubmissionJson); } catch { throw new Error("The exact raw human submission is not valid JSON."); }
if (canonicalJson(rawSubmission) !== canonicalJson(baseline.submission)) throw new Error("The exact raw human submission does not match the preserved parsed submission.");

const rawHashes = contentHashes(baseline.rawSubmissionJson);
const submissionHashes = contentHashes(baseline.submission);
const evidenceDir = path.join(dataDir, "evidence", "healthbench-v1", "human-baseline");
const rawPath = path.join(evidenceDir, `${rawHashes.sha256.slice("sha256:".length)}.json`);
const manifestPath = path.join(evidenceDir, "manifest.json");
await mkdir(evidenceDir, { recursive: true });
async function writeImmutable(filePath, content) {
  try {
    const existing = await readFile(filePath, "utf8");
    if (existing !== content) throw new Error(`Immutable evidence already exists with different content: ${path.basename(filePath)}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  await chmod(filePath, 0o600);
}
await writeImmutable(rawPath, baseline.rawSubmissionJson);
const manifest = {
  schemaVersion: 1,
  kind: "healthbench_human_baseline_evidence",
  immutable: true,
  benchmarkId: benchmark.benchmarkId,
  benchmarkVersion: benchmark.version,
  precommit: benchmark.precommit,
  policy: benchmark.task,
  attemptId: baseline.attemptId,
  startedAt: baseline.startedAt,
  finishedAt: baseline.finishedAt,
  submittedAt: baseline.submittedAt,
  elapsedMs: Number(baseline.elapsedMs),
  fields,
  rawSubmission: { contentType: "application/json", relativePath: path.relative(dataDir, rawPath), ...rawHashes },
  parsedSubmission: { ...submissionHashes },
  preservationStatus: "exact_raw_response_preserved_content_addressed",
  evaluationStatus: "sealed_before_evaluation",
  agentOutputBeforeSubmission: false,
  groundTruthBeforeSubmission: false,
};
await writeImmutable(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ status: "human_baseline_sealed", benchmarkId: benchmark.benchmarkId, attemptId: baseline.attemptId, submittedAt: baseline.submittedAt, elapsedMs: Number(baseline.elapsedMs), evidenceSha256: rawHashes.sha256, evidenceKeccak256: rawHashes.keccak256, manifestSha256: contentHashes(manifest).sha256, rawEvidencePath: path.relative(process.cwd(), rawPath), manifestPath: path.relative(process.cwd(), manifestPath), preservation: "exact_raw_response_preserved", evaluation: "not_started", secretOutput: "none" }, null, 2));
