# Canned

Canned is an early-stage, evidence-led marketplace for autonomous BNB Chain agents. It is intended to help a user discover, compare, hire, and review agents using reproducible runs and onchain provenance rather than marketing claims.

## Status

Four Canned Verified Runs are complete as of 2026-09-01. The four first-party agents are BENCHMARKED; `jobs paid for and graded` is 4, with two wins and one loss in the three Agent Advantage pairs. The fourth run is GridBench evidence and is not a fourth TermiX pair. Three qualifying with-agent versus without-agent pairs now exist, including the trading-category task, so the published TermiX minimum paired-task requirement is met. Meeting a published minimum is not the same as winning a track.

The current product includes a BSC Testnet discovery path, a content-addressed evidence store, a fail-closed ERC-8183 buyer adapter backed by the official BNB SDK, four deterministic benchmark definitions, four first-party category agents, separate endpoint-verified and discovered marketplace shelves, a fixture runner, and a public inspection page. The marketplace default is derived from endpoint evidence; eligible records without a verified endpoint remain visible in the separate discovery shelf. Historical timeout, control, Altana, ERC-8183, and MPP evidence remains available with its protocol boundary stated explicitly. The public VPS deployment uses a summary-evidence projection only: exact TermiX human and agent outputs, benchmark workspaces, grading sources, and mutable runtime state remain outside the transfer payload.

The current public marketplace is available at https://canned.103-195-188-198.sslip.io. Its public VPS inspection/API surfaces expose the derived summary projection and provenance references; this release contains the exact qualifying TermiX task, agent, and control payloads under [evidence/termix](evidence/termix/), prepared for public repository publication.

Directive #4 added a separate deterministic ERC-8183 protocol control. Control job 675 used a disposable provider wallet, the official `fundedJobWatcher` and `ERC8183JobOps.submitResult`, a zero-U budget, and a local deliverable endpoint. It reached `COMPLETED` with a validated deliverable after a read-only reconciliation of an initial public-RPC head-lag during URL resolution. This is infrastructure evidence only: it is excluded from product metrics, public “jobs paid for and graded,” marketplace inventory, and TermiX evidence.

## Verified Run #1

Canned hired its own registered agent, Canned Health Guard (ERC-8004 identity `97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2003`), for a real 0.001 U ERC-8183 job on BSC testnet and graded it against a human baseline that had already been sealed.

The task was `HealthBench_v1`: read a Venus position frozen at block 127521666, state its liquidation proximity, explain what changed, and give one bounded protective action. The human took the same frozen task first, blind, and their answer was content-addressed before the agent ever ran.

| Metric | Without agent | With agent |
| --- | ---: | ---: |
| Time | 5m 07s | 14m 21s |
| Cost | 0 U, no gas | 0.001 U + 0.000060257 tBNB |
| Quality | 8 / 100 | 92 / 100 |

The agent answered all five required fields and was right about the things that matter: no shortfall, not liquidatable, no prior snapshot to compare against, and no intervention warranted. It lost points for never naming which asset was collateral and which was borrowed.

**The agent was slower, and that is not rounded away.** Mid-run the Health Guard could not verify the funded job because the deployment fell back to an RPC that rejects the `eth_getLogs` range `verifyJob` needs. An operator diagnosed and fixed it, and the agent submitted 40 seconds before the onchain deadline. That downtime and that intervention are inside the agent's measured time. The pair is recorded as a **loss** on the combined advantage criterion and a decisive quality win, and it counts as one loss in the public metrics.

Job 695 reached `COMPLETED`, the deliverable is on IPFS at `QmVbNqGEQWcaYrBvNWKfHz4JSfFzw6pVobPZ8XJk6gpT1T`, and its manifest hash matches the value committed onchain. Health Guard is now `BENCHMARKED` with one observed delivery. It is not `REPEATEDLY OBSERVED`; that needs a second qualifying benchmark. `jobs paid for and graded` is now `1`, derived from run records rather than set by hand.

This is TermiX Candidate #1. Candidate #2 is the PancakeSwap pair above, which does satisfy the trading-category requirement. The track still needs a third qualifying pair.

