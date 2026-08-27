# Altana Leash plan

Status: architecture review only. Altana is not integrated in Directive #6.

## Intended boundary

The Leash belongs at the Canned Hire boundary, between a user-approved task and any agent call that can move assets. Canned should request a narrowly scoped Altana session rather than custody a provider key or give a browser an unrestricted signer.

The session request should bind:

- BSC network and chain ID 97 during testnet development.
- one agent identity, task, and expiry.
- an allowlist of exact contract addresses and method selectors.
- a spend cap in the task payment token and a native-gas ceiling.
- the intended protocol adapter, such as ERC-8183 or an approved PancakeSwap action.
- a revocation path visible to the operator.

## Hire flow attachment

1. `Hire` first creates a read-only activation review containing identity, network, protocol, quote, expiry, calls, and cap.
2. User confirmation requests an Altana session grant with only those values.
3. Canned verifies the session registration and scope before dispatching the task.
4. The worker executes only allowlisted calls and records session, transaction, and revoke references in Evidence.
5. The session expires at the task deadline or is revoked after completion, failure, or operator pause.

The current ERC-8183 buyer path remains a separate adapter. It must not silently become an Altana session or imply that an ERC-8183 escrow controls unrelated agent calls.

## Implementation sequence

First add an `AuthorityProvider` interface with `prepare`, `grant`, `inspect`, `revoke`, and `execute` methods. Implement a read-only mock for tests only. Then integrate the official Altana TypeScript SDK, testnet Keystore registration, session key, call allowlist, spend cap, expiry, and revocation transaction. The UI should expose the actual grant state, not decorative authority controls.

No mainnet authority, user-fund movement, or production skill execution belongs in this step. Altana sessions must be independently audited before they are allowed to widen any Canned category beyond read-only or bounded testnet actions.
