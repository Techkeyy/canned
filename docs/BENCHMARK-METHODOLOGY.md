# Benchmark methodology

The benchmark is part of the product. A score without a task, control, raw output, and failure history is not an evidence record.

## Precommit rule

Before an agent run starts, Canned records a canonical manifest containing:

- benchmark name and version;
- category and exact task instructions;
- agent identity reference, endpoint, and protocol;
- control definition and version;
- initial state and inputs hash;
- provider-delivery deadline, separate benchmark observation window, limits, and evaluator version;
- client, provider, evaluator, and optional ERC-8183 job references;
- authority and payment scope;
- artifact retention and redaction policy.

The manifest is hashed before the outcome is known. The current slice stores the canonical bytes and SHA-256/Keccak-256 hashes in the local evidence store. A hash is offchain content-addressed evidence until a protocol job, deliverable, or attestation commits it onchain. Any later change creates a new benchmark or run version. A hash proves integrity of the committed bytes, not the truth of their contents.

Before funding, Canned records a fresh candidate readiness checklist: reachable card and quote surface, verified provider signature and identity, quote expiry lead time, documented ERC-8183 notification/schema, declared task capability, and supported protocol version. Documented health or recent-activity signals are recorded when available but are not treated as a delivery guarantee. A provider with a recent paid timeout is placed on a temporary cooldown; two independent providers failing after accepted notification without submission activate a systemic integration guard.

## Run lifecycle

1. `created`: manifest exists and has a content hash.
2. `funded`: an ERC-8183 job or other declared payment is funded, if required.
3. `running`: the agent and control are executing or being observed.
4. `submitted`: outputs and the deliverable/reference have been recorded.
5. Terminal classification: `completed`, `rejected`, `timeout`, `error`, `insufficient_data`, or `expired`.

Canned benchmark states and ERC-8183 contract states are separate. The protocol adapter recognizes `Open`, `Funded`, `Submitted`, `Completed`, `Rejected`, and `Expired`; a local timeout or transport error never becomes an onchain expiry without a confirmed contract read.

The ERC-8183 contract state is kept separate and mapped explicitly. A local `timeout` is not automatically an onchain `Expired`; it becomes that only when the contract state confirms expiry.

## Control design

The control is declared before execution, uses the same input and market observation window, and applies the same measurement rules. Examples:

- Rebalancing: fixed-range LP position with no rebalance.
- Grid Trading: a predeclared static grid with no adaptive changes.
- Yield Optimisation: a fixed baseline pool or strategy with the same starting capital and fee assumptions.
- Health Factor Monitoring: the same position with no alert or protective action, measured for warning timeliness and avoidable risk, not fabricated liquidation savings.

Controls must account for gas, fees, execution failures, slippage, and missing data. A control may be impossible or unsafe for a particular task; in that case the run is not benchmarkable and is labeled accordingly.

## ERC-8183 protocol control

The infrastructure control is not a product benchmark. It uses a separate disposable provider wallet and the official BNB Agent SDK primitives: `fundedJobWatcher` detects `FUNDED`, and `ERC8183JobOps.submitResult` stores a deliverable and submits its manifest hash onchain. The buyer runs the normal create, register, budget, fund, state-observation, URL-resolution, and validation path. The control uses a zero-U job budget and a deterministic integer sum, so it tests lifecycle plumbing without capital movement or LLM behavior.

The control is precommitted as `INFRASTRUCTURE_PROTOCOL_CONTROL` before funding and is excluded by construction from benchmark metrics, provider cooldown/systemic-failure history, public “jobs paid for and graded,” marketplace inventory, and TermiX evidence. A readiness score is preflight/discovery confidence only; it is not delivery success. Control reports retain both transient lookup failures and later read-only reconciliation results.

## Deterministic evaluation

The evaluator computes category-specific metrics from raw, versioned inputs. Each metric has a definition, unit, direction, missing-data rule, and weight. A missing required field produces `insufficient_data`, not a favorable default.

The LLM may summarize a completed evidence record for readability. It cannot assign the score, change the task, approve a payment, widen an authority scope, or hide an error. Human review for a TermiX report is stored with reviewer, rubric, timestamp, and raw note.

## RebalanceBench v1 proposal

Target category: Rebalancing.

Task: manage one PancakeSwap V3 LP position over a fixed testnet observation window and keep the position within declared risk and slippage limits. The agent must declare the proposed range and any rebalance transaction before execution.

Control: leave the same initial position unchanged for the same window.

Primary metrics: time in range, realized fees, gas and agent cost, transaction success rate, slippage, price impact, and inventory drift.

Required labels: testnet, pool, initial capital, range, window, token decimals, oracle/price source, fee assumptions, and whether the run ended with enough observations to score.

No claim of profitability is allowed from a single testnet run. The benchmark is initially an integration and evidence test; statistical confidence requires repeated runs and meaningful liquidity.

## Evidence record

For each run retain:

