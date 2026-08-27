# Architecture decisions

## ADR-001: Start on BSC testnet

Decision: use BSC testnet, chain ID 97, for all initial writes and demonstrations. Mainnet is chain ID 56 and remains read-only or disabled until a release audit.

Reason: the official ecosystem supports testnet registration and the hackathon accepts testnet for the relevant Altana track. This preserves a real chain path while limiting financial risk.

## ADR-002: TypeScript-first marketplace

Decision: build the marketplace/API/worker in TypeScript on Node 22 or newer. Use BNB Agent Studio for provider-agent runtime where appropriate instead of rebuilding its signer and policy boundary.

Reason: current Studio documentation supports an end-to-end TypeScript path, while the marketplace needs one shared schema across UI, API, worker, and adapters.

## ADR-003: ERC-8004 is identity, not proof

Decision: use ERC-8004 for identity, endpoint metadata, discoverability, feedback, and validation references. Never present registration as a safety, quality, or profitability certificate.

## ADR-004: ERC-8183 is a job/payment adapter

Decision: use ERC-8183 for paid tasks and precommitted deliverables when the task fits its ERC-20 escrow state machine. Keep benchmark-only runs valid without forcing an onchain payment job.

Reason: the state machine makes client, provider, evaluator, submission, settlement, rejection, and expiry visible, but it is not a generic benchmark schema.

## ADR-005: Altana is the scoped-authority adapter

Decision: expose Altana session grants, allowed calls, spend caps, expiries, and revocation through a dedicated adapter and user-facing controls. Do not store an unrestricted agent key in the app.

## ADR-006: x402 is per-request payment only

Decision: use x402 only where a server/API request needs payment. Do not use it as a substitute for an ERC-8183 task escrow or as a reason to expose payment credentials in the browser.

## ADR-007: Deterministic scores, optional narrative

Decision: the evaluator and score are deterministic and versioned. An LLM may explain the record but cannot grade, sign, approve, widen limits, or rewrite raw evidence.

## ADR-008: Hybrid evidence

Decision: keep large manifests and raw outputs offchain in content-addressed storage; commit compact hashes and protocol references onchain where useful. The database is an index, not the sole evidence source.

## ADR-009: Fixtures are isolated

Decision: fixtures may make the UI and evaluator testable offline, but every fixture is labeled and excluded from live-agent rankings and hackathon claims.

## ADR-010: Rebalancing is the first category hypothesis

Decision: target a PancakeSwap V3 range-rebalancing slice with `RebalanceBench v1` and a fixed-range control, contingent on verifying an actual live endpoint/repository and meaningful testnet conditions.

Reason: it aligns with one required category, the PancakeSwap track, and the documented V3 rebalancing pattern. If the endpoint cannot be verified, infrastructure smoke testing proceeds with an official Studio/SDK example while the category claim stays blocked.

## ADR-011: Keep Milestone 2 evidence local and content-addressed

Decision: use a persistent local file store for the first vertical slice, with separate state, evidence, inventory, and run records. Store canonical bytes with SHA-256 and Keccak-256 content hashes, and keep PostgreSQL/object storage behind a later adapter.

Reason: the evidence boundary and failure behavior can be tested now without pretending that a production database or IPFS pin exists. The local store is temporary infrastructure, not a marketplace-scale claim.

## ADR-012: Use the official BNB SDK directly for the buyer seam

Decision: use `@bnbagent/sdk@0.5.4` for ERC-8183 buyer construction and lifecycle calls. Keep writes disabled unless the network is exactly BSC testnet, the explicit testnet-write flag is true, and a dedicated wallet configuration is present. Mainnet writes always fail closed.

Reason: this follows the current official TypeScript SDK surface while keeping the first buyer integration independent of the unresolved Studio CLI installation. No SDK call is allowed to turn a quote probe or fixture into a public benchmark result.

## ADR-013: Trust is an evidence ladder

Decision: expose LISTED, ENDPOINT VERIFIED, QUOTE VERIFIED, HIRE ATTEMPTED, DELIVERY OBSERVED, BENCHMARKED, and REPEATEDLY OBSERVED as separate derived states. Do not compress them into a composite Canned score until sample methodology is defensible.

Reason: a live endpoint or verified quote is useful discovery evidence, but it is not proof that a provider delivered work. Unknown values remain unknown rather than becoming zero.

## ADR-014: Hiring is protocol-aware

Decision: the marketplace records advertised, Canned-verified, and successfully used protocol capabilities separately. A Hire action is enabled only for a verified adapter with a bounded testnet activation path. ERC-8183, x402/B402, A2A, HTTP task APIs, and MCP are not interchangeable.

Reason: the Weigh control diagnosis showed that nominal ERC-8183 compatibility and accepted `notify_funded` do not prove delivery. The marketplace must represent actual activation semantics.

