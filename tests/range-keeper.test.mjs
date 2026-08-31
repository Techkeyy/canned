import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, contentHashes } from "../src/core.mjs";
import { CATEGORIES, CATEGORY_LABELS } from "../src/domain.mjs";
import { selectHiringAdapter } from "../src/marketplace/adapters.mjs";
import { deriveAgentRecord } from "../src/marketplace/model.mjs";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";
import { publicReadinessFailures, referenceFleetIdentityFailures } from "../src/deploy/readiness.mjs";
import { probeRpcCapability, rpcReadinessFailures, sdkRpcEnvironment, SDK_DEFAULT_TESTNET_RPC, SDK_RPC_ENV_KEYS } from "../src/deploy/rpc-capability.mjs";
import { lookupIndexedAgent } from "../src/discovery/identity-lookup.mjs";
import { REFERENCE_AGENT_SPECS, referenceAgentCandidate, referenceSpec, implementedReferenceAgentCandidates } from "../src/reference/constants.mjs";
import { publicReferenceMetadata } from "../src/reference/public-service.mjs";
import { alignTick, classifyRange, isTickSpacingAligned, isValidTick, meanTicksFromObservations, PANCAKESWAP_V3, tickToPrice, validateAuthoritativePancakeSnapshot } from "../src/reference/pancakeswap.mjs";
import { altanaExecutionPlan, buildIndependentRangeControl, buildRangeKeeperDeliverable, proposeRange, REBALANCE_POLICY } from "../src/reference/range-keeper.mjs";
import { createRebalanceBenchDefinition, publicRebalanceBenchPacket, publicRebalanceBenchSource, rebalanceBenchAgentInput, rebalanceBenchProviderTask, rebalanceContainsSecretAnswer, completeRebalanceBaseline, createRebalanceBaselineAttempt, validateRebalanceBenchAgentInput } from "../src/reference/rebalance-benchmark.mjs";
import { computeRebalanceGroundTruth, gradeRebalanceResponse, rangeKeeperStructuredView, rangeKeeperSubmissionFromOutput } from "../src/reference/rebalance-evaluator.mjs";
import { MINIMUM_OBSERVATIONS_FOR_RATE, recordRangeDecision, settleRangeDecision, summarizeRangeTrackRecord } from "../src/reference/range-track-record.mjs";

const pool = "0x172fcD41E0913e95784454622d1c3724f546f849";
const usdt = "0x55d398326f99059fF775485246999027B3197955";
const wbnb = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const registry = "0x8004a818bfb912233c491871b3d84c89a494bd9e";

function snapshotAt({ tick = -65654, tickLower = -65724, tickUpper = -65524, meanTicks = [{ secondsAgo: 3600, meanTick: -65669 }, { secondsAgo: 300, meanTick: -65655 }, { secondsAgo: 0, meanTick: null, note: "reference point" }] } = {}) {
  return {
    protocol: "PancakeSwapV3", source: "onchain", chainId: 56, venue: "PancakeSwap",
    asOfBlock: "118445030", blockHash: `0x${"c5".repeat(32)}`, blockTimestamp: 1_787_861_334,
    readPlan: { chainId: 56, pool, blockTag: "118445030", authoritative: true, methods: ["slot0()"] },
    pool: { address: pool, token0: { address: usdt, symbol: "USDT", decimals: 18 }, token1: { address: wbnb, symbol: "WBNB", decimals: 18 }, fee: 100, feePercent: 0.01, tickSpacing: 1, liquidityRaw: "3802571963771789113626193", feeGrowthGlobal0X128: "1", feeGrowthGlobal1X128: "2" },
    slot0: { sqrtPriceX96: "2973775414390599107492001056", tick, observationIndex: 550, observationCardinality: 2400, unlocked: true },
    position: { tokenId: "7261944", tickLower, tickUpper, liquidity: "11964304490633407270133", feeGrowthInside0LastX128: "1", feeGrowthInside1LastX128: "2", tokensOwed0: "0", tokensOwed1: "0" },
    observations: meanTicks ? { secondsAgos: meanTicks.map((entry) => entry.secondsAgo), tickCumulatives: ["-1", "-2", "-3"], meanTicks } : null,
    observationError: null,
    authoritative: true,
  };
}

