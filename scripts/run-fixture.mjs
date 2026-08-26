import { FileStore } from "../src/persistence/file-store.mjs";
import { BENCHMARKS } from "../src/benchmark/definitions.mjs";
import { runBenchmark, metricsFromStore } from "../src/benchmark/framework.mjs";
import { CATEGORIES, RUN_TYPES } from "../src/domain.mjs";

const store = await new FileStore().init();
const agent = { identity: "fixture:evidence-agent-v1", name: "Fixture Evidence Agent", services: [{ type: "fixture", endpoint: "fixture://yield-agent" }] };
const input = { startingCapitalUsdCents: 100_000, observationWindowSeconds: 300, baselineVenue: "fixture-venus-market", deadlineAtUnixSeconds: Math.floor(Date.now() / 1000) + 300 };
const run = await runBenchmark({
  agent,
  benchmark: BENCHMARKS[CATEGORIES.YIELD_OPTIMISATION],
  input,
  agentOutput: { realizedYieldBps: 620, executionCostUsdCents: 6, completed: true },
  controlOutput: { realizedYieldBps: 500, executionCostUsdCents: 0, completed: true },
  store,
  runType: RUN_TYPES.FIXTURE,
  provenanceMode: "FIXTURE",
  qualification: { allGatesPassed: false, reason: "fixture_data_excluded_from_product_metrics" },
});
console.log(JSON.stringify({ runId: run.runId, terminalState: run.terminalState, manifestHash: run.manifest.hash, metrics: await metricsFromStore(store) }, null, 2));
