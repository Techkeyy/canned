# Canned

Canned is an early-stage, evidence-led marketplace for autonomous BNB Chain agents. It is intended to help a user discover, compare, hire, and review agents using reproducible runs and onchain provenance rather than marketing claims.

## Status

Canned Verified Run #1 completed on 2026-08-27.

The repository now has a BSC testnet discovery path, a content-addressed local evidence store, a fail-closed ERC-8183 buyer adapter backed by the official BNB SDK, four deterministic benchmark definitions, fresh candidate readiness/cooldown selection, a fixture runner, and a small inspection page. Directive #3 produced real paid timeout evidence for job 669. The next bounded attempt selected grid-trading identity 1926 as the freshest ready candidate, created job 673, and also expired without a submitted deliverable; its escrow was reconciled. Both are real paid timeout/insufficient-data results, not qualifying successes or public-metric wins.

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

This is TermiX Candidate #1. The track is not satisfied: it needs three qualifying pairs and at least one trading, stock, or security task, and Health Factor Monitoring is none of those.

The reference agent is first-party. It is labelled `CANNED_REFERENCE`, it is excluded from third-party agent diversity, and it received no leniency for belonging to Canned.

## Project documents

- [Project understanding](docs/PROJECT.md)
- [Hackathon requirements matrix](docs/HACKATHON-REQUIREMENTS.md)
- [Initial architecture](docs/ARCHITECTURE.md)
- [Benchmark methodology](docs/BENCHMARK-METHODOLOGY.md)
- [Architecture decisions](docs/DECISIONS.md)
- [Environment and readiness](docs/ENVIRONMENT.md)

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
npm run serve
```

The paired with/without comparison is at `http://localhost:8787/inspection#advantage`, with the exact human answer, the exact agent deliverable, per-dimension scoring, the ERC-8183 transactions, the ERC-8004 identity, and the IPFS deliverable all inspectable.

`npm run health:hire` is the paid path for the reference agent and requires `CANNED_ALLOW_TESTNET_WRITES=true`. It refuses to spend unless the frozen benchmark still matches its own precommit, the human baseline is sealed and hash-intact, the live worker and watcher are alive, storage is IPFS, the ERC-8004 owner and provider match onchain, a fresh provider-signed quote verifies, and the provider payload contains no trace of the human answer. `npm run health:reconcile` observes a late-but-in-deadline submission and settles it without erasing the original timeout. `npm run health:grade` computes ground truth from the frozen snapshot and scores both sides with one rubric.

The inspection page is served at `http://localhost:8787/inspection`. `npm run inventory` is read-only and writes the verified candidate report to `data/inventory/verified-candidates.json`. The current report is a live snapshot, not a marketplace ranking.

The fresh candidate workflow persists a readiness matrix and provider history. It does not immediately retry a provider after a paid timeout, and it stops before funding when no remaining candidate passes the required checks. The selected `weighladder-agent` (BSC testnet identity 1926) acknowledged job 673 but did not produce an onchain submission before its bounded deadline, so it is now cooled down and remains unqualified.

Public metadata correlates identities 1923, 1925, and 1926 as `SAME_IMPLEMENTATION_FAMILY_LIKELY`; this does not prove a common operator or repository.

`npm run benchmark:fixture` exercises the full persistence and evaluator path without network writes. Fixture records are explicitly excluded from public metrics.

`npm run wallet:create` creates one disposable SDK-encrypted testnet keystore and an ignored `.env.local`. `npm run wallet:check` performs read-only balance, allowance, token, gas, and selected-candidate checks. `npm run inventory` refreshes the public candidate matrix and quote/readiness evidence. `npm run benchmark:paid` is the explicit write path and requires `CANNED_ALLOW_TESTNET_WRITES=true`; it refuses mainnet, cooled-down providers, systemic repeated failures, and insufficient funds.

The paid test used only BSC testnet. Its final run record, protocol events, timeout, control, evidence hashes, refund, and Router expiry reconciliation are available through the inspection route and local content-addressed state. Keep the wallet write flag disabled after testing. Do not send funds from a normal wallet and do not enter a private key into Canned.

## Toolchain boundary

`@bnbagent/sdk@0.5.4` is the verified local protocol dependency. The BNB Agent Studio `bag` install is currently broken on this machine and AgentCore is not installed; both are reported by `npm run doctor`. They are not silently treated as available. The current Canned buyer seam and the protocol control use the SDK directly, so no managed provider-agent deployment is implied.

`npm run wallet:create` writes the ignored `.env.local` and encrypted SDK keystore needed for this test only. Never commit private keys, wallet keystores, API credentials, or generated deployment secrets.

## Trust boundary

An onchain identity or job hash proves that a particular payload or state transition was committed. It does not prove that an agent's output was truthful, safe, profitable, or non-malicious. Canned therefore keeps raw outputs, controls, failures, timeouts, and evaluator versions visible alongside any summary score.
