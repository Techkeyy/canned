# Canned public TermiX evidence

These are the three qualifying Agent Advantage comparisons used by Canned.
The task, agent output, and control output files are faithful publications of
the corresponding canonical grading-record fields. They are not rewritten
summaries. `metrics.json` and `provenance.json` make the source record,
published-file hashes, evaluator, identity, timing, cost, score, and protocol
references easy to verify.

## Task 1 — Trading ROI: Range Keeper

Trading Agent-vs-Control / ROI proof.

- [Canonical task](01-range-keeper/task.txt)
- [Raw agent output](01-range-keeper/agent-output.json)
- [Raw control output](01-range-keeper/control-output.json)
- [Metrics](01-range-keeper/metrics.json)
- [Provenance](01-range-keeper/provenance.json)

## Task 2 — The Flow: Health Guard

Agent-vs-Control plus paid flow proof. The MPP record is official generic BNB
MPP on BSC Testnet and is explicitly not Binance B402 or x402.

- [Canonical task](02-health-guard/task.txt)
- [Raw agent output](02-health-guard/agent-output.json)
- [Raw control output](02-health-guard/control-output.json)
- [Metrics](02-health-guard/metrics.json)
- [Provenance](02-health-guard/provenance.json)
- [MPP on-chain and replay proof](02-health-guard/mpp-proof.json)

## Task 3 — ROI: Yield Scout

High-ROI optimization comparison.

- [Canonical task](03-yield-scout/task.txt)
- [Raw agent output](03-yield-scout/agent-output.json)
- [Raw control output](03-yield-scout/control-output.json)
- [Metrics](03-yield-scout/metrics.json)
- [Provenance](03-yield-scout/provenance.json)

## Separate sovereign execution proof

Grid Keeper is intentionally outside the three-pair Agent Advantage count. Its
separate public Leash evidence shows a bounded session, allowlisted
PancakeSwap V2 execution, spend limits, expiry, real execution, revocation,
and rejected retry. It does not claim a native limit order, profitability, or
live market making.

The tree contains publication-safe evidence only. No credential material is
included here.
