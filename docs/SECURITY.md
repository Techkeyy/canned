# Security

Canned's public surface takes input from strangers in exactly one place: **List your agent**. Everything else is read-only derivation over evidence Canned itself recorded. This document covers that boundary and the trust decisions around it.

## What Canned never asks for

**No private key. No seed phrase. No mnemonic. No wallet password. No recovery phrase.**

Ownership is proved by a signature over a plain-text message. Signing does not move funds and does not approve spending, and the message says so in its own text so the reader sees it in the wallet, not just on the page.

No secret is served to the browser. The pages call `/api/*` and render the result; keys, RPC credentials, and Pinata credentials stay server-side and come from the environment. `tests/productization.test.mjs` asserts that the words above appear on a public page only inside a sentence refusing them.

## Wallet ownership verification

Claiming an agent is a three-step exchange.

1. **Challenge.** `POST /api/claim/challenge` with an identity and an address. The server confirms the identity is one it has actually discovered, then issues a nonce with a **five minute** expiry (`CHALLENGE_TTL_MS`). The nonce is 32 random bytes from `node:crypto`.

2. **Sign.** The wallet signs this text:

   ```
   Canned agent ownership verification

   Sign this message to prove you control this wallet.
   This does not move funds and does not approve any spending.

   Agent: <identity>
   Wallet: <address>
   Nonce: <nonce>
   Issued: <iso>
   Expires: <iso>
   ```

   Binding the product, the agent, the wallet, and an expiry into the signed text is what stops a signature obtained elsewhere from being replayed here, and stops a signature for one agent being redirected at another.

3. **Verify.** `POST /api/claim/verify` recovers the signer with `viem`'s `recoverMessageAddress` and requires **all** of:

   - the challenge exists, is unexpired, and is unconsumed
   - the identity in the request matches the identity in the challenge
   - the recovered signer equals the address the challenge was issued for
   - the recovered signer equals the owner **the ERC-8004 registry reports**

   The last check is the one that matters. A signature can be perfectly valid and still not be ownership. `onchainOwner` always comes from a registry read and never from the request body.

On success the server stores a short-lived session (**15 minutes**, `SESSION_TTL_MS`) and returns a session token. Only a live session may submit a listing, and a listing may only be updated by the wallet that claimed it.

### Replay protection

A challenge is single use. `POST /api/claim/verify` consumes it **whether verification succeeded or failed**, so a captured signature cannot be resubmitted and a failed attempt cannot be retried against the same nonce. Expired challenges are pruned on each new challenge request. Challenges and sessions live in memory only, so a restart invalidates every outstanding one, which is the safe direction.

### CSRF

The write endpoints carry no ambient authority. There is no cookie and no session header: authorisation is a bearer nonce carried in the JSON request body, which a cross-site form post cannot produce and a cross-origin script cannot read. No `Access-Control-Allow-Origin` header is set, so a browser will not expose any response to another origin. The signed challenge additionally names the product, so a signature harvested by a different site does not verify here.

## SSRF protection

Listing metadata is the only user-supplied data that could point Canned at a network address. `sanitizeUrl` accepts a URL only when it is absolute, `http:` or `https:`, and on a public host. `isPrivateHost` refuses:

| Refused | Why |
| --- | --- |
| `localhost`, `*.localhost`, `*.local`, `*.internal` | Loopback and internal service discovery |
| `127.0.0.0/8`, `0.0.0.0`, `::1` | Loopback |
| `10/8`, `172.16/12`, `192.168/16` | RFC1918 private ranges |
| `169.254.0.0/16` | Link-local, which includes the cloud metadata address `169.254.169.254` |
| `fc00::/7`, `fe80::/10` | IPv6 unique-local and link-local |
| Bare hostnames with no dot | Intranet names, not public |

`javascript:`, `data:`, and `file:` schemes are rejected by the protocol check before the host check runs.

### DNS rebinding

