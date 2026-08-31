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

## ADR-026: PancakeSwap market data is read from mainnet, payments stay on testnet

Decision: RebalanceBench v1 freezes real BSC mainnet PancakeSwap V3 pool and position state, read-only. Every Canned payment, quote, ERC-8183 job, and agent execution remains on BSC testnet, and no mainnet write path exists.

Reason: PancakeSwap V3 is deployed on BSC testnet at the same addresses, so a testnet benchmark was genuinely available and was tested first. Its pools report mutually inconsistent prices across fee tiers and an observation cardinality of 1, meaning no arbitrage and no price history. A rebalancing benchmark on that data would measure nothing. The directive's instruction not to force testnet where it produces useless market conditions applies exactly here.

## ADR-027: Tick direction is quote-dependent, so the rubric never scores it

Decision: RebalanceBench scores market movement relative to the position's own range, and scores the nearer bound on unambiguous identification rather than on the words "upper" or "lower".

Reason: in a USDT/WBNB pool a rising tick is a falling USDT-per-WBNB price, and the nearer bound is simultaneously the lower tick and the higher price. Scoring the direction word would have marked a correct human answer wrong purely for choosing the other quote convention. This was caught by testing the rubric against the same answer written both ways before any human saw the task.

## ADR-028: Readiness must prove the watcher can read the chain

Decision: reference services probe the RPC for the `eth_getLogs` range `ERC8183JobOps.verifyJob` performs, publish the result on `/readiness` and `/rpc`, refuse to start a funded-job watcher when it fails, and re-probe periodically. `publicReadinessFailures` treats an incapable or defaulted RPC as fatal.

Reason: during Verified Run #1 the Health Guard reported a healthy endpoint, a live worker, a live watcher, working storage, and a valid signed quote while being unable to accept any funded job, because the deployment set `CANNED_RPC_URL` and the BNB SDK reads `RPC_URL_BSC_TESTNET`. An `eth_chainId` check cannot catch that; the log-range probe can.

## ADR-029: Each reference agent gets its own identity, wallet, endpoint, and readiness gate

Decision: reference-agent readiness, metadata, category checks, service version, provider wallet, and ERC-8004 identity are all resolved per agent. `referenceFleetIdentityFailures` refuses a shared identity or endpoint, and registration refuses to reuse another agent's provider wallet.

Reason: the plumbing was written for a single agent and hardcoded Health Guard's category and identity. Two agents sharing an identity or a wallet would merge their evidence and make a future Altana session over-broad.

## ADR-030: Range Keeper v1 observes and recommends only

Decision: Range Keeper never removes liquidity, mints liquidity, swaps, or approves spending. A justified rebalance produces a `PLANNED_NOT_AUTHORIZED` plan with a contract allowlist, a method allowlist, a slippage cap, an expiry, and required operator confirmation.

Reason: it keeps RebalanceBench scientifically clean — the human and the agent are compared on the same judgement, with neither moving capital — and it means adding Altana later is a matter of granting a session that already has a declared shape, not redesigning the agent.

## ADR-031: A frozen evaluator is never retuned after seeing an answer

Decision: when review of a graded answer reveals that the evaluator under-credited a semantically correct response, the score stands. The limitation is disclosed alongside the result, a sensitivity figure is published, and the fix is scheduled for the next evaluator version.

Reason: RebalanceBench v1 scored two of the human's six dimensions at zero where the answer was defensible — "yes it is" to an in-range question, and a correct distance where the evaluator wanted the bound. Correcting those after the fact would have raised the human's score using knowledge of the human's answer, which is exactly what a precommitted evaluator exists to prevent. Publishing the gap costs nothing; hiding it or quietly patching it would make every future score unfalsifiable.

## ADR-032: Qualification flags are recomputed at grading, not edited

Decision: a run's qualification flags are derived twice — provisionally at hire time, then recomputed by `deriveQualificationFlags` once deterministic grading has produced an evaluation status. The grading step never edits individual flags.

Reason: `qualifiesForPublicMetrics` depends on `performanceDataSufficient`, which cannot be known before the evaluator has run. Writing it at hire time necessarily produced a provisional `false`. Recomputing keeps the public metric derived rather than asserted, and keeps the reason for a change auditable.

## ADR-033: A dropped request is not an unready provider

