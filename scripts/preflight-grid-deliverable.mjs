/**
 * Prove the Grid deliverable fix before spending again.
 *
 * Paid job 835 settled on chain having submitted nothing, because the runtime
 * reads `result.output` and the builder returned the deliverable directly.
 * That cost 0.001 U. This runs the exact production path end to end without
 * funding anything, and refuses to pass unless the deliverable survives the
 * same JSON boundary IPFS puts it through and the same validator the buyer
 * will use.
 *
 * Nothing here signs, sends, or spends.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildGridBenchmarkDefinition, publicGridBenchPacket, GRID_BENCHMARK_ID } from "../src/reference/grid-benchmark.mjs";
import { buildGridBenchDeliverable, buildGridKeeperDeliverable, gridTaskResult } from "../src/reference/grid-keeper.mjs";
import { computeGridGroundTruth, gradeGridBenchResponse } from "../src/reference/grid-evaluator.mjs";
import { validateSubmittedDeliverable, extractProviderDeliverable } from "../src/benchmark/validation.mjs";
import { contentHashes, nowIso } from "../src/core.mjs";

const OUTPUT_FIELDS = ["benchmarkId", "benchmarkPrecommit", "strategy", "levels", "answers", "execution", "executionModel"];
const JOB_ID = 999999; // not a real job; nothing is created
const definition = buildGridBenchmarkDefinition();
const failures = [];
const check = (name, ok, detail = null) => { if (!ok) failures.push({ check: name, detail }); return ok; };

// 1. The production task shape, exactly as the watcher's taskResolver builds it.
const task = { benchmarkId: definition.benchmarkId, precommit: definition.precommit, packet: publicGridBenchPacket(definition) };
check("task_is_gridbench", task.benchmarkId === GRID_BENCHMARK_ID);

// 2. The production task handler, including the service-boundary adapter.
const result = gridTaskResult(
  task.benchmarkId === GRID_BENCHMARK_ID
    ? buildGridBenchDeliverable({ jobId: JOB_ID, task, definition })
    : buildGridKeeperDeliverable({ jobId: JOB_ID, task }),
);

check("result_ok", result.ok === true, result.status);
check("result_status_delivered", result.status === "delivered", result.status);
check("output_not_null", result.output !== null && result.output !== undefined);
check("canonical_not_null", result.canonicalOutput !== null && result.canonicalOutput !== undefined);
check("canonical_not_empty", typeof result.canonicalOutput === "string" && result.canonicalOutput.length > 1000, result.canonicalOutput?.length);

// 3. The JSON boundary IPFS puts it through. A BigInt anywhere in the tree
//    throws here rather than at submission time, which is when it costs money.
let roundTripped = null;
try {
  const serialised = JSON.stringify(result.output);
  roundTripped = JSON.parse(serialised);
  check("json_serialisable", true);
  check("round_trip_stable", JSON.stringify(roundTripped) === serialised);
} catch (error) {
  check("json_serialisable", false, error.message);
}

// 4. The provider wraps the output in an ERC-8183 response envelope. This is
//    the shape the buyer actually fetches from IPFS.
const envelope = {
  version: 1,
  job_id: JOB_ID,
  chain_id: 97,
  contracts: { commerce: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE" },
  response: { content: result.canonicalOutput, content_type: "application/json" },
  metadata: { origin: "CANNED_REFERENCE_GRID_TRADING_V1", referenceOrigin: "CANNED_REFERENCE", taskVersion: "grid" },
};
check("envelope_content_present", envelope.response.content !== null && envelope.response.content !== undefined);

// 5. The same buyer-side validator the paid path uses.
const validation = validateSubmittedDeliverable({ body: envelope, jobId: JOB_ID, onchainDeliverable: null, expectedOutputFields: OUTPUT_FIELDS });
const agentOutput = extractProviderDeliverable(envelope).output;

check("validator_extracted_output", agentOutput !== null && typeof agentOutput === "object");
check("bound_to_benchmark", String(agentOutput?.benchmarkId ?? "") === definition.benchmarkId);
check("bound_to_precommit", String(agentOutput?.benchmarkPrecommit?.sha256 ?? "") === definition.precommit.sha256);
check("answers_present", definition.scenarios.every((scenario) => agentOutput?.answers?.[scenario.id] !== undefined));
check("levels_strictly_increasing", Array.isArray(agentOutput?.levels) && agentOutput.levels.every((level, index) => index === 0 || BigInt(level.priceMinor) > BigInt(agentOutput.levels[index - 1].priceMinor)));
check("claims_no_swap", agentOutput?.execution?.capitalMoved === false && Number(agentOutput?.execution?.onchainSwapsPerformed) === 0 && agentOutput?.execution?.altanaSessionUsed === false);
check("not_native_limit_order", agentOutput?.executionModel?.isNativeLimitOrder === false);
check("no_order_id", !/"order(Id|_id)"/i.test(JSON.stringify(agentOutput ?? {})));
check("validator_errors_empty", (validation.errors || []).length === 0, validation.errors);

// 6. GridBench must be able to grade what came out the other side.
const groundTruth = computeGridGroundTruth(definition);
const grading = agentOutput?.answers ? gradeGridBenchResponse({ definition, groundTruth, submission: { answers: agentOutput.answers } }) : null;
check("gradable", grading !== null);
check("grading_covers_every_scenario", grading?.scenarioCount === definition.scenarios.length);

const record = {
  entity: "GridDeliverablePreflight",
  purpose: "Prove the runtime output contract before funding another paid job.",
  fundsSpent: "none",
  transactionsSent: 0,
  benchmarkId: definition.benchmarkId,
  precommit: definition.precommit,
  runtimeContract: {
    ok: result.ok,
    status: result.status,
    outputPresent: result.output !== null && result.output !== undefined,
    canonicalOutputBytes: result.canonicalOutput?.length ?? 0,
  },
  jsonBoundary: { serialisable: roundTripped !== null, roundTripStable: roundTripped !== null },
  validation: { valid: (validation.errors || []).length === 0, errors: validation.errors || [] },
  grading: grading ? { scenarioCount: grading.scenarioCount, passedCount: grading.passedCount, qualityScore: grading.qualityScore } : null,
  failures,
  passed: failures.length === 0,
  checkedAt: nowIso(),
};
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
await mkdir(path.join(dataDir, "state"), { recursive: true });
await writeFile(path.join(dataDir, "state", "grid-deliverable-preflight.json"), JSON.stringify({ ...record, hashes: contentHashes(record) }, null, 2) + "\n", "utf8");
console.log(JSON.stringify(record, null, 2));
if (!record.passed) process.exit(2);