const definition = createRebalanceBenchDefinition({ snapshot: snapshotAt() });
const truth = computeRebalanceGroundTruth(definition);
const deliverable = buildRangeKeeperDeliverable({ jobId: 900, task: rebalanceBenchProviderTask(definition, { jobId: 900 }) });

test("PancakeSwap V3 addresses are the official deployment and tick maths is exact", () => {
  assert.equal(PANCAKESWAP_V3.positionManager, "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364");
  assert.equal(PANCAKESWAP_V3.factory, "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865");
  assert.equal(isValidTick(-887272), true);
  assert.equal(isValidTick(-887273), false);
  assert.equal(isTickSpacingAligned(-65650, 10), true);
  assert.equal(isTickSpacingAligned(-65654, 10), false);
  assert.equal(alignTick(-65654, 10, "down"), -65660);
  assert.equal(alignTick(-65654, 10, "up"), -65650);
  assert.ok(Math.abs(tickToPrice(0, 18, 18) - 1) < 1e-12);
});

test("the snapshot parser rejects anything that is not an authoritative frozen read", () => {
  assert.equal(validateAuthoritativePancakeSnapshot(snapshotAt()).valid, true);
  assert.equal(validateAuthoritativePancakeSnapshot({ ...snapshotAt(), source: "scraped" }).errors.includes("snapshot_not_onchain"), true);
  assert.equal(validateAuthoritativePancakeSnapshot({ ...snapshotAt(), blockHash: undefined }).errors.includes("frozen_block_fields_missing"), true);
  const observations = meanTicksFromObservations({ secondsAgos: [3600, 0], tickCumulatives: [-6699673145421n, -6699909556206n] });
  assert.equal(observations[1].meanTick, null);
  assert.equal(Number.isFinite(observations[0].meanTick), true);
});

test("range classification is exact and reports which edge is nearer", () => {
  const inside = classifyRange({ currentTick: -65654, tickLower: -65724, tickUpper: -65524, tickSpacing: 1 });
  assert.equal(inside.status, "IN_RANGE");
  assert.equal(inside.ticksToLower, 70);
  assert.equal(inside.ticksToUpper, 130);
  assert.equal(inside.nearestEdge, "lower");
  assert.equal(inside.widthTicks, 200);
  const below = classifyRange({ currentTick: -65800, tickLower: -65724, tickUpper: -65524, tickSpacing: 1 });
  assert.equal(below.status, "OUT_OF_RANGE_BELOW");
  assert.equal(below.inRange, false);
  const above = classifyRange({ currentTick: -65400, tickLower: -65724, tickUpper: -65524, tickSpacing: 1 });
  assert.equal(above.status, "OUT_OF_RANGE_ABOVE");
  const invalid = classifyRange({ currentTick: 0, tickLower: 100, tickUpper: 50, tickSpacing: 1 });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes("lower_tick_not_below_upper_tick"));
  const unaligned = classifyRange({ currentTick: 0, tickLower: -105, tickUpper: 105, tickSpacing: 10 });
  assert.ok(unaligned.errors.includes("tick_not_aligned_to_spacing"));
});

test("a comfortably in-range position is held, not rebalanced", () => {
  assert.equal(deliverable.ok, true);
  assert.equal(deliverable.output.rangeStatus.status, "IN_RANGE");
  assert.equal(deliverable.output.decision.action, "HOLD");
  assert.equal(deliverable.output.decision.rebalanceRecommended, false);
  assert.deepEqual(deliverable.output.decision.triggers, []);
  assert.equal(deliverable.output.proposedRange, null);
  assert.match(deliverable.output.decision.reason, /still in range/);
});

test("an out-of-range position is rebalanced into a legal recentred range", () => {
  const out = buildRangeKeeperDeliverable({ jobId: 901, task: { venue: "pancakeswap", pool, authoritativeSnapshot: snapshotAt({ tick: -65800 }) } });
  assert.equal(out.output.decision.action, "REBALANCE");
  assert.ok(out.output.decision.triggers.includes("position_out_of_range"));
  const proposed = out.output.proposedRange;
  assert.equal(proposed.alignedToSpacing, true);
  assert.equal(proposed.centredOnCurrentTick, true);
  assert.ok(proposed.tickLower < proposed.tickUpper);
  assert.equal(proposed.preservesOriginalWidth, true);
});

