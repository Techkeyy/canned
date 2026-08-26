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