Decision: the paid-hire preflight retries each readiness probe a bounded number of times and reports transport failure separately from a readiness verdict.

Reason: a single transient network failure made all four readiness probes fail at once and rendered as eleven readiness failures, which reads like a broken agent rather than a dropped connection. The run correctly refused to spend either way, but the distinction matters for diagnosing a provider fairly.

## ADR-034: TermiX category status is stated per pair, from the pair's own category

Decision: the TermiX qualification string is generated from the pair's category and the current pair count rather than from a fixed sentence.

Reason: the message hardcoded "Health Factor Monitoring does not satisfy that category requirement", which stayed in the output after a PancakeSwap trading pair existed and satisfied it. Published qualification text has to track the evidence.

## ADR-035: Yield comparison is read at one block or not at all

Decision: every figure in YieldBench comes from a single block: supply rates, utilisation, liquidity, each destination's swap quote, the gas price, and the BNB price used to express gas in the position asset. The freeze fails closed if any component cannot be priced there.

Reason: a yield comparison assembled from figures sampled minutes apart is not a comparison, it is a collage. Rates on Venus move with utilisation between blocks, and a swap quote is only valid for the state it was taken against.

## ADR-036: The blocks-per-year constant is read, never assumed

Decision: supply APR derives from each market's own `supplyRatePerBlock` and the `blocksPerYear` constant read from that market's interest-rate model. The reader refuses to produce a snapshot if it cannot find the constant.

Reason: BSC block time has changed more than once, and Venus markets run more than one interest-rate model version exposing the constant under different names. A hardcoded 3-second assumption would misprice every market by a factor of several while looking entirely plausible.

## ADR-037: A move is priced off the best route, not the obvious one

Decision: every candidate destination is quoted both directly and through an intermediary, and the cheaper route prices the move.

Reason: at 25,000 the direct USDC/FDUSD pool costs 21.32% while the same swap routed through USDT costs -0.037%. Judging the destination on the direct pool would have rejected the best opportunity because of a bad path rather than a bad opportunity, and would have made the benchmark wrong rather than merely strict.

## ADR-038: Fairness tests assert ordering, not absolute bands

Decision: the evaluator fairness harness asserts that competent phrasings cluster together and that wrong reasoning ranks below right reasoning, rather than asserting that each case lands in a band the author guessed in advance.

Reason: the first version of the harness "failed" on four cases that were in fact scored correctly; the author's expected bands were wrong, not the evaluator. Ordering and equivalence are the properties the benchmark actually has to guarantee.

## ADR-039: Reference-agent namespaces are collision-checked, not assumed distinct

Decision: `referenceNamespaceCollisions` verifies that no two reference agents share a deliverable directory, benchmark file, benchmark id, port, wallet directory, password file, password environment variable, identity file, service version, internal identity, endpoint path, or category. It is asserted in the test suite.

Reason: each new agent has surfaced another place the shared plumbing assumed a single one. Health Guard's category was hardcoded in readiness; its service version was published by Range Keeper; its keystore path was used to verify Range Keeper's identity. Enumerating what must be unique is cheaper than rediscovering it per agent.

## ADR-040: A single RPC outage is not an environment failure

Decision: `npm run doctor`, the readiness checks, and the mainnet freeze all try their declared endpoints in order and report which one answered.

Reason: during this build the primary testnet endpoint became unreachable from the developer machine while remaining reachable from the VPS. A single-endpoint check reported the entire environment as failing and a valid provider signature as unverifiable. Fallbacks are only added after they pass the `eth_getLogs` capability probe: the obvious Binance data-seed endpoints answer `eth_chainId` happily and cannot serve the range `verifyJob` needs, which is precisely the Verified Run #1 failure.

## ADR-041: The homepage is an explanation, not a marketplace

Decision recorded, not yet built. Canned's `/` route will be an explanation-first product page for someone who has never heard of ERC-8004, ERC-8183, or IPFS. `/marketplace` becomes discovery and hiring, `/inspection` stays runs and evidence.

The page has to earn the marketplace, in this order: what Canned is, why an agent's own claims are not enough, how Canned hires and tests an agent, what evidence that produces, that failures stay visible, what a human-versus-agent comparison showed, the trust ladder, the four categories, what actually happens during a hire, and only then the protocol names, each introduced by what it means for the reader rather than by its number. It closes on a single call to action into the marketplace.