test("a proposed range is always tick-aligned and contains the live tick", () => {
  for (const spacing of [1, 10, 50, 200]) {
    const proposal = proposeRange({ currentTick: -65654, tickLower: -65724, tickUpper: -65524, tickSpacing: spacing });
    assert.equal(isTickSpacingAligned(proposal.tickLower, spacing), true);
    assert.equal(isTickSpacingAligned(proposal.tickUpper, spacing), true);
    assert.ok(proposal.tickLower <= -65654 && -65654 < proposal.tickUpper);
  }
});

test("Range Keeper v1 has no execution path and never claims to move capital", () => {
  assert.equal(deliverable.output.execution.mode, "recommendation_only");
  assert.equal(deliverable.output.execution.automaticActionTaken, false);
  assert.equal(deliverable.output.execution.capitalMoved, false);
  assert.equal(referenceSpec("rebalancing").executionPolicy.capitalMovement, false);
  assert.equal(referenceSpec("rebalancing").executionPolicy.automaticIntervention, false);
  // Naming the calls a rebalance *would* cost is legitimate cost disclosure.
  // What must be absent is an actionable plan: holding produces none at all.
  assert.equal(deliverable.output.execution.futureBoundedPlan, null);
  assert.equal(deliverable.output.proposedRange, null);
  assert.equal(deliverable.output.execution.reason.includes("never removes liquidity"), true);
  // Even when a plan exists it is declared, never authorized or executable.
  const acting = buildRangeKeeperDeliverable({ jobId: 903, task: { venue: "pancakeswap", pool, authoritativeSnapshot: snapshotAt({ tick: -65800 }) } });
  assert.equal(acting.output.execution.mode, "recommendation_only");
  assert.equal(acting.output.execution.capitalMoved, false);
  assert.equal(acting.output.execution.futureBoundedPlan.status, "PLANNED_NOT_AUTHORIZED");
  // "arbitrary calldata" appearing in the plan's forbidden list is a prohibition,
  // not a capability, so the scan targets signing and broadcast primitives only.
  assert.ok(acting.output.execution.futureBoundedPlan.forbidden.includes("arbitrary calldata"));
  const serialized = canonicalJson(acting.output);
  for (const primitive of ["privateKey", "signTransaction", "rawTransaction", "sendRawTransaction", "0x"]) {
    if (primitive === "0x") continue;
    assert.equal(serialized.includes(primitive), false);
  }
});

test("the Altana plan is a declared boundary, not an authorization", () => {
  const out = buildRangeKeeperDeliverable({ jobId: 902, task: { venue: "pancakeswap", pool, authoritativeSnapshot: snapshotAt({ tick: -65800 }) } });
  const plan = out.output.execution.futureBoundedPlan;
  assert.equal(plan.status, "PLANNED_NOT_AUTHORIZED");
  assert.deepEqual(plan.contractAllowlist, [PANCAKESWAP_V3.positionManager]);
  assert.deepEqual(plan.methodAllowlist, ["decreaseLiquidity", "collect", "mint"]);
  assert.ok(plan.forbidden.includes("unlimited allowance"));
  assert.equal(plan.requiresOperatorConfirmation, true);
  assert.equal(plan.network, "bsc-testnet");
  assert.equal(altanaExecutionPlan({ snapshot: snapshotAt(), proposed: null }), null);
});

test("Range Keeper refuses to answer without authoritative pool data", () => {
  const blocked = buildRangeKeeperDeliverable({ task: { venue: "pancakeswap", pool } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.output.status, "INSUFFICIENT_AUTHORITATIVE_DATA");
  assert.equal(blocked.output.rangeStatus, undefined);
});

test("the frozen benchmark binds the exact pool, position, and block", () => {
  assert.equal(definition.immutable, true);
  assert.equal(definition.benchmarkId, "RebalanceBench_v1");
  assert.equal(definition.executionBoundary.mainnetWriteAuthorized, false);
  assert.equal(definition.executionBoundary.paymentAndAgentExecutionChain, "bsc-testnet");
  assert.equal(definition.referenceBlock.number, "118445030");
  const { precommit, ...rest } = definition;
  const recomputed = contentHashes(rest);
  assert.equal(recomputed.sha256, precommit.canonicalSha256);
  assert.equal(recomputed.keccak256, precommit.manifestKeccak256);
});

test("the agent input is the exact frozen snapshot and a tampered one is rejected", () => {
  const input = rebalanceBenchAgentInput(definition);
  assert.equal(validateRebalanceBenchAgentInput({ definition, input }).valid, true);
  assert.deepEqual(input.evidence.snapshot, definition.frozenEvidence.snapshot);
  const tampered = { ...definition, frozenEvidence: { snapshot: snapshotAt({ tick: -65000 }) } };
  const result = validateRebalanceBenchAgentInput({ definition, input: rebalanceBenchAgentInput(tampered) });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("agent_input_does_not_match_frozen_definition"));
});

