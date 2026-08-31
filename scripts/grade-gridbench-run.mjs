/**
 * Grade the deliverable a paid GridBench job actually produced.
 *
 * This grades what arrived, not what the engine can do locally. Those are
 * different claims, and conflating them is exactly how a benchmark result
 * stops meaning anything: an agent that scores well in a unit test but
 * delivers nothing to a paying buyer has not demonstrated the capability the
 * buyer paid for.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { buildGridBenchmarkDefinition } from "../src/reference/grid-benchmark.mjs";
import { computeGridGroundTruth, gradeGridBenchResponse } from "../src/reference/grid-evaluator.mjs";
import { contentHashes, nowIso } from "../src/core.mjs";

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const stateDir = path.join(dataDir, "state");
const runId = process.argv[2] || null;

const files = (await readdir(stateDir)).filter((name) => name.startsWith("gridbench-run-") && name.endsWith(".json"));
const target = runId ? files.find((name) => name.includes(runId)) : files.sort().at(-1);
if (!target) { console.log(JSON.stringify({ status: "blocked", reason: "No GridBench paid run record was found." }, null, 2)); process.exit(2); }

const run = JSON.parse(await readFile(path.join(stateDir, target), "utf8"));
const definition = buildGridBenchmarkDefinition();
const groundTruth = computeGridGroundTruth(definition);
const delivered = run.deliverable?.rawOutput ?? null;

// A deliverable that never arrived is not a low score, it is an absent answer.
// Reporting it as 0/100 would imply the agent answered badly; it did not
// answer at all, and the record has to say which.
const deliveryFailed = !delivered || typeof delivered !== "object" || !delivered.answers;

const grading = deliveryFailed
  ? null
  : gradeGridBenchResponse({ definition, groundTruth, submission: { answers: delivered.answers } });

const record = {
  entity: "GridBenchPaidRunGrading",
  runId: run.runId,
  jobId: run.jobId,
  benchmarkId: definition.benchmarkId,
  precommit: definition.precommit,
  agent: { name: "Canned Grid Keeper", identity: run.identity, provider: run.provider },
  chainState: run.chainState,
  terminalState: run.terminalState,
  paid: { serviceFeeRaw: run.economics?.serviceFeeRaw ?? null, buyerGasWei: run.economics?.buyerGasWei ?? null },
  deliverable: {
    cid: run.deliverable?.cid ?? null,
    reference: run.deliverable?.reference ?? null,
    valid: run.deliverable?.validation?.valid ?? false,
    errors: run.deliverable?.validation?.errors ?? [],
  },
  deliveryFailed,
  outcome: deliveryFailed ? "not_gradable_no_answers_delivered" : "graded",
  qualityScore: grading?.qualityScore ?? null,
  scenarioCount: definition.scenarios.length,
  passedCount: grading?.passedCount ?? null,
  results: grading?.results?.map(({ scenarioId, passed, detail }) => ({ scenarioId, passed, detail })) ?? null,
  evaluator: { version: groundTruth.evaluatorVersion, groundTruthSource: groundTruth.computedFrom, llmGraded: false },
  note: deliveryFailed
    ? "The paid job settled on chain but the provider submitted an empty deliverable, so there were no answers to grade. This is a delivery failure, not a wrong answer, and it is recorded as such."
    : "Graded mechanically against ground truth recomputed from the frozen specification.",
  gradedAt: nowIso(),
};
await writeFile(path.join(stateDir, `gridbench-grading-${run.runId}.json`), JSON.stringify({ ...record, hashes: contentHashes(record) }, null, 2) + "\n", "utf8");
console.log(JSON.stringify(record, null, 2));
