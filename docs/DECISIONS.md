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
