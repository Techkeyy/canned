# Reference Fleet Foundation

Directive #7 creates one reusable first-party runtime for Canned Reference Agents. It is explicitly separate from the external 8004scan inventory and from the infrastructure control job.

## Runtime contract

Every reference agent has:

- a separate canonical identity string and eventual ERC-8004 registration slot;
- `origin: CANNED_REFERENCE` on candidate metadata, tasks, deliverables, and evidence;
- BSC testnet / chain ID 97 metadata;
- a category-specific task schema and independent control;
- HTTP health and readiness surfaces;
- a worker heartbeat that is not confused with endpoint liveness;
- a bounded quote and an explicit ERC-8183 activation path where configured;
- content-addressed deliverables and preserved failure records.

The shared runtime does not share category logic. It owns lifecycle, evidence, readiness, and protocol plumbing; task modules own protocol-specific reads and deterministic output.

## Fleet state

Health Factor Monitoring is implemented as `Canned Health Guard`. It is published in the Marketplace Alpha shelf and marked first-party. Its provider wallet, ERC-8004 registration, fresh signed quote, and live paid delivery are separate release gates.

Yield, Rebalancing, and Grid each have a concrete versioned task specification but remain `planned`; no planned module is treated as reachable, callable, hireable, or tested.

## Seller lifecycle

The live seller helper follows the SDK’s proven pattern:

`fundedJobWatcher` detects a funded job → `verifyJob` checks assignment, budget, quote, state, and deadline → the category module reads authoritative data → the runtime creates canonical output → `ERC8183JobOps.submitResult` stores and submits the deliverable manifest.

`notify_funded` alone is never treated as delivery evidence. A seller failure is persisted and scored using the same failure vocabulary as an external provider.

## Safe boundaries

The default is read-only. The Health Factor agent does not move capital. A future write-capable category requires an Altana session or equivalent bounded authority with exact calls, token cap, expiry, kill switch, and revocation. No browser contains a private key or session secret.

## Sources checked

- [BNB Agent Studio CLI](https://docs.bnbchain.org/developer-kit/bnbchain-studio/cli-reference/)
- [BNB Agent Studio quickstart](https://docs.bnbchain.org/developer-kit/bnbchain-studio/quickstart/)
- [BNB Agent SDK architecture](https://docs.bnbchain.org/developer-kit/bnbagent-sdk/architecture/)
- [Venus liquidation guide](https://docs-v4.venus.io/guides/liquidation)
- [Venus agent skills](https://github.com/VenusProtocol/venus-agent-skills)
