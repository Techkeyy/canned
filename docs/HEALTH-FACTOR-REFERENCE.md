# Canned Health Guard

## HealthBench v1 release boundary

Directive #8 freezes one real, reproducible Venus Core position before any agent run. The position is read at a pinned BSC Testnet block and the raw snapshot is sealed into `HealthBench_v1`. The benchmark wallet is disposable and separate from the Canned buyer and reference-provider wallets.

The current official Venus Core Testnet read targets are pinned in `src/reference/constants.mjs`: Comptroller `0x94d1820b2D1c7c7452A163983Dc888CEC546b77D`, oracle `0x3cD69251D04A28d887Ac14cbe2E14c52F3D57823`, vBNB `0x2E7222e51c0f6e98610A1543Aa3836E092CDe62c`, vUSDT `0xb7526572FFE56AB9D7489838Bf2E18e3323b441A`, and underlying USDT `0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c`. These are BSC Testnet-only values. The official deployment source is [Venus’ deployed-contract reference](https://raw.githubusercontent.com/VenusProtocol/venus-protocol-documentation/main/deployed-contracts/markets.md).

The intended tiny position is 0.005 BNB collateral and 0.1 USDT debt. It is created only with explicit testnet write and position confirmations. The position script allowlists the buyer, disposable benchmark wallet, and the exact Venus contracts; it has no withdraw, arbitrary-call, or mainnet path.

## User problem

“Watch this lending position. Tell me how close I am to liquidation, what changed, and what bounded action would restore my safety margin.”

## Actual data contract

The module requires:

- a BSC testnet account;
- protocol `Venus`;
- an authoritative onchain snapshot;
- pool type and block reference;
- raw protocol liquidity/shortfall fields for Core Pool, or a pool-specific authoritative read plan for Isolated Pools.

Absent or non-authoritative data returns `INSUFFICIENT_AUTHORITATIVE_DATA` and no assessment. A number from a fixture, an LLM, or an unverified API is not relabeled as a health factor.

For Core Pool, the read seam uses `Comptroller.getAccountLiquidity(address)`. Venus’s liquidation model uses collateral factor and liquidation threshold semantics; the implementation therefore preserves raw fields and only classifies a shortfall or a supplied authoritative health factor. It does not invent a universal formula for all Venus pool types.

## Output

Every successful deliverable includes the account, pool, block, source, assessment, deterministic changes from the prior snapshot, recommendation-only action, and snapshot hash. `automaticActionTaken` is always `false` in this release.

## Control and TermiX

The repository contains an independent deterministic protocol-read control for engineering evaluation. It is not a human baseline and is never marked as TermiX evidence. `manualHealthFactorBaselinePacket()` produces a packet with an explicit contamination boundary and no expected answer. The human procedure must be completed and returned before comparing it with an agent result.

The human route is `/baseline/health-factor`. The server starts the timer, serves only the frozen raw source, preserves the submitted JSON verbatim, and records elapsed time from server timestamps. Before submission, Health Guard output, evaluator output, ground truth, and classification are unavailable through the benchmark task route. The human response is not auto-corrected or LLM-graded.

After a human submission, a later continuation may obtain a fresh signed quote and execute the paid path. That continuation is not part of this foundation checkpoint and has not been broadcast.

## Current release status

The HTTP endpoint, public-service packaging, runtime, task module, deterministic tests, and SDK seller seam are implemented. Production readiness still requires a deployed HTTPS URL ending in `/erc8183`, an IPFS/content-addressed storage credential, public readiness verification, and then sponsored ERC-8004 registration. The public service does not expose local filesystem deliverables as evidence. No live answer, human baseline, ERC-8004 registration, or paid job is claimed by this repository change.
