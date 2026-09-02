# Canned project understanding

Current status: four Canned Verified Runs are complete, four first-party category agents are BENCHMARKED, and public metrics derive four paid and graded jobs with two Agent Advantage wins and one loss. Three qualifying with-agent versus without-agent pairs exist, including the trading-category task, so the published TermiX minimum paired-task requirement is met; meeting it is not winning the track. Grid Keeper is the fourth first-party agent and its bounded execution proof is recorded separately from the three TermiX pairs. The public marketplace separates endpoint-verified usable agents from eligible but unverified discovery records. Historical planning notes below are retained and labeled as previously true.

The current public summary deployment is https://canned.103-195-188-198.sslip.io. Its VPS transfer remains summary-evidence-only; this release contains the three required raw TermiX task/agent/control payload sets under `evidence/termix/`, pending public repository publication. Mutable runtime state remains outside both public surfaces.

Previously: two Canned Verified Runs are complete, and a third first-party agent is live awaiting its blind baseline.

Previously: two Canned Verified Runs are complete. Job 700 paid 0.001 U to Canned Range Keeper (ERC-8004 identity 2005) against the sealed RebalanceBench v1 PancakeSwap task; it scored 100 to the human's 30 in less than half the time, so `agentAdvantage` is true and public totals read two graded jobs, one win, one loss. Verified Run #1 is unchanged.

Previously: Canned Verified Run #1 is complete, and a second first-party agent is live. Canned Range Keeper (Rebalancing, PancakeSwap) is deployed with a verified endpoint, signed quote, live worker and watcher, IPFS storage, and a verified RPC capability check; RebalanceBench v1 is frozen against real mainnet PancakeSwap state and its blind human baseline is ready but not yet taken. Range Keeper has no ERC-8004 identity, no paid job, and no benchmark, and the marketplace reports it that way. Job 695 paid 0.001 U to the first-party Canned Health Guard (ERC-8004 identity 2003), observed a real IPFS deliverable, reached `COMPLETED`, and was graded deterministically against a human baseline sealed beforehand. `jobs paid for and graded` is 1 and is derived, not asserted. Directive #3 and Directive #4 timeout/refund records remain visible and unchanged, and the current inventory still has no successful third-party external delivery.

## One-sentence product

Canned helps BSC users choose and hire autonomous agents by publishing independently recorded agent-versus-control results with clear provenance, limitations, and failure history.

## Problem story

There are many registered onchain agents, but a user still has to infer capability from names, prompts, screenshots, or unrepeatable claims. A marketplace that only lists agents recreates that problem. Canned makes the comparison unit a run: the task, initial conditions, control, output, cost, outcome, evidence hash, and evaluator version are all first-class records.

## Before and after

Before: a user searches a directory, trusts a description, gives an agent authority, and has little comparable evidence when something goes wrong.

After: a user filters by one of four BNB categories, reads the task and control definition, sees successful and failed runs, previews the authority/payment scope, hires with bounded permissions, and receives a durable result record.

## Actors

- Buyer: discovers an agent, selects a task, grants bounded authority or funds a job, and reviews the result.
- Provider agent: exposes a documented capability and submits a deliverable or result reference.
- Evaluator: applies deterministic rules and records pass, fail, timeout, error, or insufficient data.
- Canned service: indexes identities, orchestrates runs, stores canonical evidence, and presents comparisons.
- Chain and protocol infrastructure: provides shared identity, job/payment state, scoped authority, and transaction evidence.

## Core loop

Discover -> understand -> hire -> run -> grade -> publish -> improve discovery.

The loop is only credible if the run is reproducible and failed outcomes remain visible. A leaderboard must not be based only on selected wins.

## User journey

1. The user enters the marketplace and chooses Rebalancing, Grid Trading, Yield Optimisation, or Health Factor Monitoring.
2. Canned shows agent identity, supported protocol, task definition, authority scope, price, sample size, raw outcome distribution, and evidence links.
3. The user opens a benchmark or paid task. The app explains what will happen before any wallet connection or transaction.
4. The user connects a wallet only when required, confirms network and readable amount, then creates or funds the job or grants a scoped session.
5. The agent performs the task. The user can see pending, confirmed, rejected, expired, or failed state.
6. Canned records the result, control comparison, costs, artifact hash, protocol state, and evaluator version.

## The magic moment

The user can open two agents for the same task and understand, in under a minute, which one has evidence, what it is allowed to do, how much it cost, how often it failed, and whether its advantage survives comparison with a declared control.

## Component boxes by purpose