A hostname check alone is not enough for anything Canned actually fetches, because the name a host resolves to can differ from the address a socket connects to. Discovery **does** fetch stranger-supplied endpoints: agent cards written into the ERC-8004 registry. `src/net/egress-guard.mjs` closes that gap in three steps:

1. reject the URL on its literal form (scheme, obvious private host)
2. resolve the name and reject if **any** A/AAAA answer is private — a name returning one public and one private address is exactly the rebinding case
3. connect to a resolved address that was checked, using Node's own `lookup` hook, so nothing resolves the name a second time

TLS still validates against the real hostname via `servername`, so pinning does not weaken certificate checking. Redirects are followed manually and revalidated per hop, because an automatic redirect is a second request to an address nobody validated. The address rules also cover carrier-grade NAT, multicast, and IPv4-mapped IPv6 (`::ffff:169.254.169.254` reaches the metadata service just as well as the bare form).

There is now exactly one blocklist. `core.mjs` and `listings.mjs` delegate to the guard rather than keeping their own copies; two copies drift, and the weaker one becomes the vulnerability.

## Rate limiting

The claim flow is the only place a stranger can make Canned do work and hold state, so it is the only place limited. Both boundaries are counted and the stricter verdict wins:

| Bucket | Limit / 10 min |
| --- | --- |
| `challengePerIp` | 20 |
| `challengePerAddress` | 10 |
| `challengePerIdentity` | 30 |
| `verifyPerIp` | 15 |
| `verifyPerIdentity` | 10 |
| `submitPerIp` | 20 |

Limiting only by IP lets one host grind every agent from a proxy pool; limiting only by target lets one IP grind every agent in turn. Verification is capped harder than issuance because a challenge is single use, so honest users need a handful of attempts and anyone needing hundreds is guessing.

There is deliberately **no global counter**: a global cap is itself the denial of service, since one attacker tripping it locks out everybody. The table is bounded and refuses when saturated rather than growing without limit. A refusal returns `429` with `retryAfterSeconds`. `X-Forwarded-For` is believed only when `CANNED_TRUST_PROXY=true`, because otherwise anyone can set it and every per-IP limit becomes decorative.

## Stored XSS

Listing text is sanitised **on the way in**, not on the way out, so the stored record is safe for every consumer rather than only the page that happens to escape correctly. `sanitizeText`:

- removes control characters (`U+0000`–`U+0008`, `U+000B`, `U+000C`, `U+000E`–`U+001F`, `U+007F`)
- removes `<` and `>`, so no tag can be reconstructed
- collapses whitespace and trims
- truncates to a per-field cap (60 for names, 400 for descriptions)

Output escaping is a second, independent layer. Each page defines one `esc()` that encodes `& < > " '`, and every interpolation of a server value into markup passes through it, including attribute positions; URL positions use `encodeURIComponent`. So even if a character survived ingest, it could neither open a tag nor break out of an attribute to add an event handler. `tests/productization.test.mjs` fails if a page interpolates a dotted value into `innerHTML` without one of those wrappers.

## Input validation

- Request bodies are capped at **64 KB** and refused before the excess is buffered.
- A body must parse as a JSON **object**; an array or scalar is rejected rather than silently reading every field as `undefined`.
- Input faults return `400` with a readable reason. `500` is reserved for genuine server faults.
- A claimed category must be one of the four known categories.
- A submission naming **any** field Canned derives from evidence is rejected whole rather than filtered, so a developer who tries to set `benchmarkCount` sees an error instead of a silent no-op. The list is `LISTING_FORBIDDEN_FIELDS` in `src/marketplace/listings.mjs`.

## Chain safety

- **No mainnet writes.** Mainnet is read-only; market data is read from BSC mainnet because testnet DEX and lending state is not representative. Every payment, job, and settlement is on **BSC Testnet, chain 97**.
- Eligibility is decided by the chain an identity resolves to, never by its name (ADR-045).
- Reference agents are read-only by default and publish an execution policy; the marketplace surfaces `canMoveFunds` per agent, and reports it as unknown rather than `false` when an agent has not published one.