The reference agent is first-party. It is labelled `CANNED_REFERENCE`, it is excluded from third-party agent diversity, and it received no leniency for belonging to Canned.

## Reference agents

Canned runs four first-party agents. They are labelled `CANNED_REFERENCE`, they are excluded from third-party agent diversity, and they get no leniency for belonging to Canned.

| Agent | Category | Venue | Evidence level |
| --- | --- | --- | --- |
| Canned Health Guard | Health Factor Monitoring | Venus | **BENCHMARKED** — 1 paid job, 1 observed delivery, 1 graded pair |
| Canned Range Keeper | Rebalancing | PancakeSwap | **BENCHMARKED** — ERC-8004 identity 2005, 1 paid job, 1 observed delivery, 1 graded pair |
| Canned Yield Scout | Yield Optimisation | Venus | **BENCHMARKED** — ERC-8004 identity 2034, 1 paid job, 1 observed delivery, 1 graded pair |
| Canned Grid Keeper | Grid Trading | PancakeSwap V2 | **BENCHMARKED** — ERC-8004 identity 2045, one corrective paid run, one observed delivery |

All four hackathon categories now have a first-party reference agent. Grid Keeper is a recommendation and bounded-execution proof, not a claim of profitability or a native limit-order book.

## Canned Range Keeper

Range Keeper answers the question a PancakeSwap liquidity provider actually has: *my liquidity is sitting in this range — is it still healthy, is price drifting toward an edge, and should I leave it alone or rebalance?*

It reads the pool and the position directly from PancakeSwap V3 — `slot0`, `liquidity`, `tickSpacing`, the position's `tickLower`/`tickUpper`, and the pool's own TWAP oracle — and returns whether the position is in range, which bound is nearer and by how much, how the market moved relative to the range, whether a rebalance is justified, a tick-aligned replacement range only when one is justified, and the trade-offs being accepted.

**Holding is a first-class answer.** A rebalance is recommended only when the position has left its range, or when it sits within the act threshold of an edge *and* drift is carrying it further that way. Rebalancing costs gas, realises impermanent loss, and restarts fee accrual, so drifting is not on its own a reason to act.

Range Keeper v1 is recommendation-only. It never removes liquidity, mints liquidity, swaps, or approves spending. When a rebalance is justified it emits a `PLANNED_NOT_AUTHORIZED` plan shaped for a future Altana session — position manager only, `decreaseLiquidity`/`collect`/`mint` only, slippage cap, short expiry, revocable, operator confirmation required. No such session exists.

### Verified Run #2

Canned hired Range Keeper (ERC-8004 identity `97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2005`) for a real 0.001 U ERC-8183 job — job 700 — against the sealed RebalanceBench v1 task.

| Metric | Without agent | With Range Keeper |
| --- | ---: | ---: |
| Time | 2m 33s | 1m 10s |
| Cost | 0 U, no gas | 0.001 U + 0.000060257 tBNB |
| Quality | 30 / 100 | 100 / 100 |

**Agent advantage: yes.** Faster by 83 seconds and 70 points higher.

The right answer was to do nothing. The position sat 70 ticks from the nearer bound of a 200-tick range and the hour's drift was small and moving away from it, so paying gas and realising impermanent loss to rebalance would have cost the LP for no gain. Range Keeper said hold. The human said they would rebalance.

Two of the human's six answers were arguably under-credited by the frozen evaluator — "yes it is" is a correct answer to an in-range question, and "around 5 USDT per wbnb" is the correct distance to the nearer bound. **Those scores were not corrected after the fact**, because the evaluator was frozen before the answer existed. Crediting both would move the human to 46.7, still well short of 100. The gaps are recorded for evaluator v2. See the [benchmark methodology](docs/BENCHMARK-METHODOLOGY.md) for the full disclosure.

### RebalanceBench v1

Frozen at BSC mainnet block 118445030 against the real USDT/WBNB 0.01% pool `0x172fcD41E0913e95784454622d1c3724f546f849` and real position NFT #7261944 (ticks -65724 to -65524).