- canonical task manifest and hash;
- input and initial-state snapshot;
- agent output and control output;
- transaction receipts and protocol state reads;
- metric inputs and evaluator output;
- endpoint health and timestamps;
- failure, retry, timeout, and rejection details;
- optional ERC-8183 job and deliverable references;
- optional Altana grant, execution, and revoke references;
- a human-readable summary generated from the record, never instead of it.

The current implementation writes separate agent and control artifacts, run state, protocol-job state, candidate readiness/cooldown state, and public-metric projections. A submitted SDK deliverable is stored before parsing and must match its job ID, manifest hash, response schema, and expected benchmark fields. Fixture runs and infrastructure smoke tests are persisted for inspection but are excluded from public marketplace metrics. Hashes prove integrity of the committed bytes after the commitment. They do not prove that the bytes describe reality, that an endpoint was honest, or that a strategy is safe or profitable. The UI must state this limitation next to evidence links.

## Ranking rules

Rankings use all eligible terminal outcomes, including failures and timeouts, and show sample size and benchmark version. Runs with `insufficient_data` are visible but excluded from a metric that cannot be computed. No score is published without a minimum sample threshold, and the threshold is part of the ranking definition.

## TermiX Agent Advantage Report

The report will be generated from run records and include at least three paired real tasks:

| Field | Required evidence |
| --- | --- |
| Task | exact task, date, agent identity, and control description |
| Time | elapsed time for agent and control |
| Cost | network, protocol, agent, and human-operation costs where measurable |
| Quality | fixed rubric, raw outputs, evaluator version, and human notes if used |
| Outcome | completed, rejected, timeout, error, or insufficient data |
| Attachment | links or hashes for actual outputs, not only a summary |

At least one paired task must be in trading, stock, or security. The report will not be drafted from synthetic fixtures.

## Minimum acceptance criteria for the first slice

- The same benchmark manifest can reproduce an agent run and a control run.
- A failed, rejected, timeout, or insufficient-data run remains queryable.
- The final record links to raw outputs and a deterministic evaluator version.
- The app explains pending, confirmed, rejected, and expired chain state.
- No private key or API credential is required by the public UI.
- A fixture mode can exercise the entire UI offline and is labeled as fixture data.

Milestone 2 and Directive #3 verified the deterministic, fixture, and ERC-8183 buyer lifecycle portions of this list. Directive #4 added fresh readiness/cooldown selection, a second bounded paid timeout (job 673), and infrastructure control job 675. Job 675 verifies the controlled watcher/submit/deliverable path but is not a product run; Verified Run #1 remains open.

## HealthBench v1 deterministic evaluator

Evaluator version `health-factor-deterministic-v1`. No LLM participates in scoring.

Ground truth is computed from the frozen snapshot alone, with no live read and no prior answer:

- authoritative fields from `Comptroller.getAccountLiquidity`: error code, liquidity, shortfall, whether the position was liquidatable at the snapshot;
- a derived market-level reconstruction of collateral and debt, published with an explicit consistency verdict;
- the change baseline, which for v1 is `not_enough_data` because no prior snapshot is bound;
- the bounded-action truth, which for a position with zero shortfall is `continue_monitoring_no_intervention`.

Scoring uses the five precommitted `expectedOutputSchema` fields, 20 points each. Each dimension awards 4 points for being answered rather than declined, plus fixed points for named checks. Every check is satisfiable from a structured deliverable field **or** from the equivalent prose statement, so the rubric does not favour a machine-readable format. Checks prefixed `no_` are unsupported-claim guards and are reported separately.

The same ground truth object, the same rubric, and the same evaluator version are applied to the human baseline and to the agent deliverable. Both scores are content-addressed.

## Agent Advantage pair

A pair records time, cost, and quality on both sides and never nets them into a single number. Cost is reported as service fee plus buyer gas on the agent side and as declared operator cost on the human side. The comparison names the faster responder and the higher-quality responder independently, so a faster-but-worse agent is visible as such. `agentAdvantage` is true only when the agent scores higher **and** is not slower.

## Verified Run #1 result

Job 695, ERC-8004 identity `97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2003`, reference block 127521666.

| Metric | Without agent | With agent |
| --- | ---: | ---: |
| Time | 306,762 ms | 861,284 ms |
| Cost | 0 U, no gas | 0.001 U + 0.000060257 tBNB |
| Quality | 8 / 100 | 92 / 100 |

The agent answered every dimension and was correct about liquidation proximity, the absent change baseline, and the bounded action. It lost 8 points because its deliverable never names which asset is collateral and which is borrowed. The human declined three of five dimensions and asserted the position was "close" to liquidation, which the frozen snapshot does not support.

The agent was slower. Its elapsed time includes an RPC misconfiguration that stopped the Health Guard from verifying the funded job, and the operator intervention that fixed it. The pair is therefore recorded as a **loss** on the combined advantage criterion and a decisive quality win, and it counts as one loss in public metrics.

## RebalanceBench v1

Frozen 2026-08-27. Evaluator `range-keeper-deterministic-v1`. No LLM participates in scoring.

