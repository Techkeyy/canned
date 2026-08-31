# Hackathon requirements matrix

Research date: 2026-08-27. Status labels are Confirmed, Inferred, or Unknown. The current official sources are the [BNB Chain hackathon page](https://www.bnbchain.org/en/hackathons/smart-money-era?tab=tracks), the [official Build the Era announcement](https://www.bnbchain.org/en/blog/build-the-era-build-the-official-bnb-agent-studio-marketplace), and the [BNB Agent Studio documentation](https://docs.bnbchain.org/developer-kit/bnbchain-studio/quickstart/).

| Area | Requirement or fact | Status | Canned response |
| --- | --- | --- | --- |
| Main event | Build the Era online hackathon runs 2026-08-05 through 2026-09-09 UTC+0 | Confirmed | Freeze a public, functional testnet demo before the deadline. |
| Eligibility | Individuals and teams may enter; one entry per team; globally open | Confirmed | Keep the repository and demo attributable to one entry. |
| Product | Build an AI agent marketplace, not merely a portfolio of agents | Confirmed | Discovery, hiring, evidence, and comparison are the product loop. |
| Live agents | Agents surfaced during judging must be live on BSC | Confirmed | Do not list a fixture as a live agent; label offline examples. |
| Categories | Rebalancing, Grid Trading, Yield Optimisation, Health Factor Monitoring | Confirmed | Treat all four as first-class schema values and navigation paths. |
| Category depth | A single category scores poorly; all four should be equally deep | Confirmed | Build shared task and evidence primitives so categories can reach parity. |
| Main judging | Functionality, Data Quality, Agent Diversity | Confirmed | Acceptance tests and evidence quality are release gates. |
| Extra judging detail | The page says more criteria may be added in a later phase | Unknown | Track it as a research item; do not claim an undiscovered rubric. |
| Main prize | $30,000 USDT equivalent plus a chance at official BNB Agent Studio marketplace adoption | Confirmed | Optimize for a functional marketplace and adoption-quality operations. |
| TermiX track | TermiX judges value of services 30%, proven agent advantage 30%, high-stakes categories/track record 20%, marketplace quality 20% | Confirmed | Build the Agent Advantage Report into run storage, not as a last-minute document. |
| TermiX evidence | At least three real tasks run both with a marketplace agent and without one; include time, cost, output quality, and actual outputs; include one trading, stock, or security task | Confirmed | Preserve control outputs and raw artifacts for at least three paired runs. |
| Altana track | Use own Altana wallets, real session permissions, spend caps, call allowlists, expiries, revocation, Keystore registration, and an onchain session-key transaction; testnet is acceptable | Confirmed | Implement an Altana authority adapter with visible scope and revoke controls. |
| Altana bonus | Hiring BNB Agent Studio agents through ERC-8183 using Altana SDK and selling through x402/B402 can earn bonus consideration | Confirmed | Keep ERC-8183 and x402 adapters separate and optional. |
| PancakeSwap track | Benefit must be real for traders or LPs; examples include liquidity management, yield, demand research, and safe swaps without exposing funds | Confirmed | First recommended slice targets PancakeSwap V3 range rebalancing, with guardrails. |
| BNB Agent Studio | Studio supplies identity, wallet, payments, cloud/runtime integration, ERC-8004, ERC-8183, and x402 support | Confirmed | Use Studio for provider agents where it is the right runtime; do not rebuild its signer boundary. |
| ERC-8004 | Draft standard for identity, discovery, reputation, and validation registries | Confirmed | Use identity metadata and feedback as evidence inputs, never as a safety certificate. |
| ERC-8183 | Draft standard for ERC-20 job escrow with Open, Funded, Submitted, Completed, Rejected, and Expired states | Confirmed | Use it for jobs whose deliverable and payment semantics fit this state machine. |
| 8004scan | Official API supports agent listing, semantic search, agent lookup, feedback, stats, and owner filters; API keys are backend-only | Confirmed | Add a server-side indexing adapter after the local schema is stable. |
| Reference agents | Official Studio and SDK docs provide example sellers/clients; PancakeSwap has documented an Order/Intents Settlement Agent and V3 range rebalancing patterns | Confirmed | Verify an actual live endpoint before listing it. Exact two-per-category inventory is not confirmed. |
| Individual reference inventory | The official hackathon page does not enumerate a complete, current agent list per category | Unknown | Keep a discovery checklist and avoid claiming category coverage until endpoints are verified. |
| Submission details | Intake form exists, but the full current field list and any video requirements were not verified in this pass | Unknown | Recheck the form before submission; do not hardcode a submission checklist yet. |
| Testnet | BSC testnet chain ID is 97; mainnet is 56 | Confirmed | Develop and demo on testnet first. |

## Architecture implications

1. Category identity is a product requirement, not a tag added after the fact.
2. Data quality needs a provenance model and visible negative outcomes.
3. Agent diversity needs adapter boundaries and live endpoint health checks.
4. TermiX requires a paired control design and raw output retention.
5. Altana requires authority scope to be user-visible and revocable.
6. PancakeSwap integration must show trader/LP benefit and protect user funds.

## Open verification queue

- Confirm the exact current reference-agent endpoints and licenses.
- Confirm whether each target agent supports A2A, MCP, HTTP, ERC-8183, x402, or a combination.
- Confirm the current hackathon intake form fields and final judging rubric.
- Confirm testnet token, pool, and lending-protocol liquidity sufficient for a meaningful first benchmark.
- Confirm 8004scan API credentials and rate limits for the intended demo volume.

## Requirements re-verified 2026-08-27

Checked against the current BNB Chain hackathon material and the PancakeSwap partner announcement rather than earlier notes.

| Track | Requirement as currently stated | Canned status |
| --- | --- | --- |
| Build the Era main track | Build the official BNB Agent Studio marketplace; all four categories need first-class depth | Two of four categories have a real first-party agent. Health Factor Monitoring is benchmarked; Rebalancing is live and frozen but not yet benchmarked. Yield Optimisation and Grid Trading remain planned only. |
| TermiX | At least three real tasks run both with a marketplace agent and without one, reporting time, cost, and output quality with the actual outputs attached; at least one task in trading, stock, or security; trading track record weighted highly | One qualifying pair exists (HealthBench v1). RebalanceBench v1 is frozen and is a trading-category task, but no human baseline and no paid agent run exist yet, so it is not a candidate pair. |
| PancakeSwap | 1,000 CAKE partner track. The agent must deliver a real benefit to PancakeSwap traders or liquidity providers — smarter liquidity management, better yields, pool-demand research, or safe automated swaps that never put user funds at risk. Partner tracks are judged on their own criteria. | Range Keeper is smarter liquidity management for LPs, reading real PancakeSwap V3 pool and position state and recommending hold or a bounded range. It is recommendation-only and cannot move user funds. |

Timeline as published: submissions 5 August to 9 September, judging 9 to 23 September, winners announced 5 November.

Nothing in the current material contradicts the earlier requirements matrix. The one change worth recording is that partner tracks publish their own scoring, so the PancakeSwap track page should be re-read before submission rather than assuming the main-track rubric applies.

## Status re-stated 2026-08-30

The 2026-08-27 table above is kept as written, because a requirements matrix that gets edited in place stops being a record. This section states where the project actually stands after Verified Runs #2 and #3 and the productization work.

| Track | Requirement | Canned status |
| --- | --- | --- |
| Build the Era main track | Build the official BNB Agent Studio marketplace; all four categories need first-class depth | Three of four categories have a benchmarked first-party agent: Health Factor Monitoring (Health Guard), Rebalancing (Range Keeper), Yield Optimisation (Yield Scout). **Grid Trading has discovered third-party agents listed and none benchmarked**, and the marketplace shows it that way rather than filling the gap. |
| TermiX | At least three real tasks run both with a marketplace agent and without one, reporting time, cost, and output quality with the actual outputs attached; at least one task in trading, stock, or security | **Met on the published minimum.** Three qualifying with-agent versus without-agent pairs exist, each with a sealed human baseline, a paid onchain job, a content-addressed deliverable, and a deterministic grading. RebalanceBench v1 is the trading-category task. Meeting a published minimum is not the same as winning a track. |
| PancakeSwap | 1,000 CAKE partner track; real benefit to traders or liquidity providers, never putting user funds at risk | Range Keeper reads real PancakeSwap V3 pool and position state and recommends hold or a bounded range. It is recommendation-only and cannot move user funds. Verified Run #2 is the graded evidence. |

### Marketplace requirements

| Requirement | Status |
| --- | --- |
| A visitor who has not heard of ERC-8004 can understand the product | `/` explains the argument before the shelf, introducing each protocol by what it means for the reader. |
| Agents are discovered dynamically, not hardcoded | The shelf is built from the ERC-8004 registry read. 35 agents currently: 3 first-party, 32 discovered third-party. |
| A developer can list an agent | `/list` resolves the identity, proves wallet ownership by signature, and accepts presentation metadata. |
| A developer can claim an already-discovered agent | Same flow. A discovered agent is `UNCLAIMED` until its owner proves control. |
| Ownership is verified, not asserted | The recovered signer must equal both the challenged address and the owner the registry reports. |
| No fabricated marketplace metrics | Every figure is derived; a test fails the build if one is typed into a page. |

### Open items

- Grid Trading has no first-party agent and no benchmark. It is listed as incomplete rather than presented as covered.
- Whether BSC Testnet identities satisfy the final eligibility wording is not settled by the published material. Every testnet agent carries `FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED` (ADR-045).
- Partner tracks publish their own scoring, so the PancakeSwap track page should be re-read before submission rather than assuming the main-track rubric applies.

## Status re-stated 2026-08-31 (Directive #17)

| Track | Requirement | Canned status |
| --- | --- | --- |
| Build the Era main track | All four categories first-class | **All four now have a first-party agent.** Three are benchmarked against a sealed human baseline. Grid Keeper is built and has a frozen deterministic benchmark, but is not registered and has not executed, so it is shown as listed and untested. |
| TermiX | Three with/without pairs, one in trading | Met on the published minimum, unchanged. GridBench is deliberately **not** a fourth pair. |
| PancakeSwap | Real benefit to traders or LPs, funds never at risk | Range Keeper (graded, Verified Run #2) plus Grid Keeper, which trades only inside a revocable, contract-and-method-scoped permission. |
| Altana | Bounded session-key execution | Architecture complete against SDK 0.7.1 on the real BSC testnet stack. **The bounty is not satisfied**: no session-key transaction has been executed. The exact proposed first transaction is specified and awaiting authorisation. |

### Grid Trading, stated precisely

The category expects placing and managing automated grid orders. Canned manages grid levels and executes them as real swaps, because no PancakeSwap limit-order contract is available on BSC testnet (see ADR-048). This is disclosed on every surface rather than described as native orders.

### Open items

- Grid Keeper ERC-8004 registration is blocked at the funding boundary.
- No Altana session key has been granted, so the Altana track is not yet satisfiable.
- BSC Testnet versus Mainnet eligibility for the main track remains unresolved by the published material; `FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED` still applies (ADR-045). Altana's own testnet stack does not resolve it, and was not treated as if it did.

## Status re-stated 2026-08-31 (Directive #18)

> **HISTORICAL STATE — SUPERSEDED by the Directive #21 status below.** The failed and not-yet-authorised state is preserved as recorded evidence.

| Track | Status |
| --- | --- |
| Build the Era main track | **Three of four categories are first-class.** Health Factor Monitoring, Rebalancing and Yield Optimisation each have a benchmarked first-party agent with a paid graded run. Grid Trading has a registered, deployed, hireable first-party agent (ERC-8004 **2045**) that scored 16/16 on a frozen deterministic benchmark, but has no paid job, so it is **not** BENCHMARKED and the category is not first-class. |
| TermiX | Met, unchanged. 3/3 pairs, `jobsPaidForAndGraded = 3`, 2 wins, 1 loss. GridBench is not a fourth pair. |
| PancakeSwap | Range Keeper (graded, Verified Run #2) plus Grid Keeper, now registered and hireable, trading only inside a revocable contract-and-method-scoped permission. |
| Altana | **NOT satisfied.** Architecture is complete against SDK 0.7.1 on the real chain-97 stack and the exact bounded session is specified, but **no session was granted and no session-key transaction was executed**, because the action wallet has no testnet USDT. `ALTANA_REAL_SESSION_EVIDENCE = false`. |

### Four-category status, derived from evidence

| Category | First-class? | Why |
| --- | --- | --- |
| Health Factor Monitoring | **Yes** | Verified Run #1, paid, graded, BENCHMARKED |
| Rebalancing | **Yes** | Verified Run #2, paid, graded, BENCHMARKED |
| Yield Optimisation | **Yes** | Verified Run #3, paid, graded, BENCHMARKED |
| Grid Trading | **No** | Registered, deployed, hireable, GridBench 16/16, but no paid job, so LIVE + QUOTE VERIFIED |

Counting agents rather than evidence would report four. Canned reports three.

### Open items

- One paid ERC-8183 Grid Keeper job (0.001 U) would make Grid Trading first-class. Not authorised.
- Testnet USDT for the action wallet is required before any Altana session. Not available and not self-mintable.
- BSC Testnet versus Mainnet eligibility for the main track is still unresolved by published material; `FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED` stands (ADR-045). Altana's own testnet stack was not treated as resolving it.

## Status re-stated 2026-08-31 (Directive #19)

> **HISTORICAL STATE — SUPERSEDED by the Directive #21 status below.** The failed paid job and unavailable-session state are preserved as recorded evidence.

| Track | Status |
| --- | --- |
| Build the Era main track | **Three of four categories first-class**, unchanged. Grid Keeper took a real paid ERC-8183 job (835, settled COMPLETED, 0.001 U) but submitted an empty deliverable, so it does not qualify. It sits at HIRE ATTEMPTED - DELIVERY NOT OBSERVED. |
| TermiX | Met and untouched: 3 of 3 pairs, 3 paid and graded, 2 wins, 1 loss. GridBench added no pair, by design. |
| PancakeSwap | Unchanged. Range Keeper graded; Grid Keeper registered, hireable and now genuinely hired, though the delivery failed. |
| Altana | **NOT satisfied.** `ALTANA_REAL_SESSION_EVIDENCE = false`. No session, no session-key transaction, no revocation. The action wallet now holds 0.01 tBNB gas and 0 USDT. |

### Four-category status, derived

| Category | First-class? | Evidence |
| --- | --- | --- |
| Health Factor Monitoring | Yes | Verified Run #1, paid, graded, BENCHMARKED |
| Rebalancing | Yes | Verified Run #2, paid, graded, BENCHMARKED |
| Yield Optimisation | Yes | Verified Run #3, paid, graded, BENCHMARKED |
| Grid Trading | **No** | Paid job 835 delivered nothing; 0 qualifying benchmarks |

### Remaining dependencies

1. **One more paid Grid Keeper job** (0.001 U) after the deliverable-shape fix, to reach BENCHMARKED. Not authorised; the first attempt was spent.
2. **Testnet USDT for the action wallet.** Proven route: 0.0778 tBNB per 1 USDT via PancakeSwap V2 pair `0x5f52ad4b…`. Requires swap authorisation.
3. BSC Testnet versus Mainnet main-track eligibility remains unresolved by published material; `FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED` stands (ADR-045).

## Status re-stated 2026-08-31 (Directive #20)

> **HISTORICAL STATE — SUPERSEDED by the Directive #21 status below.** The `NoSpendPermissions` incident, failed execution, and revocation are preserved as recorded evidence.

| Track | Status |
| --- | --- |
| Build the Era main track | **Four of four categories first-class.** Grid Keeper took a corrective paid ERC-8183 job (837, settled COMPLETED, valid deliverable, 0.001 U), scored 16/16 on GridBench graded from that deliverable, and is now BENCHMARKED. The earlier failed job 835 remains in the record. |
| TermiX | Met and untouched: 3 of 3 pairs, wins 2, losses 1. GridBench added no pair and no win. |
| PancakeSwap | Range Keeper graded; Grid Keeper benchmarked, hireable, and permitted only to call the V2 router's swap method inside a revocable session. |
| Altana | **NOT satisfied.** `ALTANA_REAL_SESSION_EVIDENCE = false`. |

### Altana requirement matrix

| Requirement | Met | Evidence |
| --- | --- | --- |
| Real on-chain session | **Yes** | Grant `0x295800e1…` |
| Bounded permission | **Yes** | 12 of 12 verification checks, `broaderThanIntended: []` |
| Exact contract and method allowlist | **Yes** | V2 router `0xD99D1c33…`, selector `0x38ed1739` |
| Spend cap | **Yes** | 1.5 USDT on the exact token |
| Expiry | **Yes** | 6 hours |
| **Real session-key transaction** | **No** | Refused with `NoSpendPermissions`; nothing moved |
| User-visible permission | **Yes** | `/leash` derives state from the stored session |
| Revocation | **Yes** | `0x58ef1ea7…` |
| Revoked-state verified | **Yes** | `REJECTED_BECAUSE_REVOKED`, residual allowance 0 |

Eight of nine. One unmet requirement is enough, so the track is not claimed.

### Four-category status, derived

| Category | First-class? | Evidence |
| --- | --- | --- |
| Health Factor Monitoring | Yes | Verified Run #1, BENCHMARKED |
| Rebalancing | Yes | Verified Run #2, BENCHMARKED |
| Yield Optimisation | Yes | Verified Run #3, BENCHMARKED |
| Grid Trading | **Yes** | Paid job 837, GridBench 16/16, BENCHMARKED |

### Remaining dependencies

1. **One Altana session-key execution**, with a spend permission covering the relay's native fee token (or `feeToken: USDT`). This is the only unmet Altana requirement.
2. BSC Testnet versus Mainnet main-track eligibility is still unresolved by published material; `FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED` stands (ADR-045).

## Status re-stated 2026-08-31 (Directive #21)

| Track | Status |
| --- | --- |
| Build the Era main track | **Four of four categories first-class**, unchanged by this directive. |
| TermiX | Met and untouched: 3 of 3 pairs, wins 2, losses 1. |
| PancakeSwap | Grid Keeper executed a real V2 swap through a bounded, revocable session key. |
| Altana | **Technical requirement set met.** `ALTANA_REAL_SESSION_EVIDENCE = true`. This is not a claim to have won the track. |

### Altana requirement matrix

| Requirement | Met | Evidence |
| --- | --- | --- |
| Bounded session | **Yes** | 13 of 13 checks, `broaderThanIntended: []` |
| Call allowlist | **Yes** | One contract, one method: V2 router, `0x38ed1739` |
| Spend cap | **Yes** | USDT 1.01 trade cap; native 0.000123 fee-only cap |
| Expiry | **Yes** | One hour |
| On-chain registration | **Yes** | Grant `0xe914d286…`, KeyStore `0x6b8361C2…` |
| **Real session-key transaction** | **Yes** | **`0x65a3a85e…`**, block 128,319,349, via orchestrator `0xcb5cef3c…` |
| Visible permissions | **Yes** | `/leash` derives every fact from the stored session |
| Revocation | **Yes** | `0x56f6378d…` |
| Revoked state verified | **Yes** | `account.getKeys()` no longer lists the session key |

Nine of nine.

> **HISTORICAL STATE — SUPERSEDED by Directive #22.** The eligibility gap below is retained as the state before the organizer clarification.

### Remaining gap

BSC Testnet versus Mainnet main-track eligibility is still unresolved by published material. `FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED` stands (ADR-045). Altana's testnet acceptance says nothing about the main track, and no mainnet write has been performed.

## Status re-stated 2026-08-31 (Directive #22)

| Track | Status |
| --- | --- |
| Build the Era main track | **Four of four categories first-class**, unchanged. BSC Testnet chain 97 is confirmed eligible for basic final judging by BNB Chain Support; BSC Mainnet is optional for stronger submission context, not a basic requirement. |
| TermiX | Met and untouched: 3/3 pairs, wins 2, losses 1. |
| PancakeSwap | Grid Keeper's bounded, revocable BSC Testnet V2 swap proof remains separate from marketplace benchmark metrics. |
| Altana | Technical requirement set met: one bounded session-key execution, on-chain registration, revocation, and revoked-key verification. |
| x402 | **Not implemented or claimed.** The installed SDK has buyer-side x402 signing primitives, but the official seller/facilitator runtime required by current Studio documentation is not installed. |

### Eligibility resolution

`FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED` is **RESOLVED** by the BNB Chain Support clarification recorded in ADR-065. The ticket is not treated as a public-rules amendment, and no private support-account information is published.

### x402 compatibility gate

The current official BNB Agent Studio docs describe `/x402` as a seller face backed by `@bnbagent/studio-runtime`, with bounded payment handling and B402 settlement. The installed repository has `@bnbagent/sdk@0.5.4` only: its x402 surface is buyer-side `X402Signer`/`SessionBudgetTracker` plus quote/payment types, with no seller verification or settlement API. `@bnbagent/studio-runtime` is absent and the installed `bag` CLI is broken because its nested `viem` dependency is missing, so Directive #22's early-stop condition is met. No x402 endpoint, payment proof, or x402-derived marketplace claim was fabricated.

### Remaining dependency

Install and pin the current official seller/runtime surface, then repeat the x402 preflight and authorize at most one BSC Testnet payment only if every stated gate passes. Until then, ERC-8183 remains the only Canned-verified commerce rail.
