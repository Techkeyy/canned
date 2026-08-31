/**
 * Run the frozen GridBench v1 against Grid Keeper's engine and grade it.
 *
 * The agent answers with the same engine it would use in production; the
 * evaluator recomputes ground truth from the frozen specification and never
 * calls that engine. No LLM is involved and nothing is spent.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildGridBenchmarkDefinition } from "../src/reference/grid-benchmark.mjs";
import { computeGridGroundTruth, gradeGridBenchResponse } from "../src/reference/grid-evaluator.mjs";
import { createStrategy, evaluateLevel, deriveLedger, STRATEGY_STATES } from "../src/reference/grid-engine.mjs";
import { contentHashes, nowIso } from "../src/core.mjs";

const NOW_MS = Date.parse("2026-08-30T12:00:00.000Z");
const definition = buildGridBenchmarkDefinition();

/** Build the strategy for a scenario exactly as the agent would. */
function strategyFor(scenario) {
  const merged = { ...definition.strategy, ...(scenario.strategyOverride ?? {}) };
  return createStrategy({
    ...merged,
    lowerPriceMinor: BigInt(merged.lowerPriceMinor),
    upperPriceMinor: BigInt(merged.upperPriceMinor),
    totalCapitalMinor: BigInt(merged.totalCapitalMinor),
    maxPerLevelMinor: BigInt(merged.maxPerLevelMinor),
    referencePriceMinor: BigInt(merged.referencePriceMinor),
  });
}

// The agent's submission, produced only from the public packet.
const answers = {};
for (const scenario of definition.scenarios) {
  if (scenario.asks === "grid_construction") {
    const built = strategyFor(scenario);
    answers[scenario.id] = { asks: scenario.asks, levels: built.levels.map((level) => ({ levelId: level.levelId, priceMinor: String(level.priceMinor), side: level.side })) };
  } else if (scenario.asks === "ledger") {
    const built = strategyFor(scenario);
    const ledger = deriveLedger(built, scenario.fills ?? []);
    answers[scenario.id] = { asks: scenario.asks, fillCount: ledger.fillCount, netQuoteSpentMinor: String(ledger.netQuoteSpentMinor), baseInventoryMinor: String(ledger.baseInventoryMinor) };
  } else {
    const built = { ...strategyFor(scenario), state: STRATEGY_STATES.ACTIVE };
    const decision = evaluateLevel({
      strategy: built, level: { levelId: scenario.levelId }, observation: scenario.observation,
      fills: scenario.fills ?? [], now: NOW_MS,
      authority: scenario.authority ?? null, intendedCall: scenario.intendedCall ?? null,
    });
    answers[scenario.id] = { asks: scenario.asks, allowed: decision.allowed, reason: decision.reason, side: decision.side ?? null };
  }
}

const submission = { benchmarkId: definition.benchmarkId, agent: "Canned Grid Keeper", engine: "grid-engine-v1", answers, submittedAt: nowIso() };
const groundTruth = computeGridGroundTruth(definition, { nowMs: NOW_MS });
const grading = gradeGridBenchResponse({ definition, groundTruth, submission });

const record = {
  entity: "GridBenchGrading",
  benchmarkId: definition.benchmarkId,
  precommit: definition.precommit,
  agent: { name: "Canned Grid Keeper", identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2045", origin: "CANNED_REFERENCE" },
  evaluator: { version: grading.evaluatorVersion, groundTruthSource: groundTruth.computedFrom, llmGraded: false },
  scenarioCount: grading.scenarioCount,
  passedCount: grading.passedCount,
  qualityScore: grading.qualityScore,
  results: grading.results.map(({ scenarioId, asks, passed, detail }) => ({ scenarioId, asks, passed, detail })),
  submissionHashes: contentHashes(submission),
  groundTruthHashes: groundTruth.hashes,
  // GridBench is a capability benchmark, not a TermiX pair.
  humanBaseline: null,
  termixPair: false,
  note: "Deterministic capability benchmark. Ground truth recomputed from the frozen specification, independent of the engine under test.",
  gradedAt: nowIso(),
};
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
await mkdir(path.join(dataDir, "state"), { recursive: true });
await writeFile(path.join(dataDir, "state", "gridbench-grading.json"), `${JSON.stringify({ ...record, hashes: contentHashes(record) }, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ status: "gridbench_graded", precommit: definition.precommit.sha256, scenarioCount: record.scenarioCount, passedCount: record.passedCount, qualityScore: record.qualityScore, failed: record.results.filter((r) => !r.passed) }, null, 2));
