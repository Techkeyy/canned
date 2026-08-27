import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { contentHashes } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { publicRebalanceBenchPacket, publicRebalanceBenchSource, rebalanceBenchAgentInput, rebalanceContainsSecretAnswer, validateRebalanceBenchAgentInput, REBALANCE_BENCHMARK_ID } from "../src/reference/rebalance-benchmark.mjs";
import { computeRebalanceGroundTruth } from "../src/reference/rebalance-evaluator.mjs";

/**
 * Prove the blind baseline cannot be contaminated before the human sees it.
 * Ground truth is computed here only to confirm that none of its values leak
 * into anything the browser can reach; it is never written to disk.
 */
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const definition = await store.loadJson("state/rebalancebench-v1.json", null);
if (!definition) { console.log(JSON.stringify({ status: "blocked", reason: "RebalanceBench v1 has not been frozen." }, null, 2)); process.exit(2); }

const baseline = await store.loadJson("state/rebalance-baseline.json", null);
const truth = computeRebalanceGroundTruth(definition);
const packet = publicRebalanceBenchPacket(definition);
const source = publicRebalanceBenchSource(definition);
const agentInput = rebalanceBenchAgentInput(definition);
const baselinePageHtml = await readFile(path.resolve(process.cwd(), "web/rebalance-baseline.html"), "utf8");

// Values a responder could copy instead of deriving. Generic tokens such as
// "false", "lower", or "small" are deliberately excluded: they occur in field
// labels and HTML tags, and flagging them would make the audit meaningless
// rather than strict.
const secretPhrases = [
  truth.decisionTruth.correctAction,                 // "HOLD" or "REBALANCE"
  truth.rangeTruth.status,                           // "IN_RANGE" / "OUT_OF_RANGE_*"
  truth.movementTruth?.directionRelativeToRange,     // "away from the lower edge"
  truth.decisionTruth.reason,
  truth.hashes.keccak256,
  ...(truth.proposedRangeTruth ? [String(truth.proposedRangeTruth.tickLower), String(truth.proposedRangeTruth.tickUpper)] : []),
].filter((value) => typeof value === "string" && value.length > 3);

// The contamination boundary is the *conclusion*, not arithmetic. The responder
// is legitimately given tickLower, tickUpper, and the current tick, so the
// distances between them are theirs to compute and hiding them would prove
// nothing. What must not appear is the verdict: whether to hold, how the range
// is classified, which way movement runs relative to the range, and any
// replacement ticks. Short derived integers are also unmatchable in practice,
// because a two-digit sequence occurs inside block hashes by chance.
const secretNumbers = [];

const leaksIn = (label, value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    surface: label,
    forbiddenKeys: rebalanceContainsSecretAnswer(typeof value === "string" ? {} : value),
    leakedValues: secretPhrases.filter((secret) => text.includes(secret)),
  };
};

const surfaces = [leaksIn("public_task_packet", packet), leaksIn("public_source_packet", source), leaksIn("agent_input", agentInput), leaksIn("baseline_page_html", baselinePageHtml)];
const contaminated = surfaces.filter((entry) => entry.forbiddenKeys || entry.leakedValues.length);

// The frozen definition must still reproduce its own precommit.
const { precommit, ...withoutPrecommit } = definition;
const recomputed = contentHashes(withoutPrecommit);
const precommitIntact = recomputed.sha256 === precommit.canonicalSha256 && recomputed.keccak256 === precommit.manifestKeccak256;

// No agent output may exist for this benchmark yet.
const runs = await store.loadRuns();
const rebalanceRuns = runs.filter((run) => run?.benchmark?.id === REBALANCE_BENCHMARK_ID);
const stateFiles = await readdir(path.join(dataDir, "state")).catch(() => []);
const agentArtifacts = stateFiles.filter((name) => /^rebalance(bench)?-(run|grading)/.test(name) || /^range-decisions\.json$/.test(name));
const decisions = (await store.loadJson("state/range-decisions.json", { decisions: [] })).decisions || [];

const sealIntact = baseline?.status !== "submitted"
  ? null
  : contentHashes(baseline.rawSubmissionJson).sha256 === baseline?.evidence?.sha256;

const report = {
  status: contaminated.length || !precommitIntact || rebalanceRuns.length || (sealIntact === false) ? "rebalance_baseline_audit_failed" : "rebalance_baseline_audit_passed",
  benchmarkId: REBALANCE_BENCHMARK_ID,
  benchmarkVersion: definition.version,
  referenceBlock: definition.referenceBlock,
  precommitIntact,
  agentInputMatchesFrozenDefinition: validateRebalanceBenchAgentInput({ definition, input: agentInput }).valid,
  baselineStatus: baseline?.status || "not_started",
  baselineSealIntact: sealIntact,
  groundTruthPersisted: stateFiles.includes("rebalance-ground-truth.json"),
  agentOutputExists: rebalanceRuns.length > 0,
  agentRunCount: rebalanceRuns.length,
  agentArtifactsPresent: agentArtifacts,
  trackRecordDecisions: decisions.length,
  surfacesChecked: surfaces.map((entry) => ({ surface: entry.surface, forbiddenKeys: entry.forbiddenKeys, leakedValues: entry.leakedValues })),
  contaminatedSurfaces: contaminated.map((entry) => entry.surface),
  secretPhrasesChecked: secretPhrases.length,
  boundaryNote: "Conclusions are withheld; tick arithmetic the responder can derive from the given bounds is not treated as a secret.",
  evaluatorVersion: truth.evaluatorVersion,
  note: "Ground truth is computed in memory for this audit and is never written to disk or served to the baseline client.",
  secretOutput: "none",
};
console.log(JSON.stringify(report, null, 2));
if (report.status !== "rebalance_baseline_audit_passed") process.exit(2);