| Field | Value |
| --- | --- |
| Venue | PancakeSwap V3 |
| Market data | BSC mainnet, read-only |
| Payment and agent execution | BSC testnet, chain 97 |
| Pool | `0x172fcD41E0913e95784454622d1c3724f546f849` (USDT/WBNB, 0.01%, tick spacing 1) |
| Position | NFT #7261944, ticks -65724 to -65524, width 200 |
| Reference block | 118445030 |
| Precommit SHA-256 | `sha256:4781d6200eab71253e7897f11705ae9ae531b0f8bb2cad625168bdc45c0fd8fc` |
| Precommit Keccak-256 | `0xaa61da7a3bca87bb8b06080036215631c6df0bf58e361ed7ec6ec9dd10c28774` |

Selection was declared before anything was read: the chain head minus 30 blocks for confirmation depth; WBNB/USDT at the fee tier with the greatest in-range liquidity and the largest observation cardinality; the most recently minted position in that pool with non-zero liquidity at the freeze block. The scenario was taken as it came, not searched for.

### Scored dimensions

Six dimensions, exactly the precommitted `expectedOutputSchema` fields, 20 points each: `positionStatus`, `edgeProximity`, `marketMovement`, `rebalanceDecision`, `proposedRange`, `risksAndTradeoffs`. Each awards 4 points for being answered rather than declined plus fixed points for named checks, and every check is satisfiable from a structured deliverable field **or** from the equivalent prose.

### Quote-convention neutrality

This pool is quoted USDT-per-WBNB, and a *rising tick* is a *falling* USDT-per-WBNB price. The nearer bound is the lower tick, which is the higher USDT price. So "up" and "down", and "lower bound" and "upper bound", are both correct English for the same fact depending on which way a responder quotes the pair.

Scoring direction or edge words alone would therefore mark a correct answer wrong. Two checks are built to avoid it:

- movement is scored against the position's own range (toward or away from the nearer bound, and how large the move is relative to the range width), which reads the same in either convention;
- the nearer bound is scored on being identified unambiguously — by its tick, by its price, or by a single self-consistent edge word — rather than on a word whose meaning depends on the quote.

Matching is negation-aware, so "not close to an edge" no longer satisfies a search for "close to". Declining to propose a range is scored as correct when holding is correct, because it is.

### Fairness check

Before any human saw the task, the rubric was tested against four responders: the agent's own deliverable, a competent answer written in the tick frame, the same answer written in the inverted price frame, and an over-reacting answer. The agent and both competent human answers score 100; the over-reacting answer loses the decision and proximity points; an all-declined answer scores 0. A person who understands the position can match the agent on quality, which is what makes the comparison worth running.

## Range Keeper track record

Methodology `range-keeper-track-record-v1`. A decision is recorded when it is made, with its reference block, position state, recommended action, recommended range, and observation horizon. Its `outcome` stays null until a *later independent read* of the same pool exists; a decision is never scored by the read that produced it.

Settlement measures what is actually measurable: whether the position, or the recommended replacement range, still contained the price at the follow-up block. That is range retention, not profit — fees earned, gas paid, and impermanent loss are not settled. Below five settled decisions no rate is published at all and the summary says so.

## Verified Run #2 result

Job 700, ERC-8004 identity `97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2005`, PancakeSwap V3 pool `0x172fcD41E0913e95784454622d1c3724f546f849`, position NFT 7261944, frozen mainnet block 118445030.

| Metric | Without agent | With Range Keeper |
| --- | ---: | ---: |
| Time | 152,528 ms | 69,923 ms |
| Cost | 0 U, no gas | 0.001 U + 0.000060257 tBNB |
| Quality | 30 / 100 | 100 / 100 |

`agentAdvantage = true`. Range Keeper was faster by 82.6 seconds and scored 70 points higher.

The correct answer was **HOLD**: the position sat 70 ticks from the nearer bound of a 200-tick range, and the hour's drift was 7.5% of the range width and moving *away* from that bound. Range Keeper said hold and proposed no replacement range. The human said they would rebalance, called a small move "decently big", and answered "none" to the risks question.

### Disclosed evaluator limitations

Reviewing the graded human answer afterwards, two of the six dimensions were scored 0 where the answer was arguably correct:

- `positionStatus: "yes it is"` — a correct answer to the form's question "Is the position still in range?", but the frozen evaluator matches phrases such as "in range" rather than a bare affirmative, so `range_state_correct` did not fire.
- `edgeProximity: "around 5 USDT per wbnb"` — numerically right; the true distance to the nearer bound is 4.986 USDT. The evaluator's `nearest_bound_identified` check looks for the bound's tick or price, not the distance to it, so it did not fire.

**These were not corrected retroactively.** The evaluator was frozen before the human answered, and changing scoring after seeing an answer would invalidate the comparison. The published score is what the frozen evaluator produced.

As a sensitivity check, crediting both checks would move the human from 36/120 (30.0) to 56/120 (46.7), against the agent's 120/120. The result direction is unchanged. Both gaps are recorded as work for evaluator v2, which would apply to future runs only.

The human's substantive errors are independent of those gaps: recommending a rebalance where holding was correct, mischaracterising the size of the move, and claiming there were no risks.