Constraints: the `design-skill` is the visual and structural authority; https://ignix.bot/ is an information-architecture reference only and must not be copied; no README dumped into a page; no generic three-card feature row; no invented metrics. Every number on it must come from the same derived evidence the marketplace uses.

Reason: the current root is the inspection view, which assumes the reader already knows what an agent marketplace is and why observed work beats claimed capability. That is the wrong first impression for a judge or a liquidity provider arriving cold, and the product's whole argument is one that has to be explained before it can be browsed.

## ADR-042: A value already in the frozen benchmark cannot be leakage

Decision: the human-answer contamination guard excludes any submitted value that appears verbatim in the frozen benchmark, and records which fields were excluded.

Reason: the YieldBench human answered `chosenOption: "USDT"`. A venue ticker must appear in the task, because the task's whole purpose is to present the options. Comparing raw substrings flagged it as leakage and blocked a legitimate run. The secret is which option is correct, not that the option exists. The guard still catches every distinctive phrase the human actually wrote, plus timing, attempt id, evidence hashes, and ground truth.

## ADR-043: Frozen evaluators are not retuned, twice over

Decision: the two YieldBench evaluator gaps found while grading Run #3 — a currency-per-year expression of the yield advantage, and cost erosion named as a trade-off — are published as limitations with a sensitivity figure, and scheduled for evaluator v2.

Reason: this is the second run where reviewing a graded human answer revealed defensible responses the rubric could not read. The precedent set in ADR-031 holds: a rubric frozen before the answer exists is only worth anything if it stays frozen after. The fix belongs to the next version, applied to future runs.

Both runs also show the same failure mode in the rubric design: checks that look for vocabulary rather than meaning. Evaluator v2 for both benchmarks should accept an answer expressed in any equivalent unit, and should test cost, fee, and erosion language against the trade-off dimension.

## ADR-044: Marketplace facts are derived; only product copy is written by hand

Decision: every factual datum on a public page — an agent count, a category count, a trust label, a price, a delivery count, a win, a loss, a run number, a job id, a hash — is produced by `src/marketplace/public-api.mjs` from evidence records. Page files carry sentences, headings, and labels, and nothing else. `tests/productization.test.mjs` scans the four public pages for hand-written figures and fails the build if one appears.

Reason: a marketplace whose selling point is that it publishes observed work cannot have a homepage with a typed number on it. The moment one figure is written into HTML, no reader can tell which of the others were. Keeping the boundary mechanical rather than cultural means the rule survives a rushed edit.

## ADR-045: BNB eligibility is read from the chain, never inferred from the name

Decision: `assessBnbEligibility` resolves the chain id and registry an identity actually points at. Chain 56 or 97 against the known ERC-8004 registry is eligible; any other chain is ineligible and never reaches a public shelf; an identity Canned could not resolve is `BNB_ELIGIBILITY_UNVERIFIED`, held in a separate bucket rather than being called ineligible. Testnet identities are eligible and carry `FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED`.

Reason: an agent named "BNB Yield Optimiser" proves nothing about the chain it lives on, and a marketplace that filtered on names would be trivially gamed. Unresolved is a statement about Canned's own looking, not a verdict on the agent, so it stays distinct from a chain Canned checked and rejected. Whether the published hackathon rules settle testnet against mainnet is not established by the material available, so Canned records the distinction rather than picking an answer.

## ADR-046: A developer owns presentation; Canned owns evidence

Decision: a listing may write nine presentation fields (display name, description, claimed category, capability statement, four URLs, developer name). Every field Canned derives — trust, status, benchmarks, deliveries, prices, wins, losses, track record, origin — is on a forbidden list, and a submission containing any of them is rejected whole rather than filtered. A claimed category is stored with `claimedCategoryIsUnverified: true` and never counts as a verified capability.

Reason: rejecting the submission rather than stripping the field means a developer who tries to set `benchmarkCount` gets an error instead of a silent success that looks like it worked. The claimed category is genuinely useful for browsing and genuinely worthless as evidence, so it is stored as what it is: a claim.

## ADR-047: "List your agent" must not become an SSRF or stored-XSS feature