PancakeSwap V3 is deployed on BSC testnet at the same addresses, and testnet was tested first. It was rejected on evidence: testnet pools report mutually inconsistent ticks across fee tiers for the same pair, and every one observed had an observation cardinality of 1, so there is no price history to reason about. Market data is therefore read from mainnet **read-only**; every payment, quote, job, and agent execution stays on BSC testnet, and no mainnet write path exists.

The evaluator is deterministic and was written and frozen before anyone answered. It scores six dimensions taken from the precommitted output schema, and every check can be satisfied from prose or from a structured deliverable.

One thing this pool forced into the open: it is quoted USDT-per-WBNB, so a *rising tick* is a *falling* price, and the nearer bound is simultaneously the lower tick and the higher price. Scoring "up" or "lower" would have marked a correct human answer wrong for choosing the other convention. Movement is therefore scored against the position's own range, and the nearer bound on unambiguous identification. Tested before any human saw it: the agent and a competent human answer written in *either* convention all score 100.

## Canned Yield Scout

Yield Scout answers the question a stablecoin holder actually has: *is there a better place for this right now, and after the swap and the gas is moving actually worth it over my horizon?*

It reads every listed Venus Core stablecoin market at one block — supply rate, utilisation, available liquidity, incentive speed — derives each market's APR from its own `blocksPerYear` constant rather than an assumed block time, quotes what moving to each destination would really cost, and applies a policy declared before any data was read.

**The highest advertised yield is not the answer by default.** A destination has to be materially larger than the position, keep the position a small share of that market, repay the move's cost inside the horizon, and still be ahead by a margin. Otherwise staying put is correct.

Yield Scout v1 is recommendation-only: it never withdraws, supplies, swaps, borrows, repays, bridges, or approves spending. A justified move produces a `PLANNED_NOT_AUTHORIZED` plan shaped for a future Altana session, with a protocol and method allowlist, an amount cap, a maximum swap cost, a short expiry, and required operator confirmation.

### Verified Run #3

Canned hired Yield Scout (ERC-8004 identity `97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2034`) for a real 0.001 U ERC-8183 job — job 810 — against the sealed YieldBench v1 task.

| Metric | Without agent | With Yield Scout |
| --- | ---: | ---: |
| Time | 3m 17s | 57s |
| Cost | 0 U, no gas | 0.001 U + 0.000060257 tBNB |
| Quality | 58.21 / 100 | 100 / 100 |

**Agent advantage: yes.** Faster by 140 seconds and 41.79 points higher.

The correct destination was FDUSD, and the interesting part is why USDT was not. USDT is the deeper, cheaper-to-reach market and the obvious human choice — but its net benefit on a 25,000 position works out at 2.5 bps over 30 days, below the 5 bps floor declared before the data was read. FDUSD clears it at 9.83 bps, holds 102x the position in liquidity, and breaks even immediately because the routed swap into it is favourable. The human chose USDT, and was right that a move was justified.

Two of the human's answers were arguably under-credited by the frozen evaluator: a yield advantage given in dollars per year, which the rubric can only read in percentage or basis points, and cost erosion named as a trade-off, which its keyword list misses. **Those scores were not corrected after the fact**, because the evaluator was frozen before the answer existed. Crediting both would move the human to 74.63, still short of 100. See the [benchmark methodology](docs/BENCHMARK-METHODOLOGY.md) for the full disclosure.

### YieldBench v1

Frozen at BSC mainnet block 118529435: a 25,000 USDC position in Venus vUSDC, compared against every listed Core stablecoin market over a 30-day horizon. Market data is read-only; every payment and agent execution stays on BSC testnet, and no capital is ever moved.

Every figure comes from the same block — rates, liquidity, swap quotes, gas price, and the BNB price used to express gas in USDC. The freeze fails closed rather than mixing moments.

One finding shaped the design: quoting 25,000 USDC into FDUSD through the **direct** pool costs 21.32%, while the same swap **routed through USDT** costs -0.037%. Pricing a destination off the obvious pool would have rejected a good opportunity for the wrong reason, so both routes are quoted for every candidate and the cheaper one prices the move.

