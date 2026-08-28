import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { contentHashes } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { publicYieldBenchPacket, publicYieldBenchSource, yieldBenchAgentInput, yieldContainsSecretAnswer, validateYieldBenchAgentInput, YIELD_BENCHMARK_ID } from "../src/reference/yield-benchmark.mjs";
import { computeYieldGroundTruth } from "../src/reference/yield-evaluator.mjs";

/**
 * Prove the blind baseline cannot be contaminated before the human sees it.
 * Ground truth is computed here only to confirm that none of its values leak
 * into anything the browser can reach; it is never written to disk.
 */
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const definition = await store.loadJson("state/yieldbench-v1.json", null);
if (!definition) { console.log(JSON.stringify({ status: "blocked", reason: "YieldBench v1 has not been frozen." }, null, 2)); process.exit(2); }

const baseline = await store.loadJson("state/yield-baseline.json", null);
const truth = computeYieldGroundTruth(definition);
const packet = publicYieldBenchPacket(definition);
const source = publicYieldBenchSource(definition);
const agentInput = yieldBenchAgentInput(definition);
const baselinePageHtml = await readFile(path.resolve(process.cwd(), "web/yield-baseline.html"), "utf8");

// Values a responder could copy instead of deriving. Generic tokens such as
// "false", "lower", or "small" are deliberately excluded: they occur in field
// labels and HTML tags, and flagging them would make the audit meaningless
// rather than strict.
// The contamination boundary is the *conclusion*, not the option list.
//
// Every candidate asset must be shown to the responder, so naming FDUSD is not a
// leak; recommending it would be. Likewise the declared scoring tolerances are
// public by design, so the `methodology` subtree is excluded from the key scan
// rather than flagged for containing a key called breakEvenDays.
const secretPhrases = [
  truth.decisionTruth.correctAction,   // "MOVE" or "HOLD"
  truth.decisionTruth.reason,          // the policy's stated justification
  truth.hashes.keccak256,
].filter((value) => typeof value === "string" && value.length > 3);

const withoutDeclaredMethodology = (value) => {
  if (!value || typeof value !== "object") return value;
  const { methodology, ...rest } = value;
  return rest;
};

const leaksIn = (label, value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    surface: label,
    forbiddenKeys: yieldContainsSecretAnswer(typeof value === "string" ? {} : withoutDeclaredMethodology(value)),
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
const yieldRuns = runs.filter((run) => run?.benchmark?.id === YIELD_BENCHMARK_ID);
const stateFiles = await readdir(path.join(dataDir, "state")).catch(() => []);
const agentArtifacts = stateFiles.filter((name) => /^yield(bench)?-(run|grading)/.test(name) || /^yield-decisions\.json$/.test(name));
const decisions = (await store.loadJson("state/yield-decisions.json", { decisions: [] })).decisions || [];

const sealIntact = baseline?.status !== "submitted"
  ? null
  : contentHashes(baseline.rawSubmissionJson).sha256 === baseline?.evidence?.sha256;

const report = {
  status: contaminated.length || !precommitIntact || yieldRuns.length || (sealIntact === false) ? "yield_baseline_audit_failed" : "yield_baseline_audit_passed",
  benchmarkId: YIELD_BENCHMARK_ID,
  benchmarkVersion: definition.version,
  referenceBlock: definition.referenceBlock,
  precommitIntact,
  agentInputMatchesFrozenDefinition: validateYieldBenchAgentInput({ definition, input: agentInput }).valid,
  baselineStatus: baseline?.status || "not_started",
  baselineSealIntact: sealIntact,
  groundTruthPersisted: stateFiles.includes("yield-ground-truth.json"),
  agentOutputExists: yieldRuns.length > 0,
  agentRunCount: yieldRuns.length,
  agentArtifactsPresent: agentArtifacts,
  trackRecordDecisions: decisions.length,
  surfacesChecked: surfaces.map((entry) => ({ surface: entry.surface, forbiddenKeys: entry.forbiddenKeys, leakedValues: entry.leakedValues })),
  contaminatedSurfaces: contaminated.map((entry) => entry.surface),
  secretPhrasesChecked: secretPhrases.length,
  boundaryNote: "Conclusions are withheld. The candidate option list and the declared scoring tolerances are public by design and are not treated as leaks.",
  evaluatorVersion: truth.evaluatorVersion,
  note: "Ground truth is computed in memory for this audit and is never written to disk or served to the baseline client.",
  secretOutput: "none",
};
console.log(JSON.stringify(report, null, 2));
if (report.status !== "yield_baseline_audit_passed") process.exit(2);