test("no public surface carries the decision, the classification, or the evaluator", () => {
  const packet = publicRebalanceBenchPacket(definition);
  const source = publicRebalanceBenchSource(definition);
  const input = rebalanceBenchAgentInput(definition);
  assert.equal(packet.evaluator, undefined);
  assert.equal(packet.frozenEvidence, undefined);
  assert.equal(packet.policy, undefined);
  for (const surface of [packet, source, input]) {
    const text = JSON.stringify(surface);
    assert.equal(rebalanceContainsSecretAnswer(surface), false);
    for (const secret of [truth.decisionTruth.correctAction, truth.rangeTruth.status, truth.movementTruth.directionRelativeToRange, truth.hashes.keccak256]) {
      assert.equal(text.includes(secret), false, `${secret} leaked`);
    }
  }
});

test("the human source packet is readable without Solidity and quotes price both ways", () => {
  const plain = publicRebalanceBenchSource(definition).plainLanguage;
  assert.match(plain.whatYouOwn, /liquidity position/);
  assert.match(plain.yourRange, /USDT per WBNB/);
  assert.equal(plain.rangeSummary.widthTicks, 200);
  assert.ok(plain.rangeSummary.rangeLow_USDT_per_WBNB < plain.rangeSummary.rangeHigh_USDT_per_WBNB);
  assert.equal(plain.rules.length, 4);
  assert.equal(plain.howTheMarketMoved.length, 2);
});

test("ground truth is deterministic and derived only from the frozen snapshot and policy", () => {
  const again = computeRebalanceGroundTruth(definition);
  assert.equal(again.hashes.keccak256, truth.hashes.keccak256);
  assert.equal(truth.computedFrom, "frozen_snapshot_and_precommitted_policy_only");
  assert.equal(truth.policyVersion, REBALANCE_POLICY.version);
  assert.equal(truth.rangeTruth.inRange, true);
  assert.equal(truth.rangeTruth.nearestEdge, "lower");
  assert.equal(truth.decisionTruth.correctAction, "HOLD");
  assert.equal(truth.proposedRangeTruth, null);
});

test("the rubric scores prose and structured answers alike, in either price quote", () => {
  const agent = gradeRebalanceResponse({ truth, submission: rangeKeeperSubmissionFromOutput(deliverable.output), structuredFor: rangeKeeperStructuredView(deliverable.output), responder: "agent" });
  assert.equal(agent.qualityScore, 100);
  // The nearer bound is the lower tick, which is the higher USDT price. Both
  // descriptions are correct English for the same bound.
  const tickFrame = {
    positionStatus: "In range. Current tick -65654 sits inside -65724 to -65524 on the PancakeSwap USDT/WBNB pool.",
    edgeProximity: "Nearer the lower tick bound at -65724, about 70 ticks away versus 130 to the other side. Not close.",
    marketMovement: "Ticks rose slightly over the hour, a small move away from the nearer bound compared with the 200 tick width.",
    rebalanceDecision: "No rebalance. Still in range and the gas and impermanent loss cost is not justified.",
    proposedRange: "None.",
    risksAndTradeoffs: "Risk is drifting out and losing fees. Acting costs gas and realises impermanent loss. A single snapshot is not a forecast.",
  };
  const priceFrame = {
    positionStatus: "Still in range and earning fees. Price is 709.86 USDT per WBNB, range 700.69 to 714.85, USDT/WBNB pool.",
    edgeProximity: "Closer to the upper price bound at 714.84 than the lower one, so not close to falling out.",
    marketMovement: "Barely moved. The hourly average was 710.92 and it is 709.86 now, a small move away from the near bound.",
    rebalanceDecision: "No, leave it alone. Still earning fees and gas plus impermanent loss is not worth it.",
    proposedRange: "No new range needed.",
    risksAndTradeoffs: "It could exit the range and stop earning. Rebalancing costs gas and locks in impermanent loss. One snapshot cannot predict the next move.",
  };
  assert.equal(gradeRebalanceResponse({ truth, submission: tickFrame, responder: "human" }).qualityScore, 100);
  assert.equal(gradeRebalanceResponse({ truth, submission: priceFrame, responder: "human" }).qualityScore, 100);
});

