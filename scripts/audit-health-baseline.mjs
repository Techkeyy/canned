import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const baselinePath = path.join(dataDir, "state", "health-baseline.json");
const sourcePath = path.resolve(process.cwd(), "src", "server.mjs");
const formPath = path.resolve(process.cwd(), "web", "health-baseline.html");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const submittedAt = Date.parse(baseline.submittedAt);
const files = [];
async function collect(directory) {
  let entries = [];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filePath);
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(filePath);
  }
}
await collect(path.join(dataDir, "runs"));
await collect(path.join(dataDir, "state"));

function benchmarkIdPresent(value, skipKey = null) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === skipKey || key === "rawSubmissionJson" || key === "submission") continue;
    if (key === "benchmarkId" && child === "HealthBench_v1") return true;
    if (benchmarkIdPresent(child)) return true;
  }
  return false;
}
function nonNullSensitiveKey(value, names) {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (key === "rawSubmissionJson" || key === "submission") continue;
    if (names.has(key) && child !== null && child !== undefined) return true;
    if (nonNullSensitiveKey(child, names)) return true;
  }
  return false;
}
const healthRecords = [];
const preSubmissionHealthRecords = [];
let nonNullAgentBeforeSubmission = false;
let nonNullGroundTruthBeforeSubmission = false;
for (const filePath of files) {
  let parsed;
  try { parsed = JSON.parse(await readFile(filePath, "utf8")); } catch { continue; }
  if (!benchmarkIdPresent(parsed)) continue;
  const relative = path.relative(process.cwd(), filePath);
  healthRecords.push(relative);
  const timestamps = [parsed.createdAt, parsed.startedAt, parsed.submittedAt, parsed.finishedAt].map((value) => Date.parse(value)).filter(Number.isFinite);
  const beforeSubmission = timestamps.length > 0 && Math.min(...timestamps) < submittedAt;
  if (beforeSubmission) {
    preSubmissionHealthRecords.push(relative);
    nonNullAgentBeforeSubmission ||= nonNullSensitiveKey(parsed, new Set(["agentOutput", "agentResult", "agentDeliverable"]));
    nonNullGroundTruthBeforeSubmission ||= nonNullSensitiveKey(parsed, new Set(["groundTruth", "evaluatorResult", "expectedAnswer"]));
  }
}
const source = await readFile(sourcePath, "utf8");
const form = await readFile(formPath, "utf8");
const requiredFields = ["positionFacts", "liquidationProximity", "changeExplanation", "boundedAction", "reasoningNotes"];
const prefilledFields = requiredFields.filter((field) => {
  const match = form.match(new RegExp(`<textarea\\s+name=["']${field}["'][^>]*>([\\s\\S]*?)<\\/textarea>`, "i"));
  return Boolean(match?.[1]?.trim());
});
console.log(JSON.stringify({ status: "health_baseline_audited", baselineStatus: baseline.status, benchmarkId: baseline.benchmarkId, healthRecordCount: healthRecords.length, preSubmissionHealthRecordCount: preSubmissionHealthRecords.length, preSubmissionHealthRecords, nonNullAgentBeforeSubmission, nonNullGroundTruthBeforeSubmission, baselineTaskRouteGuardPresent: source.includes("HealthBench human baseline must be submitted before any benchmark-bound agent result is exposed."), prefilledFields, baselineAgentOutputNull: baseline.agentOutput === null, baselineGroundTruthNull: baseline.groundTruth === null, secretOutput: "none" }, null, 2));
