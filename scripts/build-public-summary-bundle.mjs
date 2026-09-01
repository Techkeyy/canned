import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicMppEvidence } from "../src/reference/health-factor-mpp.mjs";
import { buildLeash } from "../src/marketplace/leash.mjs";
import { summarizeRangeTrackRecord } from "../src/reference/range-track-record.mjs";
import { summarizeYieldTrackRecord } from "../src/reference/yield-track-record.mjs";
import { loadGradingArtifact } from "../src/marketplace/termix-evidence.mjs";

/*
 * Build the VPS data directory from canonical records without copying raw
 * human answers, agent outputs, benchmark workspaces, grading sources, or
 * mutable runtime state. CANNED_PUBLIC_OUTPUT_DIR is mandatory so an operator
 * cannot accidentally overwrite canonical local evidence.
 */
const canonicalDataDir = path.resolve(process.env.CANNED_CANONICAL_DATA_DIR || path.join(process.cwd(), "data"));
const publicDataDirValue = process.env.CANNED_PUBLIC_OUTPUT_DIR;
if (!publicDataDirValue) throw new Error("CANNED_PUBLIC_OUTPUT_DIR is required for a safe public summary build.");
const publicDataDir = path.resolve(publicDataDirValue);
const canonicalStateDir = path.join(canonicalDataDir, "state");
const publicStateDir = path.join(publicDataDir, "state");
const publicInventoryDir = path.join(publicDataDir, "inventory");

