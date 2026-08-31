# Architecture and Marketplace Alpha

This is the implemented Marketplace Alpha plus Reference Fleet Foundation slice. It keeps the proven discovery, evidence, benchmark, and protocol boundaries while adding four category shelves, evidence ladder projections, comparison, protocol-aware activation review, negative history, conservative scheduler policy, and an explicitly first-party Health Factor reference module.

## Recommended stack

- TypeScript-first workspace, Node 22 or newer, because current BNB Agent Studio supports a TypeScript end-to-end flow.
- React-based web app for the public marketplace and run detail pages.
- Node/TypeScript API for catalog queries, run creation, and server-side integration credentials.
- Worker process for benchmark execution, polling, deadlines, and artifact finalization.
- PostgreSQL for the queryable catalog and run index. A local SQLite adapter may be used for deterministic offline development, but it must not be presented as production parity.
- Content-addressed object storage or IPFS for canonical manifests and raw artifacts. The current slice uses a local content-addressed file store and keeps the storage seam replaceable.
- `viem`, the official `@bnbagent/sdk@0.5.5`, and `@bnbagent/studio-runtime@0.0.13` for protocol work. The official `bag@0.0.13` CLI is installed for isolated Studio probes; cloud deployment is not claimed.

## Repository shape

```text
canned/
  apps/
    web/                 public marketplace UI
    api/                 keyless public API and server integrations
  packages/
    domain/              types, schemas, state machines, deterministic scoring
    evidence/             canonicalization, hashes, artifact manifests
    adapters/             ERC-8004, 8004scan, A2A/MCP/HTTP, ERC-8183, Altana, x402
    fixtures/             clearly labeled offline agents and benchmark cases
  workers/
    runs/                benchmark runner, control runner, evaluator
  docs/
  scripts/
```

The current implementation is intentionally flatter than the target marketplace shape:

```text
canned/
  src/core.mjs                 canonical JSON, hashes, bounded HTTP
  src/domain.mjs               categories, states, public-metric rules
  src/discovery/8004scan.mjs  BSC-specific 8004scan adapter and probes
  src/protocol/                A2A and official SDK-backed ERC-8183 seams
  src/benchmark/               four definitions and deterministic runner
  src/persistence/             local persistent index and evidence store
  src/doctor.mjs               environment and write-safety diagnostics
  src/server.mjs               marketplace and inspection API/page
  scripts/                     inventory and fixture entrypoints
  tests/                       deterministic and failure-path tests
  web/inspection.html          Marketplace Alpha surface
  src/marketplace/             agent projections, trust states, metrics, adapters
  src/scheduler/               paused repeat-run safety policy
  src/reference/               first-party fleet specs, Health Factor task, Venus reads, seller runtime, Altana policy checks
  data/inventory/              verified discovery artifact
```

PostgreSQL, object storage, worker queues, and a production UI remain later adapters, not hidden assumptions.

## Runtime boundaries

### Web

The web app is a read-heavy interface. It never receives private keys or third-party API keys. It explains network, authority, amount, and state before wallet actions. It renders loading, success, empty, error, pending, rejected, and expired states.

### API

The API owns public catalog reads, signed request validation, run creation, server-side 8004scan access, and job orchestration commands. It does not become an unrestricted signer. Any write path must be explicit, bounded, and auditable.

### Worker

The worker runs a predeclared task and its control against the same input and observation window. It stores raw outputs before computing aggregates. It uses idempotency keys, deadlines, and a retry policy that cannot silently transform a failed run into a pass.

### Domain package

The domain package contains the canonical task schema, internal run states, ERC-8183 state mapping, benchmark versioning, deterministic metrics, and result classification. It has no UI and no network side effects, so it can be tested heavily.

### Adapter package

Adapters isolate protocol differences:

- Identity adapter: ERC-8004 registration and endpoint metadata.
- Index adapter: 8004scan server-side search and refresh.
- Invocation adapter: A2A, MCP, or HTTP with capability and health checks.
- Job adapter: ERC-8183 creation, funding, submission, evaluation, expiry, and references.
- Authority adapter: Altana session grant, execute, status, and revoke.
- Payment adapter: x402 only for per-request HTTP payment where required.

## Data model at a glance

`Agent`: canonical identity, owner/provider, categories, metadata, services, and current availability.

`ServiceCapability`: advertised protocol, endpoint, Canned-verified status, successful-use status, and last probe. Advertised is never silently promoted to verified.

`HireAttempt`: agent, protocol, price, start/end, status, payment provenance, and failure reason. It remains separate from benchmark and protocol-job state.

`Benchmark`: versioned task definition, category, initial-state rules, control definition, metric definitions, evaluator version, and task hash.

`BenchmarkRun`: agent, benchmark version, inputs hash, control version, start/deadline, internal state, protocol references, output artifacts, metric result, and final classification.

`ControlRun`: paired baseline output and timing. It is not an agent listing or public paid job.

