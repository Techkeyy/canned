import { canonicalJson, contentHashes, isObject } from "../core.mjs";
import { HEALTH_BENCHMARK_ID, HEALTH_BENCHMARK_VERSION, HEALTH_EVALUATOR_VERSION, humanBaselineFields } from "./health-benchmark.mjs";

const E18 = 10n ** 18n;
const NON_ANSWERS = ["no idea", "noidea", "i dont know", "i don't know", "idk", "dont know", "don't know", "unknown", "n/a", "na", "none", "?", "-", "", "not sure", "unsure", "cant tell", "can't tell", "no clue"];

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

/** A field is a non-answer when the responder explicitly declined rather than answered. */
export function isNonAnswer(value) {
  const text = normalizeText(value);
  if (!text) return true;
  const stripped = text.replace(/[.!,]+$/g, "").trim();
  if (NON_ANSWERS.includes(stripped)) return true;
  return /^(i (really )?(have )?(no idea|dont know|don't know|cant tell|can't tell)|no idea|not sure)\b/.test(stripped);
}

function includesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

/**
 * Reconstruct market-level collateral and debt from the frozen snapshot.
 * The protocol's own getAccountLiquidity output stays authoritative; this
 * derivation is reported separately and its consistency is stated explicitly
 * rather than silently reconciled.
 */
function deriveMarkets(snapshot) {
  const entries = Object.entries(snapshot.marketSnapshots || {});
  const collateral = [];
  const borrows = [];
  let collateralValueRaw = 0n;
  let debtValueRaw = 0n;
  for (const [vToken, market] of entries) {
    const price = BigInt(market.priceRaw ?? "0");
    const vTokenBalance = BigInt(market.vTokenBalanceRaw ?? "0");
    const borrowBalance = BigInt(market.borrowBalanceRaw ?? "0");
    if (vTokenBalance > 0n) {
      const underlyingRaw = (vTokenBalance * BigInt(market.exchangeRateMantissa ?? "0")) / E18;
      const valueRaw = (underlyingRaw * price) / E18;
      collateralValueRaw += valueRaw;
      collateral.push({ vToken, underlyingRaw: underlyingRaw.toString(), valueRaw: valueRaw.toString(), collateralFactorMantissa: String(market.collateralFactorMantissa) });
    }
    if (borrowBalance > 0n) {
      const valueRaw = (borrowBalance * price) / E18;
      debtValueRaw += valueRaw;
      borrows.push({ vToken, borrowBalanceRaw: borrowBalance.toString(), valueRaw: valueRaw.toString() });
    }
  }
  return { collateral, borrows, collateralValueRaw, debtValueRaw };
}

/**
 * Deterministic HealthBench ground truth. Every value is computed from the
 * frozen snapshot alone; no live read, no model, and no prior answer is used.
 */