## ADR-015: Quarantine implementation families, not identities forever

Decision: keep Weigh-family identities 1923, 1925, and 1926 discoverable with factual failure history, but block new paid attempts while the systemic guard is active. This is not a permanent blacklist or a claim of misconduct.

## ADR-016: Conservative repeat scheduler

Decision: provide a paused scheduler policy with testnet-only chain guard, 1.0 U aggregate cap, 0.25 U daily cap, one attempt per provider, 24-hour failure cooldown, and no automatic retry. Every future run requires a fresh precommit.

## ADR-017: Reference agents are explicit fallback inventory

Decision: build a Canned Reference Agent only when a fresh bounded inventory review leaves a required category without a defensible external path. Reference agents get separate identities and labels and cannot count as third-party agent diversity.

## ADR-018: HealthBench has a blind human boundary

Decision: freeze raw Venus evidence and the evaluator commitment before collecting a human answer. The baseline route reveals only the task, permitted sources, and raw authoritative reads; it preserves the raw submission and server timing without exposing ground truth or agent output. The benchmark task route remains blocked until the baseline is submitted.

Reason: an evidence marketplace is only credible if the without-agent comparison cannot be contaminated by the product’s own answer.

## ADR-019: Public seller evidence requires durable storage

Decision: local filesystem deliverables are development-only. Public Health Guard fulfillment requires the official SDK IPFS/content-addressed storage provider, public HTTPS readiness, and a fresh signed quote check before ERC-8004 registration.

Reason: a local file path cannot be independently retrieved by a buyer, judge, or evaluator and must not be presented as durable evidence.

## ADR-020: Provider, buyer, benchmark, and future action wallets are separate authorities

Decision: the Canned buyer wallet pays external agents, the HealthBench wallet owns only the disposable Venus position, the reference provider wallet signs quotes and submits seller results, and any future Altana action wallet is a separate scoped authority. No wallet may silently inherit another wallet’s role.

Reason: the safest Venus release is read-only and recommendation-first, with any later action limited to an allowlisted, bounded call under an expiring registered session.

## ADR-021: getAccountLiquidity is the authoritative HealthBench answer

Decision: the deterministic HealthBench evaluator grades against the Venus Comptroller's own `getAccountLiquidity` output. The market-level reconstruction from `markets()`, balances, exchange rates, and oracle prices is computed and published, but it is secondary and is never the graded quantity.

Reason: on the frozen block the recorded vBNB collateral factor of 0.7 does not reproduce the protocol's own liquidity figure, which implies 0.8. Rather than pick a story, the evaluator publishes both numbers and marks the reconciliation inconsistent. Neither the human nor the agent is graded on the derived figure, so the discrepancy cannot bias the comparison.

## ADR-022: One rubric, satisfiable from prose or from structure

Decision: the five scored dimensions are exactly the precommitted `task.expectedOutputSchema` fields. Every check can be satisfied either by a structured deliverable field or by the equivalent statement in prose, so a machine-readable responder earns no credit that a human writing sentences could not also earn.

Reason: a with/without comparison is worthless if the rubric is shaped like one side's output format. The rubric was written from the precommitted schema, and both answers were sealed and content-addressed before it existed.

Limitation recorded honestly: the detailed check list was authored after both answers were sealed. The precommitted artefacts are the task, the output schema, the frozen snapshot, and the evaluator version, not the individual check weights.

## ADR-023: Reference hire readiness is derived, never asserted

Decision: `referenceAgentCandidate` computes hire readiness from five separately observed conditions - onchain identity, configured provider, verified public readiness, a verified fresh quote, and a sealed human baseline. It no longer returns a hardcoded value.

Reason: the previous hardcoded `ready: false` was correct before the baseline existed but could only be moved by editing a literal. Deriving it keeps the gate fail-closed while letting real observations open it, and it makes the reason machine-readable.

## ADR-024: The reference agent gets no allowance for being first-party

Decision: Health Guard downtime, operator intervention, and elapsed time are counted against the agent exactly as they would be for a third-party provider. Agent elapsed time runs from quote request to the provider's own onchain submission.

Reason: during Verified Run #1 the Health Guard failed to serve a funded job because of an RPC misconfiguration, and an operator fixed it mid-run. Excluding that would have made the agent look faster than it was. The intervention is recorded in the run and included in the measured time, which is why the first pair is recorded as a loss on the combined advantage criterion.

## ADR-025: A late but in-deadline submission is reconciled, not rewritten

Decision: when a provider submits after Canned's local observation window but before the onchain submit deadline, the run is reconciled in place. The original timeout observation is preserved under `reconciliation.originalObservation` and the final chain state is recorded alongside it.

Reason: deleting the timeout would hide that Canned's own client gave up early. Keeping both is the honest record of what each party did.