The evaluator was written, tested against nine different answer styles, and frozen before anyone answered. A plain-English answer, a rounded-numbers answer, and a basis-points answer all score within 10.45 points of a precise technical one. Wrong reasoning ranks below right reasoning in every case. See the [benchmark methodology](docs/BENCHMARK-METHODOLOGY.md) for the full table.

## Project documents

- [Project understanding](docs/PROJECT.md)
- [Hackathon requirements matrix](docs/HACKATHON-REQUIREMENTS.md)
- [Initial architecture](docs/ARCHITECTURE.md)
- [Benchmark methodology](docs/BENCHMARK-METHODOLOGY.md)
- [Architecture decisions](docs/DECISIONS.md)
- [Environment and readiness](docs/ENVIRONMENT.md)
- [The public marketplace](docs/MARKETPLACE.md)
- [Security](docs/SECURITY.md)
- [Grid Keeper and The Leash](docs/GRID-KEEPER.md)

## Canned Grid Keeper and The Leash

The fourth category. Grid Keeper runs a bounded grid on a PancakeSwap pair and is the only Canned agent that can move capital, which is why it ships with a permission system rather than a promise.

**It does not place native limit orders.** PancakeSwap's Gelato-powered limit orders are deprecated, and the Infinity `CLLimitOrder` hook is source-only with no deployment on BSC testnet. Grid Keeper runs software-managed levels executed as real PancakeSwap swaps, and every surface says exactly that. It never invents an order id, and a test enforces it.

The Leash is what a user approves before it can act:

| It may | It may not |
| --- | --- |
| Trade the one pair, inside the range you set | Withdraw your assets anywhere |
| Call one contract and one method, enforced on chain | Call any other contract |
| Spend up to the cap, from your wallet only | Raise its own cap or extend its own expiry |
| | Act at all after you revoke |

The permission is an Altana session key naming an exact contract **and** an exact method selector, with a spend cap and an expiry. Revocation is one transaction. With no session granted, The Leash reads `NOT_CONFIGURED` rather than describing an authority that does not exist. Try it at `/leash`.

Current state: Grid Keeper is ERC-8004 agent **2045**, deployed, hireable, and **BENCHMARKED**; the earlier failed job 835 stays in the record beside the corrective job 837. **All four categories are first-class.** A bounded Altana session was granted, used for **one real session-key PancakeSwap V2 trade** (`0x65a3a85e…`, 1 USDT in, 0.0778 WBNB out), then revoked, with the session key verified gone from the account on chain. `ALTANA_REAL_SESSION_EVIDENCE = true`.

The final Altana proof ran on BSC Testnet (chain 97) from action wallet `0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f` against the exact testnet USDT contract. The permission named only `swapExactTokensForTokens` on the PancakeSwap V2 router (selector `0x38ed1739`), with a 1.01 USDT trading allowance and a separate native allowance of approximately 0.00012314 tBNB for the Altana relay fee only. The actual native spend was approximately 0.0000378505 tBNB; the session allowed one fill, was revoked after execution, and the revoked key was rejected. This proves bounded execution capability, not profitability, market alpha, or that Canned won an Altana track.

## The public product

Canned has a public surface a visitor can use without knowing what ERC-8004 is.

| Route | What it is for |
| --- | --- |
| `/` | Explanation. What Canned is, why an agent's claims are not enough, and the evidence produced so far. |
| `/marketplace` | Discovery. Search, filter by category, sort, compare agents side by side. |
| `/agent/:identity` | One agent, leading with what was observed. Identity and hashes sit behind a disclosure. |
| `/compare` | Evidence comparison view for selecting agents in one category. |
| `/inspection` | Runs, gradings, Agent Advantage pairs, venue evidence, and the recorded MPP payment boundary. |
| `/list` | List or claim an agent by proving wallet ownership with a signature. |
| `/leash` | The Grid Keeper authority view, including scope, expiry, and revocation state. |

