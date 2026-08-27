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