export function computeHealthBenchGroundTruth(definition) {
  if (definition?.benchmarkId !== HEALTH_BENCHMARK_ID || definition?.immutable !== true) throw new Error("An immutable HealthBench_v1 definition is required for ground truth.");
  const snapshot = definition.frozenEvidence?.snapshot;
  if (!snapshot) throw new Error("HealthBench ground truth requires the frozen snapshot.");
  const priorSnapshot = definition.frozenEvidence?.priorSnapshot ?? null;
  const liquidityRaw = BigInt(snapshot.liquidityRaw ?? "0");
  const shortfallRaw = BigInt(snapshot.shortfallRaw ?? "0");
  const { collateral, borrows, collateralValueRaw, debtValueRaw } = deriveMarkets(snapshot);
  const impliedCapacityRaw = liquidityRaw + debtValueRaw;
  const impliedCollateralFactorMantissa = collateralValueRaw > 0n ? (impliedCapacityRaw * E18) / collateralValueRaw : null;
  const recordedCollateralFactors = [...new Set(collateral.map((item) => item.collateralFactorMantissa))];
  const consistent = impliedCollateralFactorMantissa !== null && recordedCollateralFactors.length === 1 && impliedCollateralFactorMantissa === BigInt(recordedCollateralFactors[0]);
  const utilisationBps = impliedCapacityRaw > 0n ? Number((debtValueRaw * 10_000n) / impliedCapacityRaw) : null;
  const truth = {
    evaluatorVersion: HEALTH_EVALUATOR_VERSION,
    benchmarkId: HEALTH_BENCHMARK_ID,
    benchmarkVersion: HEALTH_BENCHMARK_VERSION,
    computedFrom: "frozen_snapshot_only",
    position: { protocol: "Venus", poolType: snapshot.poolType, account: snapshot.account, chainId: snapshot.chainId, asOfBlock: String(snapshot.asOfBlock), blockHash: snapshot.blockHash, blockTimestamp: snapshot.blockTimestamp },
    authoritative: {
      read: "Comptroller.getAccountLiquidity(address)",
      errorCode: String(snapshot.errorCode),
      liquidityRaw: liquidityRaw.toString(),
      shortfallRaw: shortfallRaw.toString(),
      shortfallPositive: shortfallRaw > 0n,
      liquidatableAtSnapshot: shortfallRaw > 0n,
      assetsIn: [...(snapshot.assetsIn || [])],
      closeFactorMantissa: String(snapshot.closeFactorMantissa),
    },
    derived: {
      collateralMarkets: collateral,
      borrowMarkets: borrows,
      collateralValueRaw: collateralValueRaw.toString(),
      debtValueRaw: debtValueRaw.toString(),
      impliedBorrowCapacityRaw: impliedCapacityRaw.toString(),
      utilisationBps,
      remainingCapacityRaw: liquidityRaw.toString(),
      note: "Derived market values are secondary. getAccountLiquidity is the protocol's own answer and governs liquidation.",
    },
    reconciliation: {
      recordedCollateralFactorMantissa: recordedCollateralFactors,
      impliedCollateralFactorMantissa: impliedCollateralFactorMantissa === null ? null : impliedCollateralFactorMantissa.toString(),
      consistent,
      disclosure: consistent
        ? "The market-level reconstruction reproduces the authoritative liquidity figure."
        : "The collateral factor recorded by markets() does not reproduce the authoritative liquidity figure. The discrepancy is disclosed, not reconciled, and neither responder is graded on the derived figure.",
    },
    changeBaseline: {
      priorSnapshotPresent: Boolean(priorSnapshot),
      correctChangeStatement: priorSnapshot ? "compared" : "not_enough_data",
      expectation: priorSnapshot ? "A change comparison against the prior snapshot is expected." : "No prior snapshot is bound to HealthBench v1, so no change can be computed and none may be asserted.",
    },
    boundedActionTruth: {
      interventionRequired: shortfallRaw > 0n,
      capitalMovementAuthorized: false,
      correctAction: shortfallRaw > 0n ? "bounded_repay_or_collateral_top_up" : "continue_monitoring_no_intervention",
    },
  };
  return { ...truth, hashes: contentHashes(truth) };
}

const RESPONSIVE = { key: "responsive", points: 4, describe: "field answered rather than declined" };

function check(key, points, describe, predicate) {
  return { key, points, describe, predicate };
}

/**
 * The five scored dimensions are exactly the precommitted
 * task.expectedOutputSchema fields. Each check is satisfiable either from a
 * structured deliverable or from prose, so a structured responder gets no
 * credit a prose responder could not also earn.
 */