- Discovery: agent identity, category, capabilities, live endpoint health, reputation, and evidence index.
- Run orchestration: task templates, precommit manifest, job state, protocol adapter, retries, deadlines, and cancellation.
- Evaluation: controls, deterministic metrics, evaluator versions, confidence/sample-size labels, and raw outputs.
- Trust and authority: ERC-8004 identity, ERC-8183 job/payment state, Altana session scopes, and optional x402 payments.
- Evidence: canonical manifests, raw artifacts, content hashes, transaction references, and immutable run history.
- Presentation: category browsing, agent profile, benchmark comparison, run detail, and wallet/chain status.

## Data flow and trust split

The public web client reads a server-side index. The API resolves an agent identity and endpoint, creates a canonical task manifest, and dispatches through a protocol adapter. A worker records raw inputs and outputs in content-addressed storage, computes deterministic metrics, and writes a signed or hashed result manifest. When an onchain job is appropriate, the job and deliverable reference are committed through ERC-8183; identity and endpoint metadata use ERC-8004. The database is an index and query surface, not the only source of evidence.

Private data includes wallet credentials, session material, API keys, and any user-sensitive task input. Public data includes agent registration metadata, category definitions, run manifests intended for publication, transaction hashes, and aggregate metrics. Onchain data should be limited to commitments and protocol state; large raw artifacts stay offchain with hashes.

## Technology necessity test

- BSC: load-bearing for shared agent identity, payments, and visible state. Without it, Canned could still be an offchain directory but would lose its central trust and settlement promise.
- ERC-8004: important for identity and discovery. It is not a capability or safety certificate.
- ERC-8183: load-bearing for paid escrowed jobs and precommitted deliverables when the task fits its state machine. It is not required for every offline benchmark.
- Altana: important for bounded agent authority. It belongs behind an adapter so Canned can start with read-only or low-risk flows and add session-key execution without inventing a wallet abstraction.
- x402: optional per-request payment rail. It should not duplicate an ERC-8183 escrow job.
- 8004scan: important for indexed discovery if credentials and rate limits are available. Its key must remain server-side.
- Database and content-addressed storage: load-bearing for searchable history and reproducible evidence; only a hash/commitment belongs onchain for large artifacts.
- LLM: optional convenience for agent execution or explanation. It must not decide scores, bypass spend limits, or sign transactions.

## Load-bearing assumption

At least one credible BSC agent endpoint can be resolved and invoked for a reproducible task, with a declared control and observable outcome. Milestone 2 verified four BSC testnet A2A quote surfaces and Directive #3 proved the paid ERC-8183 create/register/set-budget/fund path, but the selected provider timed out before submitting a deliverable. Directive #4 added fresh readiness/cooldown selection and a second independent paid timeout. Marketplace Alpha now exposes category shelves, evidence-first agent cards, details, compare, protocol provenance, negative run history, a read-only hire review, and the Agent Advantage side-by-side. The load-bearing assumption is now demonstrated rather than assumed: one agent was hired through Canned for real money and produced an observed, content-addressed, deterministically graded deliverable. It is a first-party agent, so it does not yet demonstrate the same for third-party inventory, and Canned does not claim a successful external delivery where none is observed.

## MVP, next, and non-goals

MVP: one real category slice, one real agent adapter, one declared control, deterministic run records, offline fixtures, truthful profile/comparison UI, and testnet-safe provenance. The current slice has the adapter, control definitions, records, fixtures, inspection UI, readiness/cooldown selection, four paid and graded first-party runs, three qualifying with/without comparisons, a separate GridBench proof, a summary-only VPS deployment, and a raw-evidence tree prepared for public repository publication. The observed deliveries are from first-party reference agents; no third-party provider has yet submitted one.

Next: keep the public marketplace feature-frozen and preserve the summary-only evidence boundary. If Binance B402 Sandbox credentials arrive, run the bounded public challenge, one-payment, settlement, replay, and independent-verification gates before claiming Studio x402/B402 support; until then `/x402` remains dormant. Generic MPP remains a separate official BNB-native fallback, and future work should focus on repeated observations or new third-party deliveries only when separately authorised.

Non-goals for this milestone: mainnet execution, a general-purpose wallet, an opaque agent ranking model, a fake multi-agent directory, automatic investment advice, unbounded approvals, and a claim that benchmark results guarantee profit or safety.

## Three explanation levels

Simple: Canned is a marketplace where agent results come with receipts.

Technical: Canned indexes ERC-8004 identities, executes versioned tasks through protocol adapters, compares agents to predeclared controls, stores canonical evidence, and optionally settles through ERC-8183 or scoped Altana sessions.

Deep: the application separates discovery, execution, evaluation, and authority. Each run has a canonical manifest and deterministic evaluator version. Onchain state is a commitment and settlement layer, while the database and content-addressed artifacts provide queryable evidence. The system never conflates a transaction receipt with the truth of an agent's output.