Decision: ownership is proved by a wallet signature over a challenge that names the product, the agent, the wallet, a nonce, and a five minute expiry. The recovered signer must equal both the challenged address and the owner the registry reports. Challenges are single use, so a captured signature cannot be replayed. All listing text is stripped of control characters and angle brackets and length-capped before storage. All listing URLs must be absolute http(s) on a public host: loopback, RFC1918, link-local including the cloud metadata address, unique-local and link-local IPv6, `.local`/`.internal`, and bare hostnames are refused.

Reason: this is the only place in Canned where a stranger writes data that Canned later renders and may fetch. A signature that is valid but from the wrong wallet is not ownership, which is why the registry read is a separate check rather than an alternative to it. Sanitising on the way in rather than on the way out means the stored record is safe for every consumer, not just the one page that happens to escape correctly. Canned never asks for a private key, a seed phrase, or a wallet password, and a test asserts those words appear on a public page only inside a sentence refusing them.

## ADR-048: Grid Keeper executes swaps, and says so in those words

Decision: Grid Keeper runs software-managed grid levels executed as PancakeSwap swaps through SmartRouter V3 on BSC testnet. It is described everywhere as "agent-managed price-triggered execution", never as native limit orders, and it never produces an order id. One constant, `GRID_EXECUTION_MODEL`, is the only place this is described, and a test fails if an order id appears in any deliverable.

Reason: three mechanisms were checked. PancakeSwap's Gelato-powered limit orders are deprecated and unmaintained. The Infinity `CLLimitOrder` hook exists in source with tests but has no deploy script and is absent from PancakeSwap's own `bsc-testnet.json` manifest, which deploys only the VeCakeExclusive and DynamicFee samples; it is not on chain 97. SmartRouter V3 is deployed there and verified by `eth_getCode`. Deploying the hook ourselves was rejected because it would be our contract, not PancakeSwap's native mechanism, and calling it native would be false. Software-managed levels are what nearly every production grid bot actually does, so naming it accurately costs nothing real and protects the one thing this project sells.

## ADR-049: Grid market data is mainnet, grid execution is testnet

Decision: GridBench and grid price observations use read-only BSC mainnet data, frozen at a named block. Every write, payment and session stays on BSC testnet chain 97.

Reason: BSC testnet PancakeSwap has no coherent price. Its V3 QuoterV2 reverts at every input size tested, and its V2 pairs imply BNB is worth 12.80 USDT against USDT and 15,060 against BUSD, on the same DEX. A benchmark or a track record built on that measures nothing. This follows the precedent already set for RebalanceBench and YieldBench rather than inventing a new rule, and it keeps the prohibition on mainnet writes intact.

## ADR-050: A rolling spend cap is published as its lifetime worst case

Decision: The Leash shows `worstCaseTotalMinor`, the most a permission can spend over the whole session, and chooses a spend period that covers the session so one cap equals one total.

Reason: Altana's spend permission is a cap per rolling period, not a lifetime limit. A cap of 10 per day across a three day session permits 30. Showing the per-period figure as though it were the total would understate the risk by exactly the factor a user most needs to see, and it is the number they are agreeing to when they sign.

## ADR-051: A permission that cannot be proved narrow is reported as unrestricted

Decision: `describeCallPermission` marks a rule `unrestricted` when it omits the contract, omits the method, or names a method signature that cannot be resolved to a selector. It fails closed rather than throwing.

Reason: in Altana's schema an omitted field means ANY, so absence is the dangerous case rather than an empty one. An unparseable signature is the same situation: the chain will enforce something, but The Leash cannot prove it is narrow, and a permission view that quietly implied a tighter scope than reality would be worse than one that admits it does not know. Throwing was the original behaviour and was wrong, because a crashed permission view tells the user nothing at all.

## ADR-052: GridBench ground truth is recomputed, not borrowed from the engine

Decision: the GridBench evaluator computes every answer from the frozen specification with its own arithmetic, and never calls the grid engine it is grading.

Reason: an evaluator that asked the implementation under test what the correct answer was would agree with it by construction, including everywhere both are wrong, and would report that agreement as a passing score. Two independent implementations that agree is evidence; one implementation checked against itself is a tautology. The two currently agree on all fourteen decision scenarios. Writing the scenarios this way also caught two errors in the frozen definition before anything was published: a price of 601 never triggers a 600 buy level, and at the strategy's own cap four buy levels consume it exactly and never exceed it, so the capital guard could not bind.