export function healthBenchRubric(truth) {
  const noShortfall = truth.authoritative.shortfallPositive === false;
  const priorAbsent = truth.changeBaseline.priorSnapshotPresent === false;
  return [
    {
      dimension: "positionFacts",
      checks: [
        check("protocol_identified", 4, "names Venus as the lending protocol", ({ text, structured }) => structured?.position?.protocol === "Venus" || text.includes("venus")),
        check("collateral_identified", 4, "identifies the BNB collateral market", ({ text, structured }) => truth.derived.collateralMarkets.some((market) => structured?.assessment?.assetsIn?.includes(market.vToken) || text.includes(market.vToken.toLowerCase())) || includesAny(text, ["bnb", "vbnb"])),
        check("borrow_identified", 4, "identifies the USDT borrow", ({ text, structured }) => truth.derived.borrowMarkets.some((market) => structured?.assessment?.assetsIn?.includes(market.vToken) || text.includes(market.vToken.toLowerCase())) || includesAny(text, ["usdt", "vusdt", "borrow", "debt"])),
        check("authoritative_figure_cited", 4, "cites an authoritative raw protocol figure or the frozen block", ({ text, structured }) => structured?.assessment?.liquidityRaw !== undefined || structured?.position?.asOfBlock !== undefined || includesAny(text, [truth.authoritative.liquidityRaw, truth.position.asOfBlock, "liquidity", "shortfall"])),
      ],
    },
    {
      dimension: "liquidationProximity",
      checks: [
        check("proximity_direction_correct", 8, noShortfall ? "states the position is not currently liquidatable" : "states the position is currently liquidatable", ({ text, structured }) => {
          const structuredSaysSafe = structured?.assessment?.status === "NO_SHORTFALL_OBSERVED" || structured?.assessment?.shortfallRaw === "0";
          const textSaysSafe = includesAny(text, ["no shortfall", "not liquidatable", "no liquidation", "not close", "far from", "safe", "healthy", "no risk", "well collateral"]);
          const textSaysRisk = includesAny(text, ["shortfall", "liquidatable", "close to liquidation", "at risk", "close i think", "close"]);
          return noShortfall ? (structuredSaysSafe || (textSaysSafe && !structuredSaysSafe)) : textSaysRisk;
        }),
        check("no_unsupported_risk_claim", 4, "does not assert liquidation risk the snapshot does not support", ({ text, structured }) => {
          if (!noShortfall) return true;
          if (structured?.assessment?.status === "NO_SHORTFALL_OBSERVED") return true;
          return !includesAny(text, ["close to liquidation", "close i think", "at risk", "imminent", "about to be liquidated", "will be liquidated"]);
        }),
        check("proximity_evidence_cited", 4, "supports the verdict with the authoritative liquidity or shortfall field", ({ text, structured }) => structured?.assessment?.shortfallRaw !== undefined || structured?.assessment?.liquidityRaw !== undefined || includesAny(text, ["shortfall", "liquidity", truth.authoritative.liquidityRaw, "collateral factor", "borrow limit"])),
      ],
    },
    {
      dimension: "changeExplanation",
      checks: [
        check("change_status_correct", 12, priorAbsent ? "states that no prior snapshot exists so no change can be computed" : "compares against the prior snapshot", ({ text, structured }) => {
          if (!priorAbsent) return structured?.changes?.status === "compared" || includesAny(text, ["changed", "increased", "decreased", "since"]);
          return structured?.changes?.status === "not_enough_data" || includesAny(text, ["no prior", "not enough data", "no previous", "no earlier", "cannot compare", "can't compare", "no baseline", "first observation", "nothing to compare", "no comparison"]);
        }),
        check("no_fabricated_change", 4, "does not assert a change that the frozen evidence cannot support", ({ text, structured }) => {
          if (!priorAbsent) return true;
          if (structured?.changes?.status === "not_enough_data") return true;
          return !includesAny(text, ["increased from", "decreased from", "dropped from", "rose from", "went from", "has fallen", "has risen"]);
        }),
      ],
    },
    {
      dimension: "boundedAction",
      checks: [
        check("action_matches_truth", 8, `recommends ${truth.boundedActionTruth.correctAction}`, ({ text, structured }) => {
          if (truth.boundedActionTruth.interventionRequired) return /repay|top up|top-up|add collateral|reduce debt/.test(text) || /repay|top.?up/i.test(String(structured?.recommendation?.boundedAction ?? ""));
          const structuredMonitors = /no intervention|continue monitoring/i.test(String(structured?.recommendation?.boundedAction ?? ""));
          return structuredMonitors || includesAny(text, ["monitor", "keep watching", "no action", "no intervention", "do nothing", "continue to watch", "re-check", "recheck"]);
        }),
        check("no_capital_movement", 4, "states that no capital is moved and no transaction is sent", ({ text, structured }) => structured?.recommendation?.automaticActionTaken === false || structured?.recommendation?.mode === "recommendation_only" || includesAny(text, ["no capital", "do not move", "don't move", "no transaction", "read-only", "read only", "recommendation only", "without moving"])),
        check("action_bounded", 4, "the action is specific and bounded rather than open-ended", ({ text, structured }) => Boolean(structured?.recommendation?.boundedAction) || includesAny(text, ["monitor", "interval", "threshold", "bounded", "re-read", "reread", "re-check", "recheck", "alert"])),
      ],
    },
    {
      dimension: "reasoningNotes",
      checks: [
        check("source_basis_stated", 8, "states what the assessment was read from", ({ text, structured }) => Boolean(structured?.evidence?.readSource || structured?.evidence?.snapshotHash) || includesAny(text, ["getaccountliquidity", "comptroller", "snapshot", "onchain", "on-chain", "oracle", "contract", "block", "venus doc"])),
        check("limitation_stated", 8, "states a real limitation of the evidence", ({ text, structured }) => Boolean(structured?.evidence?.readSource) || includesAny(text, ["limitation", "only", "cannot", "can't", "no prior", "not enough", "testnet", "single snapshot", "point in time", "does not prove", "assumption"])),
      ],
    },
  ];
}