test("declining scores zero, and declining to propose a range does not when holding is correct", () => {
  const fields = ["positionStatus", "edgeProximity", "marketMovement", "rebalanceDecision", "proposedRange", "risksAndTradeoffs"];
  const declined = gradeRebalanceResponse({ truth, submission: Object.fromEntries(fields.map((field) => [field, "no idea"])), responder: "human" });
  assert.equal(declined.qualityScore, 0);
  assert.equal(declined.declinedDimensions.length, 6);
  const holds = gradeRebalanceResponse({ truth, submission: { ...Object.fromEntries(fields.map((field) => [field, "no idea"])), proposedRange: "None needed" }, responder: "human" });
  assert.equal(holds.declinedDimensions.includes("proposedRange"), false);
});

test("an over-reacting answer loses the decision and proximity points", () => {
  const overReact = gradeRebalanceResponse({ truth, submission: {
    positionStatus: "In range I think.",
    edgeProximity: "Very close to the edge, about to fall out.",
    marketMovement: "Price crashed hard this hour.",
    rebalanceDecision: "Yes rebalance immediately, move the range now.",
    proposedRange: "-65700 to -65600",
    risksAndTradeoffs: "None really, rebalancing is always safer.",
  }, responder: "human" });
  assert.ok(overReact.missedItems.includes("rebalanceDecision.decision_matches_policy"));
  assert.ok(overReact.missedItems.includes("edgeProximity.proximity_assessment_correct"));
  assert.ok(overReact.qualityScore < 60);
});

test("grading is deterministic for the same answer", () => {
  const submission = rangeKeeperSubmissionFromOutput(deliverable.output);
  const first = gradeRebalanceResponse({ truth, submission, structuredFor: rangeKeeperStructuredView(deliverable.output), responder: "agent" });
  const second = gradeRebalanceResponse({ truth, submission, structuredFor: rangeKeeperStructuredView(deliverable.output), responder: "agent" });
  assert.equal(first.hashes.keccak256, second.hashes.keccak256);
  assert.equal(first.groundTruthHash, truth.hashes.keccak256);
});

test("the human baseline preserves the raw submission and refuses partial answers", () => {
  const attempt = createRebalanceBaselineAttempt({ benchmarkId: "RebalanceBench_v1" });
  assert.equal(attempt.status, "started");
  assert.throws(() => completeRebalanceBaseline({ attempt, submission: { positionStatus: "in range" } }), /missing required fields/);
  const submission = { positionStatus: "a", edgeProximity: "b", marketMovement: "c", rebalanceDecision: "d", proposedRange: "e", risksAndTradeoffs: "f" };
  const completed = completeRebalanceBaseline({ attempt, submission, elapsedMs: 1234 });
  assert.equal(completed.status, "submitted");
  assert.equal(completed.elapsedMs, 1234);
  assert.deepEqual(completed.submission, submission);
  assert.throws(() => completeRebalanceBaseline({ attempt: completed, submission }), /A started RebalanceBench baseline is required/);
});

test("the track record starts empty and never invents a rate", () => {
  const empty = summarizeRangeTrackRecord({ decisions: [] });
  assert.equal(empty.totalDecisions, 0);
  assert.equal(empty.hasEnoughObservations, false);
  assert.equal(empty.rangeRetentionRate, null);
  assert.match(empty.statement, /Not enough observations/);
  const decision = recordRangeDecision({ decisionId: "decision-1", snapshot: snapshotAt(), deliverable: deliverable.output });
  assert.equal(decision.outcome, null);
  assert.equal(decision.recommendedAction, "HOLD");
  const pendingOnly = summarizeRangeTrackRecord({ decisions: [decision] });
  assert.equal(pendingOnly.pendingDecisions, 1);
  assert.equal(pendingOnly.rangeRetentionRate, null);
});

