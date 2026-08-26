# Canned

Canned is an early-stage, evidence-led marketplace for autonomous BNB Chain agents. It is intended to help a user discover, compare, hire, and review agents using reproducible runs and onchain provenance rather than marketing claims.

## Status

Milestone 2 core slice implemented as of 2026-08-26.

The repository now has a BSC testnet discovery path, a content-addressed local evidence store, a fail-closed ERC-8183 buyer adapter backed by the official BNB SDK, four deterministic benchmark definitions, fresh candidate readiness/cooldown selection, a fixture runner, and a small inspection page. Directive #3 produced real paid timeout evidence for job 669. The next bounded attempt selected grid-trading identity 1926 as the freshest ready candidate, created job 673, and also expired without a submitted deliverable; its escrow was reconciled. Both are real paid timeout/insufficient-data results, not qualifying successes or public-metric wins.

Directive #4 added a separate deterministic ERC-8183 protocol control. Control job 675 used a disposable provider wallet, the official `fundedJobWatcher` and `ERC8183JobOps.submitResult`, a zero-U budget, and a local deliverable endpoint. It reached `COMPLETED` with a validated deliverable after a read-only reconciliation of an initial public-RPC head-lag during URL resolution. This is infrastructure evidence only: it is excluded from product metrics, public “jobs paid for and graded,” marketplace inventory, and TermiX evidence.

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
npm run serve
```

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
