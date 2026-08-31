# Canned Grid Keeper and The Leash

The fourth reference agent, and the only one that can move money. This document covers what it actually does, what it deliberately does not claim, and the permission system that bounds it.

## The problem

> I want to trade this pair inside a price range automatically, but I don't want to give an agent unlimited control of my wallet.

Both halves matter. An agent that cannot trade is useless; an agent with an unbounded approval is dangerous. Grid Keeper exists to be the first and The Leash exists to prevent the second.

## What Grid Keeper is NOT

**It does not place native resting limit orders, and it never invents an order id.**

This is the most important sentence in this document, because "grid trading" invites exactly that claim. What was actually verified:

| Mechanism | Status | Evidence |
| --- | --- | --- |
| PancakeSwap limit orders via Gelato | **Deprecated and unmaintained.** PancakeSwap's own interface says so. | Not usable. |
| PancakeSwap Infinity `CLLimitOrder` hook | **Source and tests only.** Present in `pancakeswap/infinity-hooks` as `order/CLLimitOrder.sol`, but there is no deploy script for it and it is absent from PancakeSwap's own `script/config/bsc-testnet.json`. The manifest deploys only the VeCakeExclusive and DynamicFee sample hooks. | Not deployed on chain 97. |
| PancakeSwap SmartRouter V3 | **Deployed on BSC testnet** at `0x9a489505a00ce272eaa5e07dba6491314cae3796` (24,316 bytes of code, verified by `eth_getCode`). | This is what Grid Keeper uses. |

So the execution model is:

**Agent-managed price-triggered execution.** Canned derives the levels and watches the price. When price reaches a level, the agent submits a normal swap. There is no order resting on an exchange and no order id, because no limit-order contract is available on this network.

Deploying the Infinity hook ourselves was considered and rejected: it would be *our* contract, not PancakeSwap's native mechanism, and presenting it as "native limit orders" would be false. The single constant `GRID_EXECUTION_MODEL` in `src/reference/grid-keeper.mjs` is the only place this is described, so no surface can drift into a different claim. A test asserts no deliverable can contain an order id.

This is still genuinely grid trading. Nearly every production grid bot, on centralised and decentralised venues alike, is software-managed price-triggered execution rather than resting native orders.

## Why market data is mainnet and execution is testnet

BSC testnet PancakeSwap has no coherent price. Measured directly:

- The V3 QuoterV2 **reverts at every input size** tested, from 10⁻⁶ to 10⁻² WBNB.
- V2 works, but `WBNB→USDT` implies BNB = **$12.80** while `WBNB→BUSD` implies BNB = **$15,060**. Two USD-stable pairs on the same DEX, three orders of magnitude apart.

A benchmark or a track record built on that would measure nothing. So, following the precedent already set for RebalanceBench and YieldBench:

- **Market data**: read-only from BSC mainnet. GridBench freezes the WBNB/USDT 0.05% pool at block 119,038,523, price 695.27 USDT per WBNB.
- **Execution and payment**: BSC Testnet, chain 97, exclusively.
- **Mainnet writes**: prohibited, and nothing in this module can perform one.

## The grid engine

`src/reference/grid-engine.mjs` is pure. It holds no keys, signs nothing, and reaches no network. Given a strategy, a price and the fills so far, it decides what may happen next.

Money is integer minor units throughout. A capital cap computed in floating point drifts, and drift in a spending cap costs real funds.

### Strategy lifecycle

```
CREATED -> ARMED -> ACTIVE -> { EXPIRED | REVOKED | COMPLETED | FAILED }
```

Forward only. There is no path back to `ACTIVE` from a terminal state, because re-arming a revoked strategy is precisely the escalation the design exists to prevent.

Per level: `ARMED -> LEVEL_TRIGGERED -> EXECUTION_PENDING -> { FILLED | SKIPPED | FAILED }`. Each level has an immutable id (`<strategyId>:L00`) derived deterministically, which is what makes a fill non-repeatable across restarts.

### Every reason it says no

`evaluateLevel` returns a refusal with a reason rather than throwing, because a refusal is a normal outcome the agent must be able to publish:

| Refusal | Prevents |
| --- | --- |
| `strategy_is_not_active` | Acting before arming |
| `strategy_expired` / `authority_revoked` | Acting after the user's permission ended |
| `level_already_filled` | Duplicate fills and level replay |
| `price_has_not_reached_this_level` | Trading off-grid |
| `total_capital_cap_would_be_exceeded` | Overspending the budget |
| `per_level_cap_would_be_exceeded` | Oversized single trades |
| `maximum_fill_count_reached` / `cooldown_has_not_elapsed` | Runaway trading |
| `price_observation_is_too_old` | Acting on stale data |
| `no_price_observation` | Acting with no data at all |
| `pair_does_not_match` / `chain_does_not_match` | Wrong market, wrong network |
| `target_contract_is_not_allowed` / `method_is_not_allowed` | Arbitrary calls |
| `side_does_not_match_the_level` | Wrong direction |
| `quoted_output_is_below_the_minimum` | Bad slippage |
| `not_enough_inventory_to_sell` | Opening a short the user never authorised |

**One action per evaluation.** When price gaps below several buy levels at once, every one of them is genuinely eligible, and the engine still returns a single next action. Firing them all is how a grid bot turns one move into a cascade.

The agent fixes its own allowlist in `planGridStrategy`. A caller supplying `allowedContracts` has nowhere to put it: choosing which contract an agent may call is a question no user can answer safely, and accepting it through the API would be the escalation path.

## The Leash

`src/marketplace/leash.mjs`. Every statement it makes is derived from the permission object actually granted on-chain. With no session it reports `NOT_CONFIGURED` rather than describing what it would say.

States: `NOT_CONFIGURED -> PROPOSED -> ACTIVE -> { EXPIRED | REVOKED }`.

### Mapping to Altana

The SDK's `SessionPermissions` is `{ calls: CallPermission[], spend: SpendPermission[] }` with an `expiry`. A `CallPermission` is `{ to, signature }` with AND semantics; the signature is resolved to a 4-byte selector and enforced by the account contract's validator.

Grid Keeper emits exactly one call permission: the SmartRouter address AND `exactInputSingle(...)`, selector `0x414bf389`. Nothing wider is representable, because the permission is generated from the strategy and the strategy fixes both.

Two places where the honest answer needed care:

1. **Altana's spend cap is per rolling period, not a lifetime total.** A cap of 10/day over a 3-day session permits 30, not 10. `worstCaseSpend` computes the real ceiling and the UI shows *that* number, because it is what a user needs before signing. `smallestCoveringPeriod` picks a period that covers the session so one cap means one total.

2. **An omitted `to` or `signature` means ANY contract or ANY method.** Canned never emits those, and `describeCallPermission` reports an omission as `unrestricted: true` rather than as absent. A signature that cannot be resolved to a selector also counts as unrestricted, because it cannot be *proved* narrow — it fails closed instead of throwing.

### What the user sees

**CAN**: trade the pair inside the range; call only the listed contract and method; spend at most the stated cap, from their wallet only.

**CANNOT**: withdraw assets anywhere; send funds to an unapproved address; call any other contract; raise its own cap; extend its own expiry; act at all after revocation.

`REVOKE ACCESS` is always present while a session is live. Revocation is a single on-chain transaction (`revokeSession`); after it confirms, the session's next execute fails at validator level.

The strategy and the proposal are both content-addressed, so what was approved can be compared with what was granted. An approval nobody can check afterwards is not much of an approval.

## No private-key custody

Canned never requests a private key, seed phrase, mnemonic, or wallet password — for ownership claims or for grid execution. The agent acts only through a session key the user granted and can revoke. Owner wallet keys are never placed on the VPS.

## GridBench v1

A deterministic capability benchmark, not a fourth TermiX pair (TermiX is already 3/3). Its job is to give Grid Trading the same evidence depth as the other three categories: a frozen task, a precommitted policy, and a gradable answer.

