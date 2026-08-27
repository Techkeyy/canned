# Environment and readiness

Audit date: 2026-08-27. This is a record of the current machine, not a promise that all tools are configured for deployment.

## Local tool audit

| Tool | Result | Use |
| --- | --- | --- |
| Windows | Microsoft Windows NT 10.0.22621.0 | Host platform |
| PowerShell | 7.6.4 | Shell used for checks |
| Git | 2.53.0.windows.2 | Repository management |
| Node.js | v24.14.0 | Meets Node 22+ requirement |
| npm | 11.9.0 | Package bootstrap |
| Bun | 1.3.7 | Meets current Studio deploy prerequisite |
| Python | 3.14.3 | Optional SDK/examples |
| pip | 25.3 | Optional SDK/examples |
| Docker | 29.7.2 | Available; only needed for container/runtime workflows |
| Docker Compose | v5.3.1 | Available |
| Corepack | 0.34.6 | Available |
| pnpm | shim present, version command not verified in this shell | Required as pnpm 10 for Studio workflow |
| BNB Agent Studio CLI (`bag`) | command shim present but package is broken; `bag --version` fails | Required only when provider-agent or managed deployment work begins; doctor reports the failure |
| AgentCore CLI | not installed | Optional AWS deployment path; doctor reports unavailable |
| `@bnbagent/sdk` | 0.5.4 installed locally and listed in lockfile | ERC-8183 buyer seam and protocol reads |
| Foundry (`forge`, `cast`) | not installed | Only needed for custom Solidity/reference-contract work |
| AWS CLI | not installed | Optional AWS deployment path |

## Network audit

| Network | Chain ID | RPC | Explorer | Status |
| --- | ---: | --- | --- | --- |
| BSC testnet | 97 | `https://bsc-testnet-rpc.publicnode.com` | `https://testnet.bscscan.com` | Read-only `eth_chainId` smoke test passed |
| BSC mainnet | 56 | `https://bsc-dataseed.bnbchain.org` | `https://bscscan.com` | Not used for writes |

The successful initial read-only testnet smoke result was `0x61`, which is decimal 97. One disposable encrypted buyer wallet and one separate disposable encrypted protocol-control provider wallet were created. Directive #3 later broadcast only BSC testnet ERC-8183 transactions: job 669 was created, registered, budgeted, funded, then expired after the provider timed out; the escrow refund and Router expiry reconciliation also succeeded. Directive #4 selected fresh grid candidate identity 1926 and job 673 followed the same testnet-only path before expiring and reconciling without a provider submission. The separate zero-U control job 675 reached `COMPLETED` with a validated deterministic deliverable. No mainnet transaction was broadcast.

## Required soon

- Node 22+ and a working pnpm 10/Corepack path.
- A disposable BSC testnet wallet funded only for the minimum test.
- BSC testnet RPC and explorer access.
- `@bnbagent/studio-cli` when the first provider-agent or deployment path is selected.
- A disposable BSC testnet wallet funded only for the minimum ERC-8183 test.
- Further product benchmark runs only after an explicit release decision; the infrastructure control is not a substitute for an external provider deliverable.
- A reproducible benchmark environment with enough testnet activity to score the selected category.

The local wallet setup is available with `npm run wallet:create`; `npm run wallet:check` records the exact live requirements in `data/state/funding-check.json`. The paid runner requires explicit testnet write enablement and leaves it disabled after a run.

## Recommended later

- Server-side 8004scan credentials.
- PostgreSQL and content-addressed storage/IPFS.
- A testnet pool/lending environment with enough activity for a meaningful benchmark.
- Altana SDK and testnet session flow.

## Not needed now

Mainnet funds, a local BSC node, WSL, custom Solidity contracts, AWS AgentCore, or any private key committed to the repository. Foundry was not installed because the current slice uses the official SDK rather than custom contract work.

## Secret policy

The repository may define names such as `CANNED_8004SCAN_API_KEY`, `CANNED_DATABASE_URL`, `CANNED_STORAGE_TOKEN`, and `CANNED_WALLET_ADDRESS`. It must never contain a private key, wallet keystore, seed phrase, deployment secret, or an API key. BNB Agent Studio's `WALLET_PASSWORD` and provider credentials belong in a local secret manager or ignored environment file only.

Directive #7 also adds an ignored local first-party provider keystore under `data/state/reference-provider-wallets/` with a separate password reference at `data/state/reference-provider-wallet-password.txt`. The generated public address is metadata; the keystore and password reference are not tracked or printed with secret contents. The reference seller remains blocked until the operator explicitly enables the BSC testnet write flag.

## Reproducibility record

Checks performed for this slice:

- version checks for Git, Node, npm, Bun, Python, pip, Docker, Docker Compose, Corepack, and PowerShell;
- executable presence checks for pnpm, `bag`, AgentCore, Foundry, and AWS CLI;
- read-only BSC testnet `eth_chainId` request;
- official SDK package and lockfile verification;
- deterministic test suite and fixture exclusion test;
- live 8004scan inventory and read-only A2A quote probes;
- encrypted disposable wallet creation and SDK-backed funding preflight;
- one disposable wallet creation through the SDK encrypted-keystore path;
- BSC testnet ERC-8183 create/register/set-budget/fund/refund/Router-expiry writes for Directive #3;
- BSC testnet zero-U ERC-8183 control job 675 using a separate provider wallet, official watcher/submit primitives, and a read-only deliverable reconciliation;
- BSC testnet paid ERC-8183 job 695 against ERC-8004 identity 2003 for 0.001 U, reaching `COMPLETED` with an IPFS deliverable and deterministic grading;
- deployed-versus-local hash comparison of every Health Guard module and of the frozen `HealthBench_v1` definition;
- no BSC mainnet transaction.

## Provider RPC configuration

The BNB SDK resolves its BSC testnet RPC from `RPC_URL_BSC_TESTNET` or `RPC_URL`. `CANNED_RPC_URL` is a Canned-side variable and does not reach the SDK. The Health Guard deployment sets `RPC_URL_BSC_TESTNET` plus `BNBAGENT_FALLBACK_RPC_URLS`; without it the SDK default rejects the `eth_getLogs` range that `verifyJob` requires and no funded job can be accepted.
