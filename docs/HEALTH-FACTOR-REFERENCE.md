# Canned Health Guard

## User problem

“Watch this lending position. Tell me how close I am to liquidation, what changed, and what bounded action would restore my safety margin.”

## Actual data contract

The module requires:

- a BSC testnet account;
- protocol `Venus`;
- an authoritative onchain snapshot;
- pool type and block reference;
- raw protocol liquidity/shortfall fields for Core Pool, or a pool-specific authoritative read plan for Isolated Pools.

Absent or non-authoritative data returns `INSUFFICIENT_AUTHORITATIVE_DATA` and no assessment. A number from a fixture, an LLM, or an unverified API is not relabeled as a health factor.

For Core Pool, the read seam uses `Comptroller.getAccountLiquidity(address)`. Venus’s liquidation model uses collateral factor and liquidation threshold semantics; the implementation therefore preserves raw fields and only classifies a shortfall or a supplied authoritative health factor. It does not invent a universal formula for all Venus pool types.

## Output

Every successful deliverable includes the account, pool, block, source, assessment, deterministic changes from the prior snapshot, recommendation-only action, and snapshot hash. `automaticActionTaken` is always `false` in this release.

## Control and TermiX

The repository contains an independent deterministic protocol-read control for engineering evaluation. It is not a human baseline and is never marked as TermiX evidence. `manualHealthFactorBaselinePacket()` produces a packet with an explicit contamination boundary and no expected answer. The human procedure must be completed and returned before comparing it with an agent result.

## Current release status

The HTTP endpoint, runtime, task module, deterministic tests, and SDK seller seam are implemented. A real paid run remains pending provider-wallet funding, ERC-8004 registration, a fresh provider-signed quote, and operator confirmation. No live answer is claimed by this repository change.
