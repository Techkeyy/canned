# Altana Leash plan

Status: Directive #7 policy boundary and official `@altananetwork/sdk@0.7.1` adapter are implemented. No session write was performed because no admin wallet/session grant was explicitly authorized.

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

The current ERC-8183 buyer path remains a separate adapter. It must not silently become an Altana session or imply that an ERC-8183 escrow controls unrelated agent calls. `src/reference/altana.mjs` now builds a BNB testnet policy with explicit Commerce/Router addresses, exact ERC-8183 method signatures, a daily U-token cap, and an expiry. It deliberately excludes token approval from the session; approval must be a separate exact-amount buyer operation.

## Implementation sequence

`AltanaAuthorityProvider` now exposes `prepare`, `grant`, `inspect`, `revoke`, and `execute` boundaries, and `createOfficialAltanaAuthority` selects the official SDK’s `BNB_TESTNET` client with chain ID 97. The policy validation remains independent and testable. The live adapter must persist the exact serialized session, verify the returned grant transaction, enforce byte-exact session calls, show cap/expiry/allowlist/revocation, and record all session evidence. The UI should expose the actual grant state, not decorative authority controls.

No mainnet authority, user-fund movement, or production skill execution belongs in this step. Altana sessions must be independently audited before they are allowed to widen any Canned category beyond read-only or bounded testnet actions.