Two rules govern that surface.

**Marketplace facts are derived; only product copy is written by hand.** Every count, price, trust label, win, loss, run number, and hash comes from `src/marketplace/public-api.mjs`, computed from evidence records. The sentences around them are written. A test scans the four public pages and fails the build if a figure was typed into HTML. See [ADR-044](docs/DECISIONS.md).

**Unknown stays unknown.** An untested agent reports `wins: null`, not `0`, and no price rather than an advertised one. A win rate appears only at two or more benchmarks. Eligible agents without endpoint evidence are visible in the separate discovery shelf and are not presented as verified or available.

Canned proves ownership with a wallet signature and **never asks for a private key, a seed phrase, or a wallet password**. See [docs/SECURITY.md](docs/SECURITY.md).

## Local setup

Requires Node.js 22 or newer. From this directory:

```powershell
npm install
npm test
npm run doctor
npm run benchmark:fixture
npm run inventory
npm run wallet:create
npm run wallet:check
npm run control:weigh-family
npm run benchmark:paid
npm run health:baseline:audit
npm run health:grade
npm run rpc:check
npm run range:baseline:audit
npm run yield:baseline:audit
npm run yield:evaluator:fairness
npm run serve
```

The blind YieldBench baseline is at `http://localhost:8787/baseline/yield`. `npm run yield:evaluator:fairness` runs the pre-answer fairness cases, and `npm run yield:baseline:audit` proves no ranking, decision, or evaluator output reaches that page before it is answered.

The blind RebalanceBench baseline is at `http://localhost:8787/baseline/rebalance`. It shows only the frozen task and the raw position data, starts a server-side timer, preserves exactly what is typed, and seals and hashes the answer on submission. `npm run range:baseline:audit` proves no classification, decision, replacement range, or evaluator output reaches that page before it is answered.

`npm run rpc:check` audits the RPC every ERC-8183 watcher depends on. It reports whether the BNB SDK is silently falling back to its default endpoint and whether the configured endpoint can serve the `eth_getLogs` range `verifyJob` performs — the failure that cost Verified Run #1 its speed.

The paired with/without comparison is at `http://localhost:8787/inspection#advantage`. The local canonical view retains exact outputs; the public VPS deployment shows derived time, cost, quality, transaction, artifact-hash, and provenance summaries, while this release contains the three required raw TermiX payload sets under [evidence/termix](evidence/termix/) for public repository publication.

`npm run health:hire` is the paid path for the reference agent and requires `CANNED_ALLOW_TESTNET_WRITES=true`. It refuses to spend unless the frozen benchmark still matches its own precommit, the human baseline is sealed and hash-intact, the live worker and watcher are alive, storage is IPFS, the ERC-8004 owner and provider match onchain, a fresh provider-signed quote verifies, and the provider payload contains no trace of the human answer. `npm run health:reconcile` observes a late-but-in-deadline submission and settles it without erasing the original timeout. `npm run health:grade` computes ground truth from the frozen snapshot and scores both sides with one rubric.

The inspection page is served at `http://localhost:8787/inspection`. `npm run inventory` is read-only and writes the verified candidate report to `data/inventory/verified-candidates.json`. The current report is a live snapshot, not a marketplace ranking. `npm run public:summary` builds the deployment data directory from canonical evidence without copying raw outputs or runtime state; it requires `CANNED_PUBLIC_OUTPUT_DIR`.

The fresh candidate workflow persists a readiness matrix and provider history. It does not immediately retry a provider after a paid timeout, and it stops before funding when no remaining candidate passes the required checks. The selected `weighladder-agent` (BSC testnet identity 1926) acknowledged job 673 but did not produce an onchain submission before its bounded deadline, so it is now cooled down and remains unqualified.

Public metadata correlates identities 1923, 1925, and 1926 as `SAME_IMPLEMENTATION_FAMILY_LIKELY`; this does not prove a common operator or repository.

`npm run benchmark:fixture` exercises the full persistence and evaluator path without network writes. Fixture records are explicitly excluded from public metrics.