`TrackRecord`: derived only from qualifying observed deliveries and benchmarks; it never uses fixtures.

`AgentStatus`: derived from current probes and retained history, including timeout and unavailable states.

`Job`: optional ERC-8183 client/provider/evaluator, budget token, job ID, payment transaction, description hash, deliverable hash, and protocol state.

`AuthorityGrant`: optional Altana session public key, calls allowlist, spend cap, expiry, registration transaction, and revoke transaction.

`ReferenceFleetSpec`: explicit `CANNED_REFERENCE` origin, category task contract, implementation status, provider configuration state, and bounded execution policy. Reference records never masquerade as third-party identities.

`Artifact`: canonical media type, content hash, storage URI, redaction policy, and retention status.

## State model

Application states include `created`, `funded`, `running`, `submitted`, `completed`, `rejected`, `timeout`, `error`, `insufficient_data`, and `expired`. ERC-8183 states remain exactly `Open`, `Funded`, `Submitted`, `Completed`, `Rejected`, and `Expired`; application-specific states must map to them explicitly rather than pretending every error is an ERC state.

All terminal states are retained. A retry creates a new attempt linked to the original run, not a silent overwrite.

## Onchain and offchain split

Onchain: identity pointer, job/payment state, session registration and revocation, transaction hashes, deliverable or manifest commitments, and any protocol-required attestations.

Offchain: searchable index, task JSON, control outputs, raw agent outputs, metric calculations, evaluator logs, human review notes, and UI projections.

The canonical manifest is content-addressed. A keccak256 commitment can be placed in an ERC-8183 description, deliverable, or related attestation where appropriate. The UI must say what the hash proves and what it does not prove.

## First vertical slice

The current external inventory is 32 detailed BSC testnet records from a bounded 70-result semantic search. Weigh identities 1923, 1925, and 1926 are discoverable but quarantined from new paid attempts. No non-Weigh candidate currently passes all fresh endpoint, quote, signature, category, and ERC-8183 hire guards. `RebalanceBench v1` still declares a fixed initial LP range, pool, observation window, slippage/gas limits, and decision policy. The control holds the position unchanged over the same window. Metrics include time in range, fees earned, gas and agent cost, execution failures, price impact, and inventory drift.

If the PancakeSwap endpoint is not available for reproducible testnet execution, use the official BNB Agent Studio/SDK seller example only as an infrastructure smoke test and keep the Rebalancing listing blocked. Do not turn the example into a category claim.

The first-party Health Factor vertical uses the Venus Core `getAccountLiquidity` read seam and requires authoritative position data. It is recommendation-only, preserves raw protocol fields, distinguishes endpoint from worker liveness, and returns unknown when the data source is not authoritative. The seller path is wired to the official SDK watcher and `submitResult` primitives but is blocked until a separate testnet provider wallet and explicit operator confirmation exist.

## Failure behavior

Unavailable endpoint: show `unavailable`, preserve the health-check evidence, and exclude it from live performance rankings.

Missing output: classify `error` or `insufficient_data`; never infer a pass.

Wallet rejection: show `rejected`, retain the user-visible reason if safe, and keep the run record.

Expired job: show `expired` and whether reclaim/refund was available.

Stale chain/index data: show the read timestamp and stale badge; never present stale data as live.

## Security boundary

No LLM signs transactions. No user-facing browser code gets private keys, wallet keystores, 8004scan keys, or Altana session secrets. Approvals and calls are allowlisted where the protocol supports it. Mainnet writes are disabled until an audit pass, testnet exercise, and explicit release decision.

## Public surface

The evidence pipeline described above terminates in a public product, added in Directive #16. It is a strict read layer: it derives, it does not decide.

```
registry discovery ─┐
endpoint probes     ├─→ candidates ─┐
verified quotes     │               ├─→ public-api.mjs ─→ /api/* ─→ pages
paid jobs           ├─→ runs ───────┤
graded benchmarks  ─┘               │
developer listings ─────────────────┘  (presentation only)
```

`src/marketplace/public-api.mjs` is the single place a public fact is produced. Pages hold sentences and call `/api/*`; they compute nothing factual themselves. The boundary is enforced by a test that scans the pages for hand-written figures, so it cannot erode quietly.

Developer-supplied listings enter through one guarded path and merge only into presentation fields. `applyListing` copies display name, description, claimed category, capability statement, and links; it touches nothing Canned observed, and a test asserts that trust states and track records are byte-identical before and after a listing is applied.

Eligibility is a gate in front of the shelf, not a property of a record: `assessBnbEligibility` reads the chain an identity resolves to, and only `BNB_ELIGIBLE` reaches the public list. Unverified eligibility is held in a separate bucket so it is visible without being presented as a BNB agent.

See [docs/MARKETPLACE.md](MARKETPLACE.md) for the surface contract and [docs/SECURITY.md](SECURITY.md) for the listing and ownership boundary.
