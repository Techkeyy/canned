import { FileStore } from "../src/persistence/file-store.mjs";
import { Eight004ScanAdapter, summarizeCandidate } from "../src/discovery/8004scan.mjs";
import { negotiateA2A } from "../src/protocol/a2a.mjs";

const store = await new FileStore().init();
const adapter = new Eight004ScanAdapter();
const report = await adapter.discover({ evidenceStore: store, perQuery: 3, maxDeep: 12 });
for (const candidate of report.candidates) {
  const a2a = candidate.probes.find((probe) => probe.callable && /a2a/i.test(probe.type));
  if (!a2a) continue;
  const probe = await negotiateA2A({
    endpoint: a2a.endpoint,
    card: a2a.card,
    taskDescription: `Canned selection-gate quote probe for ${candidate.name}. Return a quote only and do not execute an onchain action.`,
    deliverables: "signed quote only",
    qualityStandards: "no execution",
  });
  const quotedTerms = probe.quote?.terms || probe.quote || null;
  candidate.hiring.negotiationProbe = {
    ok: probe.ok,
    accepted: probe.accepted === true,
    endpoint: probe.endpoint,
    elapsedMs: probe.elapsedMs,
    negotiationHash: probe.negotiationHash,
    quote: quotedTerms ? { price: quotedTerms.price || null, currency: quotedTerms.currency || null, estimatedCompletionSeconds: probe.quote?.estimated_completion_seconds || null } : null,
    error: probe.error || null,
  };
  if (probe.ok && quotedTerms?.price) {
    candidate.hiring.price = quotedTerms.price;
    candidate.hiring.currency = quotedTerms.currency || null;
    candidate.selectionGate.genuinelyCallable = true;
  }
}
const eligibleCandidates = report.candidates
  .filter((candidate) => candidate.selectionGate.genuinelyCallable && candidate.hiring.negotiationProbe?.accepted === true && candidate.hiring.price && candidate.categoryHypotheses.length)
  .sort((left, right) => {
    const leftScore = Math.max(...left.categoryHypotheses.map((item) => item.score));
    const rightScore = Math.max(...right.categoryHypotheses.map((item) => item.score));
    return rightScore - leftScore || left.identity.localeCompare(right.identity);
  });
report.selectedCandidateHypothesis = eligibleCandidates[0] || null;
if (report.selectedCandidateHypothesis) report.selectedCandidateHypothesis.selectionGate.selectionStatus = "candidate_for_benchmark_pending_funded_run";
report.summaries = report.candidates.map(summarizeCandidate);
const saved = await store.saveInventory(report);
console.log(JSON.stringify({
  artifact: saved.relativePath,
  observedAt: report.observedAt,
  searchedCount: report.searchedCount,
  deeplyExaminedCount: report.deeplyExaminedCount,
  reachableServiceCount: report.reachableServiceCount,
  callableCandidateCount: report.callableCandidateCount,
  categorySummary: report.categorySummary,
  selectedCandidateHypothesis: report.selectedCandidateHypothesis ? { identity: report.selectedCandidateHypothesis.identity, name: report.selectedCandidateHypothesis.name, categories: report.selectedCandidateHypothesis.categoryHypotheses.map((item) => item.category), price: report.selectedCandidateHypothesis.hiring.price, currency: report.selectedCandidateHypothesis.hiring.currency } : null,
}, null, 2));