## ADR-053: One price observation produces at most one action

Decision: `evaluateStrategy` returns a single `nextAction` even when several levels are simultaneously eligible, and publishes the rest as refusals with reasons.

Reason: when price gaps through a range, every level below it becomes eligible at once. Executing them all turns a single market move into a cascade of trades at progressively worse prices, which is the classic way an automated grid destroys a position. Acting once per observation keeps the behaviour bounded and legible, and the unexecuted levels remain armed for the next one.

## ADR-054: The sealed-baseline hire gate applies only where a baseline exists

Decision: `hireReadiness` requires `humanBaselineSealed` only for reference agents whose benchmark actually has a human baseline. Grid Keeper declares `requiresHumanBaseline: false`; Health Guard, Range Keeper and Yield Scout continue to require theirs.

Reason: the seal is a contamination guard, not a quality bar. Hiring an agent before the human has answered the same frozen task would leak the agent's output into the baseline, which is why the gate exists. GridBench has no human baseline by design, because TermiX is already satisfied by three pairs, so the condition would have blocked hiring forever to protect something that will never be created. This is deliberately separate from BENCHMARKED, which still requires a funded ERC-8183 job and was not touched.

## ADR-055: GridBench does not make Grid Keeper BENCHMARKED

Decision: Grid Keeper scored 16/16 on GridBench v1 and remains at LIVE + QUOTE VERIFIED. Reaching BENCHMARKED requires one paid ERC-8183 job, and that authorisation was not given.

Reason: `qualifiesForAgentTrackRecord` requires `hasRealPayment`. Canned's whole argument is that a trust level means an observed, paid, delivered piece of work, so exempting the fourth category to make the shelf look complete would forfeit the only thing the marketplace sells. The category is reported as not first-class, which is the true answer.

## ADR-056: A permission description is idempotent, and errs toward unrestricted

Decision: `describeCallPermission` accepts either the raw Altana shape or one it already produced, so describing twice yields the same result.

Reason: found while verifying the authority boundary. Describing an already-described permission read its absent `to`/`signature` as ANY/ANY and reported a correctly scoped rule as unrestricted. That direction is the safe one, and the fail-closed design worked, but a page that maps over permissions twice must not change what the user is told about their own authority.

## ADR-057: A rejected deliverable is not an observed delivery

Decision: `delivered()` trusts a validation verdict whenever one exists, and falls back to chain state only for runs that carry no verdict at all. The rule has one definition, in `model.mjs`, which `metrics.mjs` imports.

Reason: paid job 835 settled COMPLETED on chain while submitting an empty deliverable, and the old rule read the chain state as proof of delivery. Grid Keeper briefly displayed DELIVERY OBSERVED for a deliverable containing nothing. The rule also existed in two copies that had drifted, exactly as the SSRF blocklist had before ADR-047, and the more generous copy was the one that counted. A marketplace whose entire argument is observed work cannot let a settled transaction stand in for delivered work.

## ADR-058: One paid attempt means one, including when it fails

Decision: paid job 835 failed on an empty deliverable. The defect was fixed in code, no second job was created, and Grid Keeper remains not BENCHMARKED.

Reason: the authorisation was for one paid attempt. Re-running after fixing the bug would have produced a passing record that no authorisation covered, and would have quietly converted a real failure into a success nobody could see. The failure is preserved with its cause, and the fix waits for its own authorisation. Spending 0.001 U for nothing is the honest cost of that.

## ADR-059: The testnet USDT dependency is solved by a swap, not a faucet

Decision: the acquisition path for `0x337610d2…` is wrap tBNB to WBNB, then swap WBNB to USDT on PancakeSwap V2 pair `0x5f52ad4b…`. No faucet is assumed and no substitute token is deployed.

Reason: every alternative was checked and failed. No Canned wallet holds the token; its mint and every faucet-shaped entry point reverts; there is no U/USDT pair at all; and the U to WBNB pair is so thin that the buyer's entire U balance converts to under 0.09 USDT. The WBNB pair, by contrast, holds 226 USDT against 17.5 WBNB with 0.57% impact at the sizes needed. Its price is incoherent against BUSD, which rules it out as market data but not as a way to obtain a token: the execution proof needs the asset to exist in the wallet, and the grid's decisions come from frozen mainnet state.