16 scenarios covering grid construction, trigger detection, duplicate fills, capital caps, expiry, revocation, stale prices, wrong chain, wrong contract, wrong method, slippage, cooldown, inventory rules, and ledger accounting.

**Ground truth is recomputed in the evaluator from the specification, not by running the engine under test.** An evaluator that asked the implementation what the right answer was would agree with it by construction, including where both are wrong. The two are independent implementations, and they currently agree on all 14 decision scenarios — which is evidence, not a tautology.

Scoring: equal share of 100 per scenario. A decision scores only when the verdict **and** the reason both match. Refusing for the wrong reason means the guard did not work; the policy said so before any answer existed. A blanket "refuse everything, blame expiry" submission scores under 20.

Writing the scenarios surfaced two of my own errors before anything was frozen: a price of 601 never triggers a 600 buy level, and at the strategy's own 400 cap four buy levels of 100 consume it exactly and never exceed it, so the cap could not bind. Both were corrected in the definition rather than papered over in the evaluator.

## Track record

`grid-keeper-track-record-v1`. Two rules:

1. **A simulated fill is never counted as a real one.** Fills carry an `execution` field; anything that is not `onchain` is excluded from every realised figure and reported separately as `simulatedFills`.
2. **No rate before there is a sample.** `realisedReturnBps` is `null` until at least 3 sessions with on-chain fills. `maxDrawdownBps` is `null` and says why: measuring it honestly needs a priced time series per session, which Canned does not record yet.

Current state: zero sessions, zero on-chain fills. The published summary is *"This agent has not executed a grid trade on chain. There is no track record to report."*

## Current state (Directive #18)

| Item | State |
| --- | --- |
| ERC-8004 identity | **Registered: agent 2045** on chain 97, registry `0x8004A818…`, tx `0x4aab807f…`, block 128,277,949 |
| Public service | **Live** at `https://grid-keeper.103-195-188-198.sslip.io/erc8183`, valid TLS, port 8793 |
| Provider wallet | `0xA928DEBa…`, funded with 0.003 tBNB, 0.00171 tBNB remaining after registration |
| Signed quote | Verified, 0.001 U, signer matches provider |
| Worker / watcher | Alive, watching chain 97 |
| GridBench v1 | **Graded 16/16, score 100**, precommit `sha256:e750115579b1f791…` unchanged |
| Trust state | **LIVE + QUOTE VERIFIED** — not BENCHMARKED |
| Hireable | Yes, ERC-8183 ready |
| Altana session | **None granted.** The Leash reads `NOT_CONFIGURED` |
| Grid execution | **None.** No value-bearing transaction has occurred |
| Track record | Zero on-chain fills; no rate published |

### Why Grid Keeper is not BENCHMARKED

Canned's `qualifiesForAgentTrackRecord` requires `hasRealPayment` — a funded ERC-8183 job. GridBench is a deterministic capability benchmark with no payment, so passing it 16/16 does not reach BENCHMARKED, and the rule was not relaxed to fill the fourth category. Reaching it needs one paid job at the quoted 0.001 U, which is a separate authorisation.

### The hire gate and the human baseline

Hire readiness previously required a sealed human baseline for every reference agent. That check is a *contamination guard*: hiring before the human answers the same frozen task would leak the agent's output into the baseline. GridBench has no human baseline by design, because TermiX is already satisfied by the other three pairs, so the requirement would have blocked hiring forever to protect a baseline that will never exist. The gate now applies only to benchmarks that actually have one (`requiresHumanBaseline`), and the three TermiX agents still require theirs. This changes nothing about BENCHMARKED.

### The session that was specified but not granted

The action wallet role did not exist and was created: `0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f`. It holds **0 tBNB and 0 USDT**, and BSC testnet USDT has an owner-gated `mint` that reverts, so it cannot be self-sourced. The first bounded session therefore stopped at the funding boundary.

The permission boundary was verified statically instead, with no funds spent: 10 of 10 cases behave correctly, including wrong contract, wrong method, wrong token, wrong chain, expired, revoked, aggregate cap, and slippage. Evidence is in `data/state/leash-boundary-verification.json`.
