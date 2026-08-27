# Public Health Guard runbook

This is the deployment boundary for the first Canned Reference Agent. It is not a paid-run instruction and it does not authorize mainnet.

## Required public surface

Deploy `npm run reference:public` behind a durable HTTPS URL whose base path ends in `/erc8183`. The service must expose:

- `/health`, `/readiness`, `/status`, `/metadata`, and `/.well-known/agent.json`;
- `POST /negotiate` with a fresh provider-signed quote;
- `/job/{jobId}` and `/job/{jobId}/response` for ERC-8183 inspection;
- a funded-job watcher only when the operator has explicitly enabled testnet fulfillment.

The URL must have public DNS/TLS and must not be localhost, a private address, a temporary local filesystem endpoint, or a loopback proxy presented as production.

## Durable evidence

Set `STORAGE_API_KEY` only in the deployment secret manager or process environment. The installed BNB SDK maps this variable to a Pinata-compatible JWT for `IPFSStorageProvider`; no `PINATA_JWT` variable is required. The service refuses to start in public mode without it. Do not put the key in Git, a browser bundle, a screenshot, or a command copied into a ticket. Use `npm run reference:storage:check` from the server environment for the harmless upload/retrieval/CID test.

## Readiness then identity

Run `npm run reference:public:check` against the deployed URL. It verifies public HTTPS, chain 97, U, public provenance, worker/watcher liveness, storage mode, signed quote, quote expiry, price, and signer/provider match. Pair it with the server-side `npm run reference:storage:check` upload/retrieval test. Only after both pass should an operator use `npm run reference:identity:register` with both explicit confirmation flags. Registration is a sponsored BSC Testnet ERC-8004 write; the script never accepts a local URL and repeats public readiness immediately before the write.

The durable VPS package is in `deploy/`: `canned-health-guard.service`, `docker-compose.health-guard.yml`, reverse-proxy templates, `health-guard.env.example`, and the read-only `scripts/inspect-vps-readonly.sh` inventory check. Use an existing dedicated DNS name only; do not invent a hostname or overwrite another service.

After registration, independently check the onchain identity and 8004scan indexing. The marketplace record should show both `onchain_registered` and the separate indexer state.

## HealthBench contamination boundary

Freeze `HealthBench_v1` first. Open `/baseline/health-factor`, start the timer, read only the displayed task and raw source packet, and submit the human response. Do not request an agent task, evaluator, ground truth, classification, or recommendation before submitting. No agent execution has been authorized by this foundation checkpoint.

## Future bounded action

The first Health Guard release is read-only. If Altana is later added, use a separate registered session and separate action wallet with a short expiry, narrow allowlist, and small cap. Candidate Venus actions are limited to a review-approved repay or repay-on-behalf/collateral top-up seam. Withdrawals, arbitrary calldata, unlimited approvals, and unattended continuous execution are out of scope.