test("a decision is settled only against a later independent read", () => {
  const decision = recordRangeDecision({ decisionId: "decision-2", snapshot: snapshotAt(), deliverable: deliverable.output });
  assert.throws(() => settleRangeDecision({ decision, followUpSnapshot: snapshotAt() }), /must be later/);
  const later = { ...snapshotAt({ tick: -65600 }), asOfBlock: "118455030", blockTimestamp: 1_787_891_334 };
  const settled = settleRangeDecision({ decision, followUpSnapshot: later });
  assert.equal(settled.outcome.originalRangeStillContainsPrice, true);
  assert.equal(settled.outcome.followedAdviceInRange, true);
  assert.equal(settled.outcome.verdict, "advice_kept_position_in_range");
  assert.match(settled.outcome.note, /not a profit claim/);
  const exited = { ...snapshotAt({ tick: -65900 }), asOfBlock: "118455030", blockTimestamp: 1_787_891_334 };
  assert.equal(settleRangeDecision({ decision, followUpSnapshot: exited }).outcome.followedAdviceInRange, false);
  const summary = summarizeRangeTrackRecord({ decisions: [settled] });
  assert.equal(summary.settledDecisions, 1);
  assert.equal(summary.hasEnoughObservations, false);
  assert.equal(summary.minimumObservations, MINIMUM_OBSERVATIONS_FOR_RATE);
});

test("RPC readiness detects the exact Verified Run #1 misconfiguration", () => {
  const broken = sdkRpcEnvironment({ CANNED_RPC_URL: "https://good.example" }, "bsc-testnet");
  assert.equal(broken.usingSdkDefault, true);
  assert.equal(broken.ineffectiveCannedOverride, true);
  assert.equal(broken.effectiveRpcUrl, SDK_DEFAULT_TESTNET_RPC);
  assert.equal(broken.perNetworkKey, SDK_RPC_ENV_KEYS["bsc-testnet"]);
  const failures = rpcReadinessFailures({ environment: broken, capability: { capable: false, checks: { reachable: true, chainIdMatches: true, headReadable: true, verifyJobLogSpan: false } } });
  assert.ok(failures.includes("sdk_rpc_override_not_set"));
  assert.ok(failures.includes("canned_rpc_url_set_but_ignored_by_sdk"));
  assert.ok(failures.includes("rpc_cannot_serve_verify_job_log_span"));
  const fixed = sdkRpcEnvironment({ RPC_URL_BSC_TESTNET: "https://good.example" }, "bsc-testnet");
  assert.equal(fixed.usingSdkDefault, false);
  assert.deepEqual(rpcReadinessFailures({ environment: fixed, capability: { capable: true, checks: {} } }), []);
});

test("an RPC that refuses the verifyJob log range is reported as incapable", async () => {
  const fetchImpl = async (_url, options) => {
    const method = JSON.parse(options.body).method;
    if (method === "eth_getLogs") return { json: async () => ({ error: { message: "limit exceeded" } }) };
    if (method === "eth_chainId") return { json: async () => ({ result: "0x61" }) };
    return { json: async () => ({ result: "0x79aaa0c" }) };
  };
  const capability = await probeRpcCapability({ rpcUrl: "https://limited.example", fetchImpl });
  assert.equal(capability.capable, false);
  assert.equal(capability.checks.chainIdMatches, true);
  assert.equal(capability.checks.verifyJobLogSpan, false);
  assert.match(capability.reason, /verifyJob/);
});

