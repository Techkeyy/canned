# PancakeSwap integration plan

Status: architecture review only. No PancakeSwap write is being made in Directive #6.

## Recommended first track

Rebalancing is the strongest first PancakeSwap partner track because the benefit can be measured against a fixed LP range. The first implementation should read pool state, ticks, position bounds, fee growth, and the declared observation window, then return a range recommendation with price impact and gas estimates. The fixed-range control uses the same starting position and window.

## Adapter boundary

The adapter must keep observation, recommendation, and execution separate. A future execution path should use the official PancakeSwap V3 or Infinity position manager flow, Permit2 where required, exact contract allowlists, slippage limits, deadline, and an Altana-scoped authority grant. It must never ask the user for an unlimited token approval.

PancakeSwap Infinity's Vault, Pool Manager, hooks, and concentrated-liquidity layers are not interchangeable with V3 positions. The selected pool version, address, tick spacing, position manager, and action payload must be recorded in the precommit and evidence manifest.

## Category reuse

- Rebalancing: range maintenance and fee-versus-cost comparison.
- Yield: compare executable LP or lending routes only after venue risk and costs are explicit.
- Grid Trading: safe swaps may be a later bounded action, not a logo-level integration.
- Health Factor: PancakeSwap is not the lending authority; keep Venus or another declared lending venue separate.

The product should claim PancakeSwap integration only when a real measurable trader or LP benefit and transaction provenance are present.
