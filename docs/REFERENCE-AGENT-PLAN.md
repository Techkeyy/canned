# Canned reference-agent fallback

Status: Directive #7 foundation implemented. Health Factor Monitoring is the first reference module. No mainnet write, live identity registration, Altana grant, or paid job was performed by this change.

## Why this exists

The official BNB marketplace requires live BSC agents and equal depth across Rebalancing, Grid Trading, Yield Optimisation, and Health Factor Monitoring. The refreshed 8004scan search returned 70 bounded query results and 32 detailed records, but only two callable surfaces and no fresh non-Weigh paid candidate passed the current hire gate. External inventory remains preferred, but it is not a reliable way to guarantee four shelves at demo time.

## Minimum build rule

Build one explicitly labelled `Canned Reference Agent` only for a category that remains without a reachable, callable, bounded external path after a fresh inventory refresh. Do not clone a third-party agent, reuse an external identity, or present a local fixture as an ecosystem agent. Each reference agent gets its own ERC-8004 identity, public endpoint, testnet wallet, service metadata, and Canned provenance label.

The reusable fleet catalog now specifies one isolated identity and task contract for each required category. Only Health Factor is published as implemented; Yield, Rebalancing, and Grid remain planned and are not counted as live inventory. A shared service runtime may host the four isolated identities, but each category must have a separate task schema, control, endpoint capability, and evidence history. Shared infrastructure must be disclosed so the inventory is not presented as four independent providers.

For the current snapshot, the minimum guaranteed gap is one Health Factor Monitoring reference agent: the refreshed inventory found zero records with that category. Rebalancing, Grid Trading, and Yield Optimisation each have discovered records, but they remain conditional gaps because discovery alone is not callable functionality. The fleet catalog records the concrete future specs without presenting them as deployed agents.

## Category contracts

| Category | Smallest defensible first task | Independent control | Write boundary |
| --- | --- | --- | --- |
| Rebalancing | Read-only PancakeSwap V3 range recommendation against a fixed range | Hold the declared range | No position write until scoped authority is audited |
| Grid Trading | Fixed ladder simulation or bounded testnet execution | Static grid with identical limits | Explicit cap, expiry, and allowlisted trading calls |
| Yield Optimisation | Compare declared venues and return a route recommendation | Fixed baseline venue | Read-only first; routing only after venue and cap review |
| Health Factor Monitoring | Observe a declared Venus-style position and alert on a threshold | No-monitor baseline | Alert-only first; protection action is a later release |

Each deliverable must be structured, content-addressed, and paired with a deterministic control. A reference agent may establish functionality and data-quality evidence, but it cannot be counted as third-party diversity or as independent external evidence.

## Release gates

1. Fresh BSC testnet identity and endpoint are reachable.
2. The endpoint responds to the declared task and returns the documented schema.
3. The task has a control, cost boundary, observation window, and timeout behavior.
4. Hire flow shows permissions and caps before any write.
5. At least one testnet run is persisted with raw output and a fresh precommit.
6. The UI labels the record `Canned Reference Agent` and keeps third-party and reference histories separate.

## Implemented seams

- `src/reference/constants.mjs` is the explicit `CANNED_REFERENCE` catalog and keeps the four category identities separate from third-party discovery.
- `src/reference/foundation.mjs` provides common health, readiness, worker heartbeat, negotiation, and content-hash behavior.
- `src/reference/erc8183-seller.mjs` uses the installed official SDK’s `fundedJobWatcher` and `ERC8183JobOps.submitResult` path. It refuses to construct without a provider wallet and never enables writes by default.
- `src/reference/venus.mjs` requires BSC testnet and authoritative Venus data. Core reads use `Comptroller.getAccountLiquidity`; isolated pools require a configured pool-specific read plan.
- `src/reference/health-factor.mjs` returns recommendation-only output, deterministic change data, and an uncontaminated manual-baseline packet.

The reference provider wallet helper writes a new local encrypted keystore only when the operator explicitly runs `npm run reference:wallet:create`. Its password reference is ignored local state. The live seller requires `CANNED_REFERENCE_ALLOW_TESTNET_WRITES=true`, a configured provider wallet, and a separate operator decision.
