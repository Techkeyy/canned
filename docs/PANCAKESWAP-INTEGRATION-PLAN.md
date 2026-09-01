# PancakeSwap integration plan

Status: the Canned PancakeSwap surfaces are implemented on BSC Testnet. Range Keeper is recommendation-only and benchmarked; Grid Keeper has a separately scoped, revoked Altana session proof for one bounded V2 trade. No new PancakeSwap write is authorized in this remediation sprint.

Scope: this document covers the read-only Range Keeper/Rebalancing plan. It does not describe Grid Keeper's live execution route; that route is PancakeSwap V2 as selected in [ADR-060](DECISIONS.md#adr-060-a-route-must-be-proven-executable-before-it-can-be-permitted).

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

## Implemented: Canned Range Keeper

Status as of 2026-09-01: implemented, publicly deployed, hired through the existing ERC-8183 path, and bound to a frozen benchmark. Its track record and limitations are rendered from the stored evidence.

### What it does for a liquidity provider

It answers the question an LP actually has: *my liquidity is sitting in this range — is it still healthy, is price drifting toward an edge, and should I leave it alone or rebalance?* It reads the pool and the position directly and returns whether the position is in range, which bound is nearer and by how much, how the market moved around it, whether a rebalance is justified, a bounded replacement range only when one is justified, and the trade-offs being accepted.

Holding is a first-class answer. The policy recommends a rebalance only when the position has left its range, or when it sits inside the act threshold of an edge *and* observed drift is carrying it further that way. Constant rebalancing is not treated as better: it costs gas, realises impermanent loss at the current price, and restarts fee accrual.

### Contracts and reads

Official PancakeSwap V3 deployment, from the PancakeSwap trading-agents guide:

| Contract | Address |
| --- | --- |
| PancakeV3Factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` |
| NonfungiblePositionManager | `0x46A15B0b27311cedF172AB29E4f4766fbE7F4364` |
| SmartRouter | `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4` |
| QuoterV2 | `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` |

Reads used, all at one frozen block: `slot0()`, `liquidity()`, `token0()`, `token1()`, `fee()`, `tickSpacing()`, `feeGrowthGlobal0X128()`, `feeGrowthGlobal1X128()`, `observe(uint32[])`, and `positions(uint256)`. Token symbols and decimals come from the token contracts. Nothing is scraped and nothing is estimated; a window the pool oracle cannot serve is recorded as unavailable rather than filled in.

### Why the market data is mainnet

PancakeSwap V3 *is* deployed on BSC testnet at the same deterministic addresses, so option A was live. It was rejected on evidence:

- WBNB/USDT testnet pools report mutually inconsistent ticks across fee tiers (-19713, -23920, -24615, -25846), which no arbitraged market would show;
- WBNB/BUSD reports tick 94800 against WBNB/USDT's -19713 for what should be a near-identical price;
- every testnet pool observed had `observationCardinality` of 1, so there is no price history at all and no drift can be computed.

A benchmark built on that would measure nothing. Mainnet state is therefore read **read-only** at a frozen block, and every Canned payment, quote, job, and agent execution stays on BSC testnet. `mainnetWriteAuthorized` is `false` in the frozen definition and no mainnet write path exists in the code.

### Execution boundary

Range Keeper v1 is recommendation-only. It never removes liquidity, mints liquidity, swaps, or approves spending. When a rebalance is justified it emits a `PLANNED_NOT_AUTHORIZED` action plan shaped for a future Altana session: contract allowlist limited to the position manager, methods limited to `decreaseLiquidity`, `collect`, and `mint`, a slippage cap, a short expiry, revocability, and required operator confirmation. Unlimited approvals and arbitrary calldata are explicitly forbidden. No Altana session exists for this plan; it is a declared boundary, not an authorization.

## Benchmarked: Verified Run #2

On 2026-08-28 Canned hired Range Keeper through its own marketplace for a real 0.001 U ERC-8183 job (job 700) against RebalanceBench v1, and graded it against a human baseline sealed beforehand.

Range Keeper read the frozen PancakeSwap V3 state, reported the position as in range with the lower tick bound nearer, described the hour's drift as small and moving away from that bound, and recommended **HOLD** with no replacement range. That is the correct answer under the precommitted policy: 70 ticks of clearance in a 200-tick range, with drift at 7.5% of the range width heading the other way.

It scored 100/100 in 69.9 seconds for 0.001 U plus 0.000060257 tBNB of buyer gas. The unaided human scored 30/100 in 152.5 seconds and would have rebalanced — paying gas and realising impermanent loss for no benefit.

This is the PancakeSwap partner-track evidence: a real LP decision, on real pool and position state, where hiring the agent produced the better answer faster, and where the better answer was to do nothing. Range Keeper moved no capital and holds no approval.

The track record now holds one decision with a **pending** outcome. It will not publish a retention rate until five decisions have been settled against later, independently sampled market state.