test("public readiness fails closed when the watcher cannot read the chain", () => {
  const base = {
    agentUrl: "https://range-keeper.example/erc8183",
    health: { ok: true, body: { chainId: 97, endpointAlive: true } },
    readiness: { ok: true, body: { network: "bsc-testnet", chainId: 97, endpoint: { transport: "public_http", url: "https://range-keeper.example/erc8183" }, worker: { alive: true }, watcher: { alive: true }, storage: { public: true, localFilesystemPresentedAsEvidence: false }, providerAddress: "0x1", rpc: { capable: false, usingSdkDefault: true } } },
    status: { ok: true, body: { chainId: 97, paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", provider: "0x1" } },
    metadata: { ok: true, body: { origin: "CANNED_REFERENCE", chainId: 97, category: "Rebalancing", protocols: [{ verifyingContract: "0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE", endpoint: "https://range-keeper.example/erc8183" }] } },
    expectedCategory: "Rebalancing",
  };
  const failures = publicReadinessFailures(base);
  assert.ok(failures.includes("rpc_cannot_serve_verify_job_log_span"));
  assert.ok(failures.includes("sdk_rpc_override_not_set"));
  const healthy = publicReadinessFailures({ ...base, readiness: { ...base.readiness, body: { ...base.readiness.body, rpc: { capable: true, usingSdkDefault: false } } } });
  assert.deepEqual(healthy, []);
  // A second agent must not pass the first agent's category gate.
  assert.ok(publicReadinessFailures({ ...base, expectedCategory: "Health Factor Monitoring" }).includes("metadata_category_mismatch"));
});

test("indexer lookup finds an agent that is not on the first page", async () => {
  const pages = [Array.from({ length: 100 }, (_, index) => ({ token_id: String(index + 1), chain_id: 97 })), [{ token_id: "2003", chain_id: 97, name: "Canned Health Guard", owner_address: "0xabc", agent_id: "97:x:2003" }]];
  const adapter = {
    detail: async () => ({ ok: false, status: 404, body: null }),
    get: async (_path, params) => ({ ok: true, status: 200, body: { items: pages[params.offset / params.limit] || [] } }),
  };
  const found = await lookupIndexedAgent({ chainId: 97, agentId: 2003, adapter });
  assert.equal(found.indexed, true);
  assert.equal(found.method, "paginated_scan");
  assert.ok(found.pagesScanned > 1);
  const direct = await lookupIndexedAgent({ chainId: 97, agentId: 4242, adapter: { detail: async () => ({ ok: true, status: 200, body: { token_id: "4242", chain_id: 97, name: "x", owner_address: "0xdef" } }), get: async () => ({ ok: true, body: { items: [] } }) } });
  assert.equal(direct.indexed, true);
  assert.equal(direct.method, "direct_lookup");
  const missing = await lookupIndexedAgent({ chainId: 97, agentId: 999999, adapter });
  assert.equal(missing.indexed, false);
});

test("Range Keeper metadata is first-party, PancakeSwap-scoped, and recommendation-only", () => {
  const metadata = publicReferenceMetadata({ agentUrl: "https://range-keeper.example/erc8183", providerAddress: "0x1", referenceKey: "rebalancing" });
  assert.equal(metadata.name, "Canned Range Keeper");
  assert.equal(metadata.category, CATEGORY_LABELS[CATEGORIES.REBALANCING]);
  assert.equal(metadata.venue, "PancakeSwap");
  assert.equal(metadata.origin, "CANNED_REFERENCE");
  assert.equal(metadata.version, "range-keeper-service-v1");
  assert.equal(metadata.executionPolicy.capitalMovement, false);
  const health = publicReferenceMetadata({ agentUrl: "https://health-guard.example/erc8183", providerAddress: "0x2", referenceKey: "health-factor" });
  assert.equal(health.version, "health-guard-service-v1");
  assert.notEqual(metadata.version, health.version);
});

test("Range Keeper is not hireable before registration and never counts as third-party", () => {
  const spec = REFERENCE_AGENT_SPECS.find((item) => item.key === "rebalancing");
  const unregistered = referenceAgentCandidate(spec, { providerAddress: "0x1", allowLocalProbe: false, publicReadinessVerified: true, baselineSealed: false });
  assert.equal(unregistered.erc8004.status, "not_registered");
  assert.equal(unregistered.selectionGate.readiness.ready, false);
  assert.equal(unregistered.selectionGate.readiness.conditions.identityRegistered, false);
  assert.equal(selectHiringAdapter(unregistered, { chainId: 97 }).status, "blocked");
  const record = deriveAgentRecord(unregistered, []);
  assert.equal(record.origin, "CANNED_REFERENCE");
  assert.equal(record.reference, true);
  // A live endpoint is allowed to show as verified; delivery and benchmark
  // evidence are not, because none has been observed.
  assert.equal(record.trust.states.DELIVERY_OBSERVED, false);
  assert.equal(record.trust.states.BENCHMARKED, false);
  assert.equal(record.trust.states.HIRE_ATTEMPTED, false);
  assert.equal(record.trust.deliveryCount, 0);
  assert.equal(record.trust.benchmarkCount, 0);
  assert.ok(["LISTED - NOT YET TESTED", "ENDPOINT VERIFIED"].includes(record.status.label));
  const notListedPublicly = referenceAgentCandidate(spec, { providerAddress: "0x1", allowLocalProbe: false, publicReadinessVerified: false });
  assert.equal(deriveAgentRecord(notListedPublicly, []).status.label, "LISTED - NOT YET TESTED");
  assert.equal([record].filter((item) => item.origin !== "CANNED_REFERENCE").length, 0);
});

test("the two reference agents keep separate identities, endpoints, and readiness", () => {
  const candidates = implementedReferenceAgentCandidates({
    allowLocalProbe: false,
    identityRecords: {
      "health-factor": { agentId: 2003, registry, endpoint: "https://health-guard.example/erc8183", provider: "0xaaa", quoteVerified: true, publicReadinessVerified: true },
      rebalancing: { agentId: 2100, registry, endpoint: "https://range-keeper.example/erc8183", provider: "0xbbb", quoteVerified: true, publicReadinessVerified: true },
    },
    baselineSealedByKey: { "health-factor": true, rebalancing: false },
  });
  // All four are implemented now; this test is about the two with identities.
  assert.equal(candidates.length, 4);
  const health = candidates.find((entry) => entry.referenceKey === "health-factor");
  const range = candidates.find((entry) => entry.referenceKey === "rebalancing");
  assert.notEqual(health.identity, range.identity);
  assert.equal(health.identity, `97:${registry}:2003`);
  assert.equal(range.identity, `97:${registry}:2100`);
  assert.notEqual(health.ownerAddress, range.ownerAddress);
  // Health Guard's sealed baseline must not make Range Keeper hireable.
  assert.equal(selectHiringAdapter(health, { chainId: 97 }).status, "ready");
  assert.equal(selectHiringAdapter(range, { chainId: 97 }).status, "blocked");
  assert.match(range.selectionGate.readiness.reason, /humanBaselineSealed/);
  assert.deepEqual(referenceFleetIdentityFailures({ "health-factor": { agentId: 2003, registry, endpoint: "https://a/erc8183" }, rebalancing: { agentId: 2100, registry, endpoint: "https://b/erc8183" } }), []);
  const collision = referenceFleetIdentityFailures({ "health-factor": { agentId: 2003, registry, endpoint: "https://a/erc8183" }, rebalancing: { agentId: 2003, registry, endpoint: "https://a/erc8183" } });
  assert.ok(collision.some((entry) => entry.startsWith("shared_erc8004_identity")));
  assert.ok(collision.some((entry) => entry.startsWith("shared_endpoint")));
});

test("the independent control uses the same evidence and is never TermiX evidence", () => {
  const control = buildIndependentRangeControl({ task: { venue: "pancakeswap", pool, authoritativeSnapshot: snapshotAt() } });
  assert.equal(control.provenance.independent, true);
  assert.equal(control.provenance.humanBaseline, false);
  assert.equal(control.provenance.termixEligible, false);
  assert.equal(control.output.origin, "CANNED_INDEPENDENT_CONTROL");
  assert.equal(control.output.execution.mode, "control_only");
  assert.equal(control.output.decision.action, deliverable.output.decision.action);
});

test("Range Keeper with no runs adds nothing to public delivery or benchmark counts", () => {
  const spec = REFERENCE_AGENT_SPECS.find((item) => item.key === "rebalancing");
  const candidate = referenceAgentCandidate(spec, { providerAddress: "0x1", allowLocalProbe: false });
  const metrics = deriveMarketplaceMetrics({ candidates: [candidate], runs: [] });
  assert.equal(metrics.deliveries, 0);
  assert.equal(metrics.qualifyingBenchmarks, 0);
  assert.equal(metrics.jobsPaidForAndGraded, 0);
  assert.equal(metrics.categories.rebalancing.delivered, 0);
  assert.equal(metrics.categories.rebalancing.benchmarked, 0);
});
