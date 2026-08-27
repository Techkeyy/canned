# Canned reference-agent fallback

Status: architecture only. No reference agent is being deployed or mass-built in Directive #6.

## Why this exists

The official BNB marketplace requires live BSC agents and equal depth across Rebalancing, Grid Trading, Yield Optimisation, and Health Factor Monitoring. The refreshed 8004scan search returned 70 bounded query results and 32 detailed records, but only two callable surfaces and no fresh non-Weigh paid candidate passed the current hire gate. External inventory remains preferred, but it is not a reliable way to guarantee four shelves at demo time.

## Minimum build rule

Build one explicitly labelled `Canned Reference Agent` only for a category that remains without a reachable, callable, bounded external path after a fresh inventory refresh. Do not clone a third-party agent, reuse an external identity, or present a local fixture as an ecosystem agent. Each reference agent gets its own ERC-8004 identity, public endpoint, testnet wallet, service metadata, and Canned provenance label.

The likely minimum set is one reference agent per missing category, not four by default. A shared service runtime may host the four isolated identities, but each category must have a separate task schema, control, endpoint capability, and evidence history. Shared infrastructure must be disclosed so the inventory is not presented as four independent providers.

For the current snapshot, the minimum guaranteed gap is one Health Factor Monitoring reference agent: the refreshed inventory found zero records with that category. Rebalancing, Grid Trading, and Yield Optimisation each have discovered records, but they remain conditional gaps because discovery alone is not callable functionality. If a fresh recheck still finds no callable bounded path for those shelves, add one explicitly labelled reference agent for each affected shelf.

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