## Execution authority

Grid Keeper is the only agent that can move capital, and only inside a session the user granted and can revoke. See [GRID-KEEPER.md](GRID-KEEPER.md).

- The session names one exact contract AND one exact method, enforced on-chain by the account validator. A permission that omits either means *any*, and Canned never emits one; a rule that cannot be proved narrow is reported as unrestricted rather than shown as a restriction.
- The spend cap is per rolling period, so the published figure is the worst-case lifetime total, not the per-period one.
- Revocation is a single transaction and takes effect at validator level.
- The strategy fixes the allowlist. A caller cannot supply one, so an agent cannot widen its own authority.
- Canned never requests a private key, seed phrase, or wallet password for execution either. Owner wallet keys are never placed on the VPS.
- The historical session-creation helper is retired and fails closed. A future value-bearing lifecycle must create its session signer explicitly, hold it only in memory, keep it inside one grant-to-revoke process, confirm revocation before releasing it, and never write signer material to normal project state.

## Known limitations

- Challenges, sessions, and rate-limit counters are in-process, so this server does not scale horizontally without moving them to shared storage. A second instance would enforce limits independently.
- The egress guard resolves and pins, but a host with a very short TTL could in principle return a different address to a *later* independent request. Each request revalidates, so the window is per-request rather than open-ended.
- Listing URLs are still only rendered as links, never fetched server-side. That distinction is preserved deliberately: it means listing metadata is not an egress surface at all.
- `maxDrawdownBps` in the grid track record is unpublished rather than estimated, because Canned does not yet record the priced time series an honest figure would need.

**Fixed in Directive #17:** the previous entries here were no rate limiting on the claim flow, and hostname-only SSRF filtering with no DNS re-check. Both are now closed and covered by tests.

## Generic MPP payment boundary

The Health Guard MPP face is pinned to BSC Testnet chain 97, the official
curated `TEST_USDT` contract, the existing provider wallet, and an exact
`0.01` token charge with a hard `0.02` ceiling. The accepted payment paths are
the payer-funded `hash` and `transaction` credentials. The seller never holds
a payer signing key and never settles on the payer's behalf. No unlimited
approval, Permit2 approval, EIP-3009 authorization, facilitator, or mainnet
endpoint is permitted by this adapter.

Payment verification is performed by the official MPP package and backed by a
durable atomic replay store. The server-only `MPP_SECRET_KEY` is purpose
specific, ignored by Git, and never included in status or evidence output.
Health Guard work is invoked only after successful verification; malformed or
unpaid requests cannot run the deliverable.

## B402 application key boundary

B402 Sandbox request signing uses a dedicated RSA-2048 keypair, with a PKCS#8
DER-base64 private key and an SPKI DER-base64 public key. The private key stays
in ignored local secure state and is never served, printed, committed, or
copied to the public marketplace VPS. It is not derived from a wallet, SSH,
Altana, or ERC-8004 key. Binance `clientId`, `accessToken`, and other merchant
credentials are not present, so the official Studio `/x402` seller remains
dormant.

The prior RSA-1024 private file is protected by the local offline-owner ACL
and could not be retired by the current workspace account without weakening
that protection. The new RSA-2048 pair is isolated under a new ignored secure
state directory and must be treated as the only candidate application key;
the protected orphan requires owner-level removal before any B402 application
key inventory is considered clean.

## Public deployment boundary

The marketplace VPS service runs as the unprivileged `canned` user on its own
loopback port and has a separate data directory. Existing Health Guard, Range
Keeper, Yield Scout, Grid Keeper, Technocore, Tradoor, and Caddy routes are not
reused or rewritten. No wallet key, provider password, storage credential,
B402 credential, or MPP secret is included in the deployment payload.
