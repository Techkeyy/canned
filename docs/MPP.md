# Generic BNB-native MPP fallback

Canned Health Guard exposes a separate generic MPP HTTP-402 adapter at
`/mpp`. It is an alternate payment face for the same existing Health Guard;
it is not Binance B402, Studio x402, or ERC-8183.

## Offer

- Network: BSC Testnet, chain 97 (`bsc-testnet`)
- Token: official curated `TEST_USDT`, symbol `USDT`, 18 decimals
- Token address: `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd`
- Recipient: the existing Health Guard provider wallet
- Price: `10000000000000000` raw (`0.01` TEST_USDT)
- Hard ceiling: `20000000000000000` raw (`0.02` TEST_USDT)
- Credentials accepted: payer-funded `hash` and `transaction`
- Settlement: direct ERC-20 transfer; no seller settlement signer

The seller verifies the official MPP challenge, the chain, token contract,
receipt success, exact `Transfer` event, recipient, amount, and strict payer
source. It runs the existing deterministic `buildHealthFactorDeliverable`
only after payment verification. The first recorded paid response did not
retain the original `Payment-Receipt` header; the public evidence states that
boundary explicitly.

## Durability and secrets

MPP challenge binding and replay state use `mppx-managed` plus the durable
atomic file store at `data/state/mpp-replay` (or the configured data directory
on the VPS). `MPP_SECRET_KEY` may be supplied through server-only environment
state; otherwise a purpose-specific 32-byte secret is generated into
`data/state/mpp-secret-key` with restrictive permissions. It is never returned
by a status route or written to evidence.

The payer helper is `scripts/run-mpp-health-check-payment.mjs`. It uses the
existing buyer keystore, verifies the exact offer and balances, sends one
direct transfer only when invoked with the separately authorized `--confirm`,
submits a hash credential, independently checks the receipt and transfer log,
checks `Payment-Receipt`, and retries the same credential to prove replay
rejection. It never calls `approve`, Permit2, EIP-3009, a facilitator, or a
mainnet endpoint.

## Honest protocol boundary

BNB Chain Support has confirmed that this generic MPP settlement proof is
accepted for the hackathon. `GET /api/reference/health-factor/mpp` reports the MPP offer and explicitly
marks `notX402: true` and `notB402: true`. The existing `/x402` status remains
the official Studio/B402 surface and remains dormant until Binance merchant
credentials are present. MPP evidence must not be presented as Binance B402 or
as an x402 payment.

## Verified fallback run

On 2026-09-01, the existing buyer paid exactly `0.01 TEST_USDT` in one direct
transfer:

- transaction: `0xcc988caa3b584717f8541e058e46943b97578015686efc014787a2f5fa21cfb7`
- block: `128468610`
- independent receipt: successful, with one exact canonical `Transfer` event
- official MPP replay state: `consumed`
- replay of the same hash: HTTP 402 with `hash credential already consumed`

The first payer-runner version asserted the wrong response shape after the
paid response and therefore did not retain the original `Payment-Receipt`
header locally. The verifier's consumed state and the explicit replay failure
remain the authoritative evidence that the exact payer-funded transfer was
accepted; no second payment was attempted. The bookkeeping assertion is fixed
in the runner for future runs.