`npm run wallet:create` creates one disposable SDK-encrypted testnet keystore and an ignored `.env.local`. `npm run wallet:check` performs read-only balance, allowance, token, gas, and selected-candidate checks. `npm run inventory` refreshes the public candidate matrix and quote/readiness evidence. `npm run benchmark:paid` is the explicit write path and requires `CANNED_ALLOW_TESTNET_WRITES=true`; it refuses mainnet, cooled-down providers, systemic repeated failures, and insufficient funds.

The paid test used only BSC testnet. Its final run record, protocol events, timeout, control, evidence hashes, refund, and Router expiry reconciliation are available through the inspection route and local content-addressed state. Keep the wallet write flag disabled after testing. Do not send funds from a normal wallet and do not enter a private key into Canned.

## Toolchain boundary

`@bnbagent/sdk@0.5.5`, `@bnbagent/studio-runtime@0.0.13`, `@bnb-chain/mpp@0.7.0`, and `mppx@0.8.12` are pinned local protocol dependencies. The official BNB Agent Studio CLI is repaired and pinned at `bag@0.0.13`; AgentCore is not installed and remains optional. The current Canned buyer seam and protocol control use the SDK directly, the Health Guard x402 face uses the official Studio seller runtime, and the generic MPP fallback uses the official MPP server. The public marketplace is deployed as a separate Node service behind the existing Caddy VPS architecture; the existing Health Guard, Range Keeper, Yield Scout, Grid Keeper, Technocore, and Tradoor routes remain separate.

Directive #23 adds the Health Guard `/x402` face through the official Studio B402 seller runtime. It is dynamically reported at `/api/reference/health-factor/x402`, priced at `0.0005` U with a hard `0.001` U cap, and bound to the existing Health Guard provider wallet. Without B402 Sandbox/Testnet merchant credentials it remains dormant and returns a fail-closed `503`; Canned claims no x402 payment or deployment proof. ERC-8183 remains the verified commerce rail. See [docs/X402.md](docs/X402.md) and ADR-067.

Directive #24 adds a separate generic BNB-native MPP face at `/mpp`. It uses
the official `@bnb-chain/mpp` server with `mppx-managed` challenge binding,
the curated BSC Testnet `TEST_USDT` token, a payer-funded direct transfer, and
durable replay protection. It runs the existing Health Guard Quick Health
Check only after official payment verification.
This is explicitly not Binance B402 or x402; the dormant `/x402` face remains
unchanged. See [docs/MPP.md](docs/MPP.md) and ADR-068.

BNB Chain Support has confirmed that this generic MPP settlement proof is accepted for the hackathon; it remains distinct from Binance B402. The public inspection view and `/api/reference/health-factor/mpp/evidence` expose
the recorded payment, independent receipt, and replay result. They also state
that the original `Payment-Receipt` header was not retained after the paid
response, so this evidence does not overclaim a retained receipt artifact.

The B402 Sandbox signing material was rotated to a purpose-specific RSA-2048
pair in ignored local secure state. Binance merchant credentials are still
absent, so `/x402` remains dormant and no B402 payment claim is made.

The generic MPP fallback has since completed one real BSC Testnet payment:
transaction `0xcc988caa3b584717f8541e058e46943b97578015686efc014787a2f5fa21cfb7`
was independently verified and its hash replay returned HTTP 402. This proves
generic MPP payer-funded settlement and replay protection only; it is not a
Binance B402/x402 claim.

`npm run wallet:create` writes the ignored `.env.local` and encrypted SDK keystore needed for this test only. Never commit private keys, wallet keystores, API credentials, or generated deployment secrets.

## Trust boundary

An onchain identity or job hash proves that a particular payload or state transition was committed. It does not prove that an agent's output was truthful, safe, profitable, or non-malicious. Canned keeps raw outputs, controls, failures, timeouts, and evaluator versions in canonical local evidence. The public VPS summary deployment intentionally exposes only derived summaries and provenance references; this release's [TermiX evidence tree](evidence/termix/) contains the exact qualifying task, agent, and control payloads pending public repository publication.
