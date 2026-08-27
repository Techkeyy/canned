import { canonicalJson, contentHashes, nowIso } from "../core.mjs";
import { CATEGORIES } from "../domain.mjs";
import { classifyVenusSnapshot, compareVenusSnapshots, validateAuthoritativeVenusSnapshot } from "./venus.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ORIGIN } from "./constants.mjs";

export const HEALTH_FACTOR_TASK_VERSION = "1.0.0";

export function validateHealthFactorTask(task = {}) {
  const errors = [];
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(task.account || ""))) errors.push("account_required");
  if (String(task.protocol || "").toLowerCase() !== "venus") errors.push("protocol_must_be_venus");
  if (!task.authoritativeSnapshot) errors.push("authoritative_snapshot_required");
  if (task.authoritativeSnapshot && !validateAuthoritativeVenusSnapshot(task.authoritativeSnapshot).valid) errors.push("authoritative_snapshot_invalid");
  return { valid: errors.length === 0, errors };
}

export function buildHealthFactorDeliverable({ jobId = null, task = {}, snapshot = task.authoritativeSnapshot, previousSnapshot = null, observedAt = nowIso() } = {}) {
  const taskValidation = validateHealthFactorTask({ ...task, authoritativeSnapshot: snapshot });
  if (!taskValidation.valid) {
    return {
      ok: false,
      status: "insufficient_authoritative_data",
      errors: taskValidation.errors,
      output: {
        schemaVersion: HEALTH_FACTOR_TASK_VERSION,
        origin: REFERENCE_ORIGIN,
        category: CATEGORIES.HEALTH_FACTOR_MONITORING,
        jobId: jobId === null ? null : Number(jobId),
        status: "INSUFFICIENT_AUTHORITATIVE_DATA",
        recommendation: "Do not act. Supply a fresh authoritative Venus position snapshot before assessing liquidation proximity.",
      },
    };
  }
  const assessment = classifyVenusSnapshot(snapshot, { warningHealthFactor: task.warningHealthFactor ?? null, criticalHealthFactor: task.criticalHealthFactor ?? null });
  const changes = compareVenusSnapshots(previousSnapshot, snapshot);
  const output = {
    schemaVersion: HEALTH_FACTOR_TASK_VERSION,
    origin: REFERENCE_ORIGIN,
    category: CATEGORIES.HEALTH_FACTOR_MONITORING,
    jobId: jobId === null ? null : Number(jobId),
    observedAt,
    position: {
      protocol: "Venus",
      poolType: snapshot.poolType,
      account: task.account,
      asOfBlock: snapshot.asOfBlock ?? null,
      source: snapshot.source,
    },
    assessment,
    changes,
    recommendation: {
      mode: "recommendation_only",
      automaticActionTaken: false,
      boundedAction: assessment.status === "LIQUIDATION_RISK" || assessment.status === "CRITICAL"
        ? "Re-read the position, then consider only a pre-approved collateral top-up or bounded repay sized by the operator."
        : "No intervention recommended from this snapshot; continue monitoring at the declared interval.",
      reason: "Canned Reference Agent is read-only by default and never moves capital without a separately approved policy.",
    },
    evidence: {
      authoritativeProtocol: "Venus",
      readSource: snapshot.readPlan || null,
      snapshotHash: contentHashes(snapshot).keccak256,
    },
  };
  return { ok: true, status: "delivered", output, canonicalOutput: canonicalJson(output) };
}

export function buildIndependentHealthFactorControl({ task = {}, snapshot = task.authoritativeSnapshot, previousSnapshot = null } = {}) {
  const built = buildHealthFactorDeliverable({ jobId: null, task, snapshot, previousSnapshot });
  return {
    ...built,
    output: built.output ? { ...built.output, origin: "CANNED_INDEPENDENT_CONTROL", control: true, recommendation: { ...built.output.recommendation, mode: "control_only" } } : built.output,
    provenance: { independent: true, kind: "deterministic_protocol_read_control", humanBaseline: false, termixEligible: false },
  };
}

export function manualHealthFactorBaselinePacket({ task = {}, snapshotReference = null, procedureVersion = "manual-health-factor-v1" } = {}) {
  return {
    packetVersion: procedureVersion,
    category: CATEGORIES.HEALTH_FACTOR_MONITORING,
    origin: "CANNED_MANUAL_BASELINE_REQUEST",
    chain: { network: "bsc-testnet", chainId: REFERENCE_CHAIN_ID },
    task: "Read this Venus position, record current liquidation proximity, explain changes since the prior observation, and state one bounded protective action without using Canned output.",
    positionReference: snapshotReference || { account: task.account || null, protocol: "Venus", poolType: task.poolType || null },
    contaminationBoundary: "Stop before opening or revealing the Canned agent result. Return the signed or timestamped human observation first.",
    requiredHumanFields: ["observedAt", "sourceUrlsOrContractReads", "positionFacts", "liquidationProximity", "changeExplanation", "boundedAction", "elapsedMs", "operatorCost"],
    expectedAnswer: null,
  };
}