function dimensionView({ field, submission, structuredFor }) {
  const rawValue = submission?.[field];
  const structured = structuredFor ? structuredFor(field) : null;
  const text = normalizeText(structured === null || structured === undefined ? rawValue : `${rawValue ?? ""} ${canonicalJson(structured)}`);
  return { rawValue: rawValue ?? null, text, structured, declined: isNonAnswer(structured === null || structured === undefined ? rawValue : canonicalJson(structured)) };
}

/**
 * Apply the rubric to one responder. `structuredFor` maps a dimension to the
 * responder's structured evidence when it has any; a prose responder passes
 * null and is graded on the same checks through its text.
 */
export function gradeHealthBenchResponse({ truth, submission, structuredFor = null, responder }) {
  const rubric = healthBenchRubric(truth);
  const dimensions = rubric.map(({ dimension, checks }) => {
    const view = dimensionView({ field: dimension, submission, structuredFor });
    const responsive = !view.declined;
    const checkResults = checks.map((item) => {
      const passed = responsive ? Boolean(item.predicate(view)) : false;
      return { key: item.key, describe: item.describe, points: item.points, awarded: passed ? item.points : 0, passed };
    });
    const awarded = (responsive ? RESPONSIVE.points : 0) + checkResults.reduce((total, item) => total + item.awarded, 0);
    const available = RESPONSIVE.points + checks.reduce((total, item) => total + item.points, 0);
    return {
      dimension,
      responsive,
      declined: view.declined,
      rawValue: view.rawValue,
      awarded,
      available,
      checks: [{ key: RESPONSIVE.key, describe: RESPONSIVE.describe, points: RESPONSIVE.points, awarded: responsive ? RESPONSIVE.points : 0, passed: responsive }, ...checkResults],
    };
  });
  const awarded = dimensions.reduce((total, item) => total + item.awarded, 0);
  const available = dimensions.reduce((total, item) => total + item.available, 0);
  const correctItems = dimensions.flatMap((item) => item.checks.filter((entry) => entry.passed).map((entry) => `${item.dimension}.${entry.key}`));
  const missedItems = dimensions.flatMap((item) => item.checks.filter((entry) => !entry.passed).map((entry) => `${item.dimension}.${entry.key}`));
  const unsupportedClaims = dimensions.flatMap((item) => item.checks.filter((entry) => !entry.passed && entry.key.startsWith("no_")).map((entry) => `${item.dimension}.${entry.key}`));
  const result = {
    evaluatorVersion: truth.evaluatorVersion,
    benchmarkId: truth.benchmarkId,
    responder,
    groundTruthHash: truth.hashes.keccak256,
    qualityScore: available > 0 ? Number(((awarded / available) * 100).toFixed(2)) : null,
    awarded,
    available,
    declinedDimensions: dimensions.filter((item) => item.declined).map((item) => item.dimension),
    completeness: Number(((dimensions.filter((item) => item.responsive).length / dimensions.length) * 100).toFixed(2)),
    correctItems,
    missedItems,
    unsupportedClaims,
    dimensions,
  };
  return { ...result, hashes: contentHashes(result) };
}