async function loadJson(root, relativePath, fallback = null) {
  try { return JSON.parse(await readFile(path.join(root, relativePath), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function sha256File(file) {
  return `sha256:${createHash("sha256").update(await readFile(file)).digest("hex")}`;
}

async function writeJson(relativePath, value) {
  const file = path.join(publicDataDir, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function publicUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "ipfs:"].includes(parsed.protocol) ? value : null;
  } catch { return null; }
}

function publicCost(cost = null) {
  if (!cost || typeof cost !== "object") return null;
  return {
    declaredOperatorCost: cost.declaredOperatorCost ?? null,
    serviceFeeRaw: cost.serviceFeeRaw ?? null,
    serviceFeeTokenDecimals: cost.serviceFeeTokenDecimals ?? null,
    networkGasWei: cost.networkGasWei ?? null,
  };
}

function publicLeashEvidence(strategyRecord, sessionRecord, proofRecord) {
  const strategy = strategyRecord?.strategy;
  const sourceSession = sessionRecord?.session;
  const proof = proofRecord?.steps || {};
  if (!strategy || !sourceSession) {
    return {
      schemaVersion: 1,
      publicProjection: true,
      state: "NOT_CONFIGURED",
      summary: "No granted session is included in this public projection.",
      note: "The public deployment does not copy mutable Altana session state.",
    };
  }

  const session = {
    walletAddress: sourceSession.walletAddress ?? null,
    publicKey: sourceSession.sessionPublicKey ?? sourceSession.publicKey ?? null,
    expiry: sourceSession.expiry ?? null,
    permissions: {
      calls: Array.isArray(sourceSession.permissions?.calls)
        ? sourceSession.permissions.calls.map((call) => ({
          to: call.to ?? call.contract ?? null,
          signature: call.signature ?? call.method ?? call.selector ?? null,
        }))
        : [],
      spend: Array.isArray(sourceSession.permissions?.spend)
        ? sourceSession.permissions.spend.map((item) => ({
          limit: item.limit ?? null,
          period: item.period ?? null,
          token: item.token ?? null,
          purpose: item.purpose ?? null,
        }))
        : [],
    },
  };
  const network = {
    chainId: sourceSession.chainId ?? 97,
    chain: { name: "BNB Smart Chain Testnet", nativeCurrency: { symbol: "tBNB" } },
    keyStore: sourceSession.keyStore ?? null,
    explorer: sourceSession.explorer ?? "https://testnet.bscscan.com",
  };
  const leash = buildLeash({
    strategy,
    session,
    network,
    revoked: sessionRecord?.revoked === true,
  });
  const executions = Array.isArray(sourceSession.executions)
    ? sourceSession.executions.map((execution) => ({
      attempted: execution.attempted ?? null,
      succeeded: execution.succeeded ?? null,
      relayStatus: execution.relayStatus ?? null,
      transactionHash: execution.transactionHash ?? null,
      callsId: execution.callsId ?? null,
      signedBy: execution.signedBy ?? null,
      sessionKeyAddress: execution.sessionKeyAddress ?? null,
      router: execution.router ?? null,
      selector: execution.selector ?? null,
      method: execution.method ?? null,
      path: Array.isArray(execution.path) ? [...execution.path] : [],
      withinTradeCap: execution.withinTradeCap ?? null,
      withinNativeCap: execution.withinNativeCap ?? null,
      fillsUsed: execution.fillsUsed ?? null,
      maxFills: execution.maxFills ?? null,
    }))
    : [];
  const refusal = proof.revokedKeyRefused || null;
  const allowance = proof.allowanceCleared || null;
  return {
    schemaVersion: 1,
    publicProjection: true,
    ...leash,
    grantTransactionHash: sourceSession.grantTransactionHash ?? null,
    revocationTransactionHash: sourceSession.revocationTransactionHash ?? null,
    executions,
    proof: {
      successfulUseObserved: executions.some((execution) => execution.succeeded === true),
      revoked: sessionRecord?.revoked === true,
      revokedRetry: {
        refused: refusal?.refused ?? null,
        verdict: refusal?.verdict ?? null,
        sessionKeyRemoved: refusal?.onchainKeyCheck?.sessionKeyStillAuthorized === false ? true : null,
      },
      allowanceCleared: allowance?.residualAllowanceRaw === "0" ? true : null,
    },
    note: "Derived from the canonical Altana proof. Exact keys and mutable session state are not included.",
  };
}

function publicScore(score = null) {
  if (!score || typeof score !== "object") return null;
  return {
    qualityScore: score.qualityScore ?? null,
    awarded: score.awarded ?? null,
    available: score.available ?? null,
    benchmarkId: score.benchmarkId ?? null,
    evaluatorVersion: score.evaluatorVersion ?? null,
    completeness: score.completeness ?? null,
  };
}

function publicEvidence(evidence = null) {
  if (!evidence || typeof evidence !== "object") return null;
  return {
    sha256: evidence.sha256 ?? null,
    keccak256: evidence.keccak256 ?? null,
    durablePublicStorage: evidence.durablePublicStorage ?? null,
    deliverableCid: evidence.deliverableCid ?? null,
    deliverableUrl: publicUrl(evidence.deliverableUrl),
  };
}

function publicSide(side = null, score = null) {
  if (!side || typeof side !== "object") return null;
  return {
    elapsedMs: side.elapsedMs ?? null,
    qualityScore: side.qualityScore ?? null,
    responder: side.responder ?? null,
    cost: publicCost(side.cost),
    evidence: publicEvidence(side.evidence),
    score: publicScore(score || side.score),
    deliverableCid: side.deliverableCid ?? side.evidence?.deliverableCid ?? null,
    deliverableUrl: publicUrl(side.deliverableUrl),
  };
}

function publicComparison(comparison = null) {
  if (!comparison || typeof comparison !== "object") return null;
  return {
    agentAdvantage: comparison.agentAdvantage ?? null,
    costNote: comparison.costNote ?? null,
    fasterResponder: comparison.fasterResponder ?? null,
    higherQualityResponder: comparison.higherQualityResponder ?? null,
    qualityComparable: comparison.qualityComparable ?? null,
    qualityDelta: comparison.qualityDelta ?? null,
    timeComparable: comparison.timeComparable ?? null,
    timeDeltaMs: comparison.timeDeltaMs ?? null,
  };
}

function publicTermix(termix = null) {
  if (!termix || typeof termix !== "object") return null;
  return {
    candidateNumber: termix.candidateNumber ?? null,
    categoryOfThisPair: termix.categoryOfThisPair ?? null,
    highValueCategorySatisfied: termix.highValueCategorySatisfied ?? null,
    qualifyingPairCount: termix.qualifyingPairCount ?? null,
    requiredPairCount: termix.requiredPairCount ?? null,
    termixCandidatePair: termix.termixCandidatePair ?? null,
    trackComplete: termix.trackComplete ?? null,
    reason: termix.reason ?? null,
  };
}

function publicVerifiedRun(verifiedRun = null) {
  if (!verifiedRun || typeof verifiedRun !== "object") return null;
  return {
    classification: verifiedRun.classification ?? null,
    passed: verifiedRun.passed ?? null,
    failedGates: Array.isArray(verifiedRun.failedGates) ? [...verifiedRun.failedGates] : [],
  };
}

function publicBenchmarkSummary(definition, definitionSha256 = null) {
  if (!definition || typeof definition !== "object") return null;
  const base = {
    id: definition.benchmarkId ?? null,
    version: definition.version ?? null,
    category: definition.category ?? null,
    venue: definition.venue ?? null,
    chain: definition.chain ? {
      network: definition.chain.network ?? null,
      chainId: definition.chain.chainId ?? null,
    } : null,
    referenceBlock: definition.referenceBlock ? {
      number: definition.referenceBlock.number ?? null,
      hash: definition.referenceBlock.hash ?? null,
      timestamp: definition.referenceBlock.timestamp ?? null,
    } : null,
    definitionSha256,
  };
  if (definition.benchmarkId === "RebalanceBench_v1") {
    base.executionBoundary = definition.executionBoundary ? {
      marketDataChain: definition.executionBoundary.marketDataChain ?? null,
      marketDataAccess: definition.executionBoundary.marketDataAccess ?? null,
      paymentAndAgentExecutionChain: definition.executionBoundary.paymentAndAgentExecutionChain ?? null,
      paymentChainId: definition.executionBoundary.paymentChainId ?? null,
      mainnetWriteAuthorized: definition.executionBoundary.mainnetWriteAuthorized ?? null,
    } : null;
    base.pool = definition.pool ? {
      address: definition.pool.address ?? null,
      token0: definition.pool.token0 ? { symbol: definition.pool.token0.symbol ?? null } : null,
      token1: definition.pool.token1 ? { symbol: definition.pool.token1.symbol ?? null } : null,
      fee: definition.pool.fee ?? null,
      feePercent: definition.pool.feePercent ?? null,
      tickSpacing: definition.pool.tickSpacing ?? null,
    } : null;
    base.position = definition.position ? {
      tokenId: definition.position.tokenId ?? null,
      tickLower: definition.position.tickLower ?? null,
      tickUpper: definition.position.tickUpper ?? null,
    } : null;
  }
  if (definition.benchmarkId === "YieldBench_v1") {
    base.executionBoundary = definition.executionBoundary ? {
      marketDataChain: definition.executionBoundary.marketDataChain ?? null,
      marketDataAccess: definition.executionBoundary.marketDataAccess ?? null,
      paymentAndAgentExecutionChain: definition.executionBoundary.paymentAndAgentExecutionChain ?? null,
      paymentChainId: definition.executionBoundary.paymentChainId ?? null,
      mainnetWriteAuthorized: definition.executionBoundary.mainnetWriteAuthorized ?? null,
      capitalMovementAuthorized: definition.executionBoundary.capitalMovementAuthorized ?? null,
    } : null;
    base.position = definition.position ? {
      marketKey: definition.position.marketKey ?? null,
      assetSymbol: definition.position.assetSymbol ?? null,
      amount: definition.position.amount ?? null,
    } : null;
    base.horizonDays = definition.horizonDays ?? null;
    base.marketsCompared = Array.isArray(definition.frozenEvidence?.snapshot?.markets)
      ? definition.frozenEvidence.snapshot.markets.length
      : null;
  }
  if (definition.benchmarkId === "HealthBench_v1") {
    base.position = definition.position ? {
      account: definition.position.account ?? null,
      protocol: definition.position.protocol ?? null,
      poolType: definition.position.poolType ?? null,
      assetSymbol: definition.position.assetSymbol ?? null,
      amount: definition.position.amount ?? null,
    } : null;
  }
  return base;
}

function taskSummary(benchmarkId) {
  return {
    HealthBench_v1: "Frozen Venus health-factor monitoring comparison",
    RebalanceBench_v1: "Frozen PancakeSwap range-rebalancing comparison",
    YieldBench_v1: "Frozen Venus yield-optimisation comparison",
  }[benchmarkId] || "Canonical benchmark comparison";
}

function publicRun(run) {
  const metrics = run?.evaluation?.metrics || {};
  const publicMetrics = {};
  for (const key of [
    "humanQualityScore", "agentQualityScore", "humanElapsedMs", "agentElapsedMs",
    "agentAdvantage", "qualityDelta", "timeDeltaMs", "fasterResponder",
    "higherQualityResponder", "qualityComparable", "timeComparable",
  ]) {
    if (metrics[key] !== undefined) publicMetrics[key] = metrics[key];
  }
  const events = (run?.protocolJob?.events || [])
    .filter((event) => event?.tx?.transactionHash)
    .map((event) => ({
      event: event.event ?? null,
      createdAt: event.createdAt ?? null,
      status: event.snapshot?.status ?? null,
      transactionHash: event.tx.transactionHash,
    }));
  return {
    schemaVersion: run?.schemaVersion ?? 1,
    kind: run?.kind ?? null,
    runId: run?.runId ?? null,
    runType: run?.runType ?? null,
    createdAt: run?.createdAt ?? null,
    completedAt: run?.completedAt ?? run?.endedAt ?? null,
    terminalState: run?.terminalState ?? null,
    agent: run?.agent ? {
      identity: run.agent.identity ?? null,
      name: run.agent.name ?? null,
      category: run.agent.category ?? null,
      origin: run.agent.origin ?? null,
    } : null,
    benchmark: run?.benchmark ? {
      id: run.benchmark.id ?? null,
      version: run.benchmark.version ?? null,
      category: run.benchmark.category ?? null,
    } : null,
    agentExecution: run?.agentExecution ? {
      status: run.agentExecution.status ?? null,
      elapsedMs: run.agentExecution.elapsedMs ?? null,
      cost: publicCost(run.agentExecution.cost),
      deliverableUrl: publicUrl(run.agentExecution.deliverableUrl),
      deliverableValidation: run.agentExecution.deliverableValidation ? {
        valid: run.agentExecution.deliverableValidation.valid ?? null,
        hasActualDeliverable: run.agentExecution.deliverableValidation.hasActualDeliverable ?? null,
      } : null,
      evidence: publicEvidence(run.agentExecution.evidence),
    } : null,
    controlExecution: run?.controlExecution ? {
      status: run.controlExecution.status ?? null,
      elapsedMs: run.controlExecution.elapsedMs ?? null,
      cost: publicCost(run.controlExecution.cost),
    } : null,
    evaluation: run?.evaluation ? {
      status: run.evaluation.status ?? null,
      evaluator: run.evaluation.evaluator ?? null,
      metrics: publicMetrics,
    } : null,
    manifest: run?.manifest ? {
      hash: run.manifest.hash ?? null,
      level: run.manifest.level ?? null,
      offchainContentHash: run.manifest.offchainContentHash ?? null,
      publicPrecommitAnchor: run.manifest.publicPrecommitAnchor ?? null,
    } : null,
    protocolJob: run?.protocolJob ? {
      protocol: run.protocolJob.protocol ?? null,
      network: run.protocolJob.network ?? null,
      paymentToken: run.protocolJob.paymentToken ?? null,
      jobId: run.protocolJob.jobId ?? null,
      funded: run.protocolJob.funded ?? null,
      currentState: run.protocolJob.currentState ?? null,
      agentIdentity: run.protocolJob.agentIdentity ?? null,
      provider: run.protocolJob.provider ?? null,
      precommitHash: run.protocolJob.precommitHash ?? null,
      events,
    } : null,
    provenance: run?.provenance ? { mode: run.provenance.mode ?? null } : null,
    qualification: run?.qualification ? {
      isVerifiedRun: run.qualification.isVerifiedRun ?? null,
      verifiedRunNumber: run.qualification.verifiedRunNumber ?? null,
      qualifiesForAgentTrackRecord: run.qualification.qualifiesForAgentTrackRecord ?? null,
      qualifiesForPublicMetrics: run.qualification.qualifiesForPublicMetrics ?? null,
      hasActualDeliverable: run.qualification.hasActualDeliverable ?? null,
      hasOnchainProvenance: run.qualification.hasOnchainProvenance ?? null,
      protocolCompleted: run.qualification.protocolCompleted ?? null,
    } : null,
  };
}

function publicNegotiationProbe(probe = null) {
  if (!probe || typeof probe !== "object") return null;
  const quote = probe.quote && typeof probe.quote === "object" ? {
    price: probe.quote.price ?? null,
    currency: probe.quote.currency ?? null,
    quoteExpiresAt: probe.quote.quoteExpiresAt ?? null,
  } : null;
  return {
    ok: probe.ok ?? null,
    accepted: probe.accepted ?? null,
    endpoint: publicUrl(probe.endpoint),
    error: probe.error ?? null,
    quote,
  };
}

function publicCandidate(candidate) {
  return {
    identity: candidate?.identity ?? null,
    name: candidate?.name ?? null,
    description: candidate?.description ?? null,
    network: candidate?.network ?? null,
    chainId: candidate?.chainId ?? null,
    ownerAddress: candidate?.ownerAddress ?? null,
    agentWallet: candidate?.agentWallet ?? null,
    origin: candidate?.origin ?? "THIRD_PARTY_DISCOVERY",
    reference: candidate?.reference === true,
    referenceKey: candidate?.referenceKey ?? null,
    venue: candidate?.venue ?? null,
    erc8004: candidate?.erc8004 ? {
      status: candidate.erc8004.status ?? null,
      tokenId: candidate.erc8004.tokenId ?? null,
      registry: candidate.erc8004.registry ?? null,
      transactionHash: candidate.erc8004.transactionHash ?? null,
      agentUri: publicUrl(candidate.erc8004.agentUri),
      indexed: candidate.erc8004.indexed ?? null,
    } : null,
    categoryHypotheses: Array.isArray(candidate?.categoryHypotheses)
      ? candidate.categoryHypotheses.map((item) => ({
        category: item.category ?? null,
        confidence: item.confidence ?? null,
        signals: Array.isArray(item.signals) ? item.signals.slice(0, 8) : [],
      }))
      : [],
    services: Array.isArray(candidate?.services) ? candidate.services.map((service) => ({
      type: service.type ?? null,
      endpoint: publicUrl(service.endpoint),
      description: service.description ?? null,
      advertised: service.advertised ?? null,
      cannedVerified: service.cannedVerified ?? null,
      successfullyUsed: service.successfullyUsed ?? null,
      status: service.status ?? null,
    })) : [],
    probes: Array.isArray(candidate?.probes) ? candidate.probes.map((probe) => ({
      type: probe.type ?? null,
      endpoint: publicUrl(probe.endpoint),
      reachable: probe.reachable ?? null,
      callable: probe.callable ?? null,
      observedAt: probe.observedAt ?? null,
      origin: probe.origin ?? null,
      scope: probe.scope ?? null,
    })) : [],
    supports: candidate?.supports || {},
    selectionGate: candidate?.selectionGate ? {
      allGatesPassed: candidate.selectionGate.allGatesPassed ?? null,
      benchmarkable: candidate.selectionGate.benchmarkable ?? null,
      categoryFit: candidate.selectionGate.categoryFit ?? null,
      genuinelyCallable: candidate.selectionGate.genuinelyCallable ?? null,
      identityOnBsc: candidate.selectionGate.identityOnBsc ?? null,
      liveService: candidate.selectionGate.liveService ?? null,
      safeBoundedExecution: candidate.selectionGate.safeBoundedExecution ?? null,
      readiness: candidate.selectionGate.readiness ? {
        ready: candidate.selectionGate.readiness.ready ?? null,
        quoteVerified: candidate.selectionGate.readiness.quoteVerified ?? null,
        protocolCompatibility: candidate.selectionGate.readiness.protocolCompatibility ?? null,
        providerConfigured: candidate.selectionGate.readiness.providerConfigured ?? null,
        publicReadinessVerified: candidate.selectionGate.readiness.publicReadinessVerified ?? null,
        humanBaselineSealed: candidate.selectionGate.readiness.humanBaselineSealed ?? null,
        reason: candidate.selectionGate.readiness.reason ?? null,
      } : null,
    } : null,
    hiring: candidate?.hiring ? {
      price: candidate.hiring.price ?? null,
      currency: candidate.hiring.currency ?? null,
      mechanism: candidate.hiring.mechanism ?? null,
      quoteVerified: candidate.hiring.quoteVerified ?? null,
      negotiationProbe: publicNegotiationProbe(candidate.hiring.negotiationProbe),
    } : null,
  };
}

function publicIdentity(record) {
  if (!record || typeof record !== "object") return null;
  return {
    schemaVersion: record.schemaVersion ?? 1,
    name: record.name ?? null,
    origin: record.origin ?? null,
    referenceKey: record.referenceKey ?? null,
    category: record.category ?? null,
    venue: record.venue ?? null,
    network: record.network ?? null,
    chainId: record.chainId ?? null,
    agentId: record.agentId ?? null,
    registry: record.registry ?? null,
    transactionHash: record.transactionHash ?? null,
    agentUri: publicUrl(record.agentUri),
    provider: record.provider ?? null,
    endpoint: publicUrl(record.endpoint),
    publicReadinessVerified: record.publicReadinessVerified ?? null,
    quoteVerified: record.quoteVerified ?? null,
    negotiationProbe: publicNegotiationProbe(record.negotiationProbe),
    readinessCheckedAt: record.readinessCheckedAt ?? null,
    indexer: record.indexer ?? null,
  };
}

function publicPair({ entry, grading, run, definition, definitionSha256 }) {
  const withSource = grading?.pair?.withAgent || entry?.pair?.withAgent;
  const withoutSource = grading?.pair?.withoutAgent || entry?.pair?.withoutAgent;
  const withScore = grading?.agent?.score || withSource?.score;
  const withoutScore = grading?.human?.score || withoutSource?.score;
  const withAgent = publicSide(withSource, withScore);
  const withoutAgent = publicSide(withoutSource, withoutScore);
  const publicPairRecord = {
    runId: grading?.runId ?? entry.runId ?? null,
    jobId: grading?.jobId ?? entry.jobId ?? null,
    benchmarkId: grading?.benchmarkId ?? entry.benchmarkId ?? null,
    benchmarkVersion: grading?.benchmarkVersion ?? entry.benchmarkVersion ?? null,
    category: entry.category ?? grading?.pair?.category ?? null,
    taskSummary: taskSummary(grading?.benchmarkId ?? entry.benchmarkId),
    agent: {
      identity: grading?.identity ?? entry.identity ?? null,
      name: run?.agent?.name ?? null,
      provider: grading?.provider ?? null,
    },
    benchmark: publicBenchmarkSummary(definition, definitionSha256),
    referenceBlock: grading?.referenceBlock ?? definition?.referenceBlock ?? null,
    evaluatorVersion: grading?.evaluatorVersion ?? grading?.pair?.evaluatorVersion ?? null,
    withoutAgent,
    withAgent,
    comparison: publicComparison(grading?.pair?.comparison ?? entry?.pair?.comparison),
    termix: publicTermix(grading?.termix ?? entry?.termix),
    verifiedRun: publicVerifiedRun(grading?.verifiedRun ?? entry?.verifiedRun),
    protocol: {
      network: run?.protocolJob?.network ?? null,
      transactions: (run?.protocolJob?.events || [])
        .filter((event) => event?.tx?.transactionHash)
        .map((event) => ({ event: event.event ?? null, transactionHash: event.tx.transactionHash })),
    },
    reconciliation: run?.reconciliation && typeof run.reconciliation === "object" ? {
      status: run.reconciliation.status ?? null,
      reason: run.reconciliation.reason ?? null,
    } : null,
    provenance: {
      sourceType: "canonical-grading-record",
      sourceArtifactSha256: definitionSha256,
      sourcePairSha256: grading?.pairEvidence?.sha256 || grading?.pair?.hashes?.sha256 || null,
      runId: grading?.runId ?? entry.runId ?? null,
      benchmarkId: grading?.benchmarkId ?? entry.benchmarkId ?? null,
    },
    gradedAt: grading?.gradedAt ?? entry.gradedAt ?? null,
  };
  return publicPairRecord;
}

function latestResult(pair) {
  if (!pair) return null;
  return {
    runId: pair.runId,
    jobId: pair.jobId,
    identity: pair.agent.identity,
    evaluatorVersion: pair.evaluatorVersion,
    humanQualityScore: pair.withoutAgent?.qualityScore ?? null,
    agentQualityScore: pair.withAgent?.qualityScore ?? null,
    humanElapsedMs: pair.withoutAgent?.elapsedMs ?? null,
    agentElapsedMs: pair.withAgent?.elapsedMs ?? null,
    agentAdvantage: pair.comparison?.agentAdvantage ?? null,
    serviceFeeRaw: pair.withAgent?.cost?.serviceFeeRaw ?? null,
    buyerGasWei: pair.withAgent?.cost?.networkGasWei ?? null,
    deliverableCid: pair.withAgent?.deliverableCid ?? pair.withAgent?.evidence?.deliverableCid ?? null,
    deliverableUrl: pair.withAgent?.deliverableUrl ?? null,
    termix: pair.termix,
    verifiedRun: pair.verifiedRun,
    gradedAt: pair.gradedAt,
  };
}

const inventory = await loadJson(canonicalDataDir, "inventory/verified-candidates.json", { candidates: [] });
const storedPairs = await loadJson(canonicalDataDir, "state/agent-advantage-pairs.json", { pairs: [] });
const canonicalRuns = await loadJson(canonicalDataDir, "state/benchmark-runs.json", []);
const publicRuns = Array.isArray(canonicalRuns)
  ? canonicalRuns
    .filter((run) => !/fixture|infrastructure/iu.test(String(run?.runType || "")))
    .map(publicRun)
  : [];

const definitionNames = {
  HealthBench_v1: "state/healthbench-v1.json",
  RebalanceBench_v1: "state/rebalancebench-v1.json",
  YieldBench_v1: "state/yieldbench-v1.json",
};
const definitions = {};
const definitionHashes = {};
for (const [id, relativePath] of Object.entries(definitionNames)) {
  definitions[id] = await loadJson(canonicalDataDir, relativePath, null);
  try { definitionHashes[id] = await sha256File(path.join(canonicalStateDir, path.basename(relativePath))); }
  catch (error) { if (error?.code !== "ENOENT") throw error; definitionHashes[id] = null; }
}

const pairs = [];
for (const entry of storedPairs.pairs || []) {
  const gradingRecord = await loadGradingArtifact({
    stateDir: canonicalStateDir,
    runId: entry.runId,
    benchmarkId: entry.benchmarkId,
  });
  if (!gradingRecord) throw new Error(`No canonical grading artifact for ${entry.runId}/${entry.benchmarkId}`);
  const run = publicRuns.find((candidate) => candidate.runId === entry.runId) || null;
  pairs.push(publicPair({
    entry,
    grading: gradingRecord.artifact,
    run: canonicalRuns.find((candidate) => candidate.runId === entry.runId) || null,
    definition: definitions[entry.benchmarkId],
    definitionSha256: await sha256File(path.join(canonicalStateDir, gradingRecord.name)),
  }));
}

const publicMpp = publicMppEvidence(await loadJson(canonicalDataDir, "state/mpp-payment-reconciliation.json", null));
const publicLeash = publicLeashEvidence(
  await loadJson(canonicalDataDir, "state/grid-strategy.json", null),
  await loadJson(canonicalDataDir, "state/grid-session.json", null),
  await loadJson(canonicalDataDir, "state/altana-final-proof.json", null),
);
const rangeDecisions = await loadJson(canonicalDataDir, "state/range-decisions.json", []);
const yieldDecisions = await loadJson(canonicalDataDir, "state/yield-decisions.json", []);
const rangePair = pairs.find((pair) => pair.benchmarkId === "RebalanceBench_v1") || null;
const yieldPair = pairs.find((pair) => pair.benchmarkId === "YieldBench_v1") || null;
const publicTrackRecords = {
  schemaVersion: 1,
  publicProjection: true,
  range: {
    agent: "Canned Range Keeper",
    venue: "PancakeSwap",
    benchmark: publicBenchmarkSummary(definitions.RebalanceBench_v1, definitionHashes.RebalanceBench_v1),
    latestResult: latestResult(rangePair),
    ...summarizeRangeTrackRecord({ decisions: Array.isArray(rangeDecisions) ? rangeDecisions : [] }),
  },
  yield: {
    agent: "Canned Yield Scout",
    venue: "Venus",
    benchmark: publicBenchmarkSummary(definitions.YieldBench_v1, definitionHashes.YieldBench_v1),
    latestResult: latestResult(yieldPair),
    ...summarizeYieldTrackRecord({ decisions: Array.isArray(yieldDecisions) ? yieldDecisions : [] }),
  },
  note: "Track-record figures are derived from canonical decision records; exact human and agent outputs are not included in this public projection.",
};

const publicInventoryCandidates = (inventory.candidates || []).map(publicCandidate);
const publicCategorySummary = {};
for (const candidate of publicInventoryCandidates) {
  for (const item of candidate.categoryHypotheses || []) {
    publicCategorySummary[item.category] = (publicCategorySummary[item.category] || 0) + 1;
  }
}

await writeJson("inventory/verified-candidates.json", {
  schemaVersion: 1,
  kind: "canned_public_inventory_summary",
  network: "bsc-testnet",
  chainId: 97,
  observedAt: inventory.observedAt ?? null,
  searchedCount: inventory.searchedCount ?? null,
  discoveredCandidateCount: publicInventoryCandidates.length,
  categorySummary: publicCategorySummary,
  candidates: publicInventoryCandidates,
});
await writeJson("state/agent-advantage-pairs.json", {
  schemaVersion: 1,
  publicProjection: true,
  pairs: pairs.map((pair) => ({
    runId: pair.runId,
    jobId: pair.jobId,
    benchmarkId: pair.benchmarkId,
    category: pair.category,
    taskSummary: pair.taskSummary,
    identity: pair.agent.identity,
    pair: {
      comparison: pair.comparison,
      withAgent: {
        elapsedMs: pair.withAgent?.elapsedMs ?? null,
        qualityScore: pair.withAgent?.qualityScore ?? null,
        cost: pair.withAgent?.cost ?? null,
        evidence: pair.withAgent?.evidence ?? null,
      },
      withoutAgent: {
        elapsedMs: pair.withoutAgent?.elapsedMs ?? null,
        qualityScore: pair.withoutAgent?.qualityScore ?? null,
        cost: pair.withoutAgent?.cost ?? null,
        evidence: pair.withoutAgent?.evidence ?? null,
      },
    },
    termix: pair.termix,
    verifiedRun: pair.verifiedRun,
    gradedAt: pair.gradedAt,
  })),
});
await writeJson("state/public-termix-evidence.json", {
  schemaVersion: 1,
  publicProjection: true,
  network: "bsc-testnet",
  chainId: 97,
  pairCount: pairs.length,
  requiredForTermix: 3,
  pairs,
  note: "Canned displays derived summary evidence only. Exact human and agent outputs remain in canonical evidence and are not hosted by this deployment.",
});
await writeJson("state/benchmark-runs.json", publicRuns);
await writeJson("state/public-mpp-evidence.json", publicMpp);
await writeJson("state/public-leash-evidence.json", publicLeash);
await writeJson("state/public-track-records.json", publicTrackRecords);

for (const [key, relativePath] of [
  ["health-factor", "state/reference-health-identity.json"],
  ["rebalancing", "state/reference-range-identity.json"],
  ["yield", "state/reference-yield-identity.json"],
  ["grid", "state/reference-grid-identity.json"],
]) {
  await writeJson(relativePath, publicIdentity(await loadJson(canonicalDataDir, relativePath, null)));
}

await writeJson("state/public-deployment-manifest.json", {
  schemaVersion: 1,
  kind: "canned_public_summary_deployment",
  generatedAt: new Date().toISOString(),
  canonicalSource: {
    dataKind: "local canonical evidence",
    sourceHashes: {
      inventory: await sha256File(path.join(canonicalDataDir, "inventory", "verified-candidates.json")),
      runs: await sha256File(path.join(canonicalStateDir, "benchmark-runs.json")),
      pairs: await sha256File(path.join(canonicalStateDir, "agent-advantage-pairs.json")),
    },
  },
  includedDerivedFiles: [
    "inventory/verified-candidates.json",
    "state/agent-advantage-pairs.json",
    "state/benchmark-runs.json",
    "state/public-termix-evidence.json",
    "state/public-mpp-evidence.json",
    "state/public-leash-evidence.json",
    "state/public-track-records.json",
    "state/reference-health-identity.json",
    "state/reference-range-identity.json",
    "state/reference-yield-identity.json",
    "state/reference-grid-identity.json",
  ],
  excludedContentClasses: [
    "exact raw human submissions",
    "exact raw agent outputs",
    "benchmark workspace files",
    "grading source files and evaluator notes",
    "mutable runtime-state files",
    "wallet keys, mnemonics, passwords, .env files, MPP secrets, B402 credentials, RSA private keys, and Altana secrets",
  ],
  termixPresentation: {
    summaryHostedByCanned: true,
    exactOutputsHostedByCanned: false,
    existingPublicArtifactsReferencedOnly: true,
  },
});

console.log(JSON.stringify({
  status: "public_summary_bundle_built",
  output: publicDataDir,
  pairCount: pairs.length,
  runCount: publicRuns.length,
  inventoryCount: publicInventoryCandidates.length,
  includedStateFiles: 11,
}, null, 2));
