import { FileStore } from "../src/persistence/file-store.mjs";
import { Eight004ScanAdapter, summarizeCandidate } from "../src/discovery/8004scan.mjs";
import { buildCandidateMatrix, buildProviderHistory, buildReadinessChecklist, rankCandidateMatrix, summarizeProviderHistory } from "../src/discovery/readiness.mjs";
import { negotiateA2A } from "../src/protocol/a2a.mjs";
import { loadSdk } from "../src/protocol/erc8183-buyer.mjs";

const store = await new FileStore().init();
const adapter = new Eight004ScanAdapter();
const report = await adapter.discover({ evidenceStore: store, perQuery: 5, maxDeep: 32 });
const runs = await store.loadRuns();
const providerHistory = buildProviderHistory(runs);
const sdk = await loadSdk();
let readWallet = null;
let readClient = null;
try {
  if (process.env.CANNED_EXECUTION_WALLET_PASSWORD && process.env.CANNED_EXECUTION_WALLET_ADDRESS) {
    readWallet = new sdk.EVMWalletProvider({ password: process.env.CANNED_EXECUTION_WALLET_PASSWORD, address: process.env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: process.env.CANNED_WALLETS_DIR, persist: true });
    readClient = await sdk.ERC8183Client.create({ network: "bsc-testnet", walletProvider: readWallet });
  }
} catch {
  readClient = null;
  readWallet?.destroy();
  readWallet = null;
}

const observations = {};
for (const candidate of report.candidates) {
  const a2a = candidate.probes.find((probe) => probe.callable && /a2a/i.test(probe.type));
  let quoteProbe = null;
  let quoteVerification = null;
  if (a2a) {
    quoteProbe = await negotiateA2A({ endpoint: a2a.endpoint, card: a2a.card, taskDescription: `Canned readiness quote probe for ${candidate.name}. Return a signed quote only; do not execute an onchain action.`, deliverables: "signed quote only", qualityStandards: "no execution" });
    const quoteData = quoteProbe.rawResponse?.result?.parts?.find((part) => part.kind === "data")?.data || null;
    if (quoteData && readClient && candidate.agentWallet) {
      try {
        const sdkErc8183 = await import("@bnbagent/sdk/erc8183");
        quoteVerification = await sdkErc8183.verifyQuoteSignature({ envelope: quoteData, provider: candidate.agentWallet, publicClient: readClient.publicClient, expectedVerifyingContract: readClient.commerce.address });
      } catch (error) {
        quoteVerification = { valid: false, reason: error?.message || String(error) };
      }
    } else {
      quoteVerification = { valid: false, reason: "official SDK read client or quote data unavailable" };
    }
  }
  const category = candidate.categoryHypotheses?.[0]?.category || null;
  const readiness = buildReadinessChecklist({ candidate, probe: a2a, quoteProbe, quoteVerification, chainId: 97, expectedCategory: category });
  observations[candidate.identity] = { probe: a2a || null, quoteProbe, quoteVerification, readiness };
  candidate.hiring.negotiationProbe = quoteProbe ? { ok: quoteProbe.ok, accepted: quoteProbe.accepted === true, endpoint: quoteProbe.endpoint, elapsedMs: quoteProbe.elapsedMs, negotiationHash: quoteProbe.negotiationHash, quote: readiness.quote.price ? { price: readiness.quote.price, currency: readiness.quote.currency, estimatedCompletionSeconds: readiness.quote.estimatedCompletionSeconds } : null, error: quoteProbe.error || null } : null;
  candidate.hiring.price = readiness.quote.price;
  candidate.hiring.currency = readiness.quote.currency;
  candidate.selectionGate.readiness = readiness;
  candidate.selectionGate.allGatesPassed = readiness.ready;
}
readWallet?.destroy();

const matrix = rankCandidateMatrix(buildCandidateMatrix({ candidates: report.candidates, observations, providerHistory, runs }));
const selected = matrix.find((candidate) => candidate.eligible) || null;
report.providerHistory = summarizeProviderHistory(providerHistory);
report.candidateMatrix = matrix;
report.selectedCandidateHypothesis = selected ? report.candidates.find((candidate) => candidate.identity === selected.identity) : null;
if (report.selectedCandidateHypothesis) report.selectedCandidateHypothesis.selectionGate.selectionStatus = "candidate_for_benchmark_pending_funded_run";
report.summaries = report.candidates.map(summarizeCandidate);
const saved = await store.saveInventory(report);
await store.saveJson("state/candidate-matrix.json", { schemaVersion: 1, kind: "canned_candidate_matrix", observedAt: report.observedAt, network: report.network, providerHistory: report.providerHistory, systemicGuard: matrix[0]?.systemicGuard || null, candidates: matrix, selected: selected ? { identity: selected.identity, rank: selected.rank } : null });
console.log(JSON.stringify({ artifact: saved.relativePath, observedAt: report.observedAt, searchedCount: report.searchedCount, deeplyExaminedCount: report.deeplyExaminedCount, reachableServiceCount: report.reachableServiceCount, callableCandidateCount: report.callableCandidateCount, categorySummary: report.categorySummary, selectedCandidate: selected ? { identity: selected.identity, name: selected.name, category: selected.category, rank: selected.rank, readinessScore: selected.readinessScore } : null, candidateMatrix: matrix.map((candidate) => ({ identity: candidate.identity, name: candidate.name, category: candidate.category, rank: candidate.rank, eligible: candidate.eligible, readinessScore: candidate.readinessScore, liveness: candidate.liveness.status, cooldownActive: candidate.cooldown.active })) }, null, 2));