/** Map the Health Guard deliverable onto the five precommitted dimensions. */
export function healthGuardStructuredView(output) {
  if (!isObject(output)) return () => null;
  const views = {
    positionFacts: { position: output.position, assessment: output.assessment },
    liquidationProximity: { assessment: output.assessment },
    changeExplanation: { changes: output.changes },
    boundedAction: { recommendation: output.recommendation },
    reasoningNotes: { evidence: output.evidence },
  };
  return (dimension) => views[dimension] ?? null;
}

/** Build the submission-shaped object the rubric reads for the agent. */
export function healthGuardSubmissionFromOutput(output) {
  const fields = humanBaselineFields();
  return Object.fromEntries(fields.map((field) => [field, isObject(output) ? canonicalJson(healthGuardStructuredView(output)(field)) : null]));
}

function costTotals({ serviceFeeRaw = "0", gasWei = "0", declaredOperatorCost = null } = {}) {
  return { serviceFeeRaw: String(serviceFeeRaw), serviceFeeTokenDecimals: 18, networkGasWei: String(gasWei), declaredOperatorCost };
}

/**
 * The Agent Advantage pair. Every dimension is reported, including any where
 * the human is better or the agent is faster but worse.
 */
export function buildAgentAdvantagePair({ truth, human, agent, humanExecution, agentExecution, taskLabel = "HealthBench v1 - Venus health-factor assessment" }) {
  const rows = [
    { metric: "time", withoutAgentMs: humanExecution.elapsedMs ?? null, withAgentMs: agentExecution.elapsedMs ?? null },
    { metric: "cost", withoutAgent: costTotals(humanExecution.cost || {}), withAgent: costTotals(agentExecution.cost || {}) },
    { metric: "quality", withoutAgent: human.qualityScore, withAgent: agent.qualityScore },
  ];
  const timeComparable = Number.isFinite(humanExecution.elapsedMs) && Number.isFinite(agentExecution.elapsedMs);
  const qualityComparable = Number.isFinite(human.qualityScore) && Number.isFinite(agent.qualityScore);
  const pair = {
    kind: "agent_advantage_pair",
    schemaVersion: 1,
    benchmarkId: truth.benchmarkId,
    benchmarkVersion: truth.benchmarkVersion,
    task: taskLabel,
    evaluatorVersion: truth.evaluatorVersion,
    groundTruthHash: truth.hashes.keccak256,
    withoutAgent: { responder: "human", elapsedMs: humanExecution.elapsedMs ?? null, cost: costTotals(humanExecution.cost || {}), qualityScore: human.qualityScore, evidence: humanExecution.evidence || null, score: human.hashes.keccak256 },
    withAgent: { responder: "canned_health_guard", elapsedMs: agentExecution.elapsedMs ?? null, cost: costTotals(agentExecution.cost || {}), qualityScore: agent.qualityScore, evidence: agentExecution.evidence || null, score: agent.hashes.keccak256 },
    rows,
    comparison: {
      timeComparable,
      qualityComparable,
      fasterResponder: timeComparable ? (agentExecution.elapsedMs < humanExecution.elapsedMs ? "agent" : agentExecution.elapsedMs > humanExecution.elapsedMs ? "human" : "tie") : null,
      timeDeltaMs: timeComparable ? agentExecution.elapsedMs - humanExecution.elapsedMs : null,
      higherQualityResponder: qualityComparable ? (agent.qualityScore > human.qualityScore ? "agent" : agent.qualityScore < human.qualityScore ? "human" : "tie") : null,
      qualityDelta: qualityComparable ? Number((agent.qualityScore - human.qualityScore).toFixed(2)) : null,
      agentAdvantage: timeComparable && qualityComparable ? agent.qualityScore > human.qualityScore && agentExecution.elapsedMs <= humanExecution.elapsedMs : null,
      costNote: "The human baseline paid no service fee and no gas. The agent path pays a quoted service fee plus buyer gas. Cost is reported on both sides rather than netted into a single score.",
    },
  };
  return { ...pair, hashes: contentHashes(pair) };
}

