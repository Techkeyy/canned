import { contentHashes, id, nowIso } from "../core.mjs";
import { CATEGORIES } from "../domain.mjs";
import { validateAuthoritativeVenusSnapshot } from "./venus.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ORIGIN } from "./constants.mjs";

export const HEALTH_BENCHMARK_ID = "HealthBench_v1";
export const HEALTH_BENCHMARK_VERSION = "1.0.0";
export const HEALTH_EVALUATOR_VERSION = "health-factor-deterministic-v1";

const REQUIRED_HUMAN_FIELDS = Object.freeze([
  "positionFacts",
  "liquidationProximity",
  "changeExplanation",
  "boundedAction",
  "reasoningNotes",
]);

function assertSnapshot(snapshot) {
  const result = validateAuthoritativeVenusSnapshot(snapshot);
  if (!result.valid) throw new Error(`HealthBench requires an authoritative Venus snapshot: ${result.errors.join(", ")}`);
  if (!snapshot.asOfBlock || !snapshot.blockHash || !snapshot.blockTimestamp) throw new Error("HealthBench requires a frozen block number, block hash, and timestamp.");
}

export function createHealthBenchDefinition({ snapshot, account, createdAt = nowIso(), sourceUrls = [], priorSnapshot = null } = {}) {
  assertSnapshot(snapshot);
  if (String(snapshot.account).toLowerCase() !== String(account || snapshot.account).toLowerCase()) throw new Error("HealthBench account does not match the frozen snapshot.");
  const definition = {
    kind: "health_benchmark_definition",
    benchmarkId: HEALTH_BENCHMARK_ID,
    version: HEALTH_BENCHMARK_VERSION,
    category: CATEGORIES.HEALTH_FACTOR_MONITORING,
    origin: REFERENCE_ORIGIN,
    immutable: true,
    createdAt,
    chain: { network: "bsc-testnet", chainId: REFERENCE_CHAIN_ID },
    position: { account: snapshot.account, protocol: "Venus", poolType: snapshot.poolType },
    task: {
      question: "Read the frozen Venus position, describe its liquidation proximity and changes from the prior snapshot, and state one bounded protective action. Do not move capital.",
      expectedOutputSchema: REQUIRED_HUMAN_FIELDS,
      permittedInformationSources: ["the frozen raw Venus snapshot served by the baseline flow", "the cited official Venus documentation", "the cited onchain contract reads"],
      prohibitedAssistance: ["Canned Health Guard output", "any LLM or automated answer generator", "any evaluator or ground-truth result", "an answer copied from another attempt"],
    },
    frozenEvidence: { snapshot, priorSnapshot },
    controls: {
      method: "Independent deterministic protocol-read control using the same frozen evidence; it is not the human baseline.",
      humanBaseline: { required: true, outputPreservedVerbatim: true, noAutoCorrection: true },
      agent: { sameFrozenEvidence: true, automaticActionTaken: false },
    },
    sources: { sourceUrls, officialVenusDeploymentSource: snapshot.readPlan?.contracts ? "https://raw.githubusercontent.com/VenusProtocol/venus-protocol-documentation/main/deployed-contracts/markets.md" : null },
    methodology: {
      timing: "Server records start and finish timestamps; elapsed time is calculated from the server clock.",
      cost: "Human declares external cost; Canned records the paid agent fee and actual network receipts after the continuation run.",
      scoring: "Deterministic evaluator version is pinned; no result is exposed until the human baseline is submitted.",
      tolerances: { rawProtocolFields: "exact", prose: "reviewed against declared schema", action: "bounded and non-transactional" },
    },
    evaluator: { version: HEALTH_EVALUATOR_VERSION, status: "sealed_until_baseline_submission" },
  };
  const hashes = contentHashes(definition);
  return { ...definition, precommit: { canonicalSha256: hashes.sha256, manifestKeccak256: hashes.keccak256 } };
}

export function publicHealthBenchPacket(definition) {
  if (!definition?.precommit?.manifestKeccak256) throw new Error("A frozen HealthBench definition is required.");
  return {
    benchmarkId: definition.benchmarkId,
    version: definition.version,
    category: definition.category,
    chain: definition.chain,
    position: definition.position,
    task: definition.task,
    controls: { humanBaseline: definition.controls.humanBaseline, agent: { sameFrozenEvidence: true, automaticActionTaken: false } },
    methodology: definition.methodology,
    precommit: definition.precommit,
    baseline: { required: true, status: "not_started", contaminationBoundary: "Do not open or request Canned output until the human submission is accepted." },
  };
}

export function publicHealthBenchSource(definition) {
  if (!definition?.frozenEvidence?.snapshot) throw new Error("A frozen HealthBench definition is required.");
  return {
    benchmarkId: definition.benchmarkId,
    asOfBlock: definition.frozenEvidence.snapshot.asOfBlock,
    blockHash: definition.frozenEvidence.snapshot.blockHash,
    blockTimestamp: definition.frozenEvidence.snapshot.blockTimestamp,
    protocol: definition.frozenEvidence.snapshot.protocol,
    poolType: definition.frozenEvidence.snapshot.poolType,
    account: definition.frozenEvidence.snapshot.account,
    rawOnchainEvidence: definition.frozenEvidence.snapshot,
    priorRawOnchainEvidence: definition.frozenEvidence.priorSnapshot,
    disclosure: "Raw authoritative reads only. No health classification, recommendation, evaluator result, or agent output is included.",
  };
}

export function createHumanBaselineAttempt({ benchmarkId, startedAt = nowIso() } = {}) {
  if (benchmarkId !== HEALTH_BENCHMARK_ID) throw new Error("Unknown HealthBench baseline.");
  return { attemptId: id("human-health-baseline"), benchmarkId, status: "started", startedAt, finishedAt: null, elapsedMs: null, submission: null, submittedAt: null };
}

export function completeHumanBaseline({ attempt, submission, submittedAt = nowIso(), elapsedMs } = {}) {
  if (!attempt || attempt.status !== "started") throw new Error("A started human baseline is required.");
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) throw new Error("Human baseline submission must be a JSON object.");
  const missing = REQUIRED_HUMAN_FIELDS.filter((field) => submission[field] === undefined);
  if (missing.length) throw new Error(`Human baseline is missing required fields: ${missing.join(", ")}`);
  const measuredElapsedMs = Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : Math.max(0, Date.parse(submittedAt) - Date.parse(attempt.startedAt));
  return { ...attempt, status: "submitted", finishedAt: submittedAt, submittedAt, elapsedMs: measuredElapsedMs, submission: structuredClone(submission) };
}

export function baselineContainsSecretAnswer(value) {
  const forbidden = ["groundtruth", "ground_truth", "agentoutput", "agent_output", "evaluatorresult", "evaluator_result", "expectedanswer", "expected_answer", "correctclassification", "correct_classification", "correctintervention", "correct_intervention"];
  const visit = (item) => {
    if (!item || typeof item !== "object") return false;
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (forbidden.includes(normalized)) return true;
      if (visit(child)) return true;
    }
    return false;
  };
  return visit(value);
}

export function humanBaselineFields() { return [...REQUIRED_HUMAN_FIELDS]; }
