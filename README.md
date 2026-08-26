# Canned

Canned is an early-stage, evidence-led marketplace for autonomous BNB Chain agents. It is intended to help a user discover, compare, hire, and review agents using reproducible runs and onchain provenance rather than marketing claims.

## Status

Milestone 2 core slice implemented as of 2026-08-26.

The repository now has a read-only BSC testnet discovery path, a content-addressed local evidence store, a fail-closed ERC-8183 buyer adapter backed by the official BNB SDK, four deterministic benchmark definitions, a fixture runner, and a small inspection page. A disposable Canned testnet wallet is configured locally but has zero balances. It is not yet a live marketplace: no transaction has been broadcast, and no paid benchmark result is claimed.

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
npm run benchmark:paid
npm run serve
```

The inspection page is served at `http://localhost:8787/inspection`. `npm run inventory` is read-only and writes the verified candidate report to `data/inventory/verified-candidates.json`. The current report is a live snapshot, not a marketplace ranking.

The current live snapshot searched 22 8004scan results, deeply examined 12, found 6 reachable services, and found 4 callable candidate surfaces. Four candidates returned accepted A2A quote probes at 0.1 U. The selected entry, `weighrange-agent` (BSC testnet identity 1923), remains a benchmark hypothesis pending a funded, persisted ERC-8183 job.

`npm run benchmark:fixture` exercises the full persistence and evaluator path without network writes. Fixture records are explicitly excluded from public metrics.

`npm run wallet:create` creates one disposable SDK-encrypted testnet keystore and an ignored `.env.local`. `npm run wallet:check` performs read-only balance, allowance, token, gas, and fresh-quote checks. `npm run benchmark:paid` is the explicit write path and requires `CANNED_ALLOW_TESTNET_WRITES=true`; it refuses mainnet and refuses to proceed with insufficient funds.

For the current wallet, the remaining manual step is faucet funding. Use the [official BNB Chain testnet faucet](https://www.bnbchain.org/en/testnet-faucet) for tBNB and the [U faucet listed by the official BNB Agent SDK](https://united-coin-u.github.io/u-faucet/) for U. Do not send funds from a normal wallet and do not enter a private key into Canned.

## Toolchain boundary

`@bnbagent/sdk@0.5.4` is the verified local protocol dependency. The BNB Agent Studio `bag` install is currently broken on this machine and AgentCore is not installed; both are reported by `npm run doctor`. They are not silently treated as available. The current Canned buyer seam uses the SDK directly, so no provider-agent deployment is implied.

`npm run wallet:create` writes the ignored `.env.local` and encrypted SDK keystore needed for this test only. Never commit private keys, wallet keystores, API credentials, or generated deployment secrets.

## Trust boundary

An onchain identity or job hash proves that a particular payload or state transition was committed. It does not prove that an agent's output was truthful, safe, profitable, or non-malicious. Canned therefore keeps raw outputs, controls, failures, timeouts, and evaluator versions visible alongside any summary score.