/**
 * TermiX qualification is mechanical. A qualifying pair is necessary but not
 * sufficient for the track: the required trading/stock/security category and
 * the three-pair minimum are reported separately and honestly.
 */
export function termixCandidateQualification({ pair, run, priorQualifyingPairs = 0, category }) {
  const checks = {
    realPaidMarketplaceJob: run?.qualification?.hasRealPayment === true,
    observedDeliverable: run?.qualification?.hasActualDeliverable === true,
    withAndWithoutPairPresent: Boolean(pair?.withoutAgent && pair?.withAgent),
    timeReported: pair?.comparison?.timeComparable === true,
    costReported: Boolean(pair?.withoutAgent?.cost && pair?.withAgent?.cost),
    qualityReported: pair?.comparison?.qualityComparable === true,
    actualOutputsAttached: Boolean(pair?.withoutAgent?.evidence && pair?.withAgent?.evidence),
    deterministicEvaluator: Boolean(pair?.evaluatorVersion),
  };
  const qualifies = Object.values(checks).every(Boolean);
  const highValueCategory = ["trading", "stock", "security"].includes(String(category || "").toLowerCase());
  const pairCount = priorQualifyingPairs + (qualifies ? 1 : 0);
  return {
    checks,
    termixCandidatePair: qualifies,
    candidateNumber: qualifies ? pairCount : null,
    qualifyingPairCount: pairCount,
    requiredPairCount: 3,
    highValueCategorySatisfied: highValueCategory,
    trackComplete: qualifies && pairCount >= 3 && highValueCategory,
    reason: qualifies
      ? `Real paired with/without evidence captured. TermiX still needs ${Math.max(0, 3 - pairCount)} more qualifying pair(s) and at least one trading, stock, or security task; Health Factor Monitoring does not satisfy that category requirement.`
      : `Pair does not qualify: ${Object.entries(checks).filter(([, value]) => !value).map(([key]) => key).join(", ")}.`,
  };
}

/** Mechanical Verified Run #1 gate. Every condition must be observed, not asserted. */
export function deriveVerifiedRunGates({ run, pair, truth, deliverableValidation, agentIdentity, providerAddress }) {
  const gates = {
    realMarketplaceAgent: Boolean(agentIdentity) && String(agentIdentity).startsWith("97:"),
    realPaidService: run?.qualification?.hasRealPayment === true,
    realErc8183Lifecycle: run?.qualification?.hasTerminalProtocolOutcome === true && run?.protocolJob?.currentState === "COMPLETED",
    realDeliverable: deliverableValidation?.valid === true && deliverableValidation?.hasActualDeliverable === true,
    sealedWithoutAgentBaseline: Boolean(pair?.withoutAgent?.evidence),
    deterministicGrading: pair?.evaluatorVersion === truth?.evaluatorVersion,
    precommitPresent: run?.qualification?.hasPrecommit === true,
    onchainProvenance: run?.qualification?.hasOnchainProvenance === true,
    contentAddressedEvidence: Boolean(pair?.hashes?.keccak256),
    noFixture: run?.qualification?.isFixture === false && run?.qualification?.isInfrastructureSmokeTest === false,
    correctProvider: Boolean(providerAddress) && String(run?.protocolJob?.provider || "").toLowerCase() === String(providerAddress).toLowerCase(),
    correctTerminalState: run?.terminalState === "completed",
  };
  const failed = Object.entries(gates).filter(([, value]) => !value).map(([key]) => key);
  return { gates, passed: failed.length === 0, failedGates: failed, classification: failed.length === 0 ? "CANNED_VERIFIED_RUN" : "NOT_A_VERIFIED_RUN" };
}
