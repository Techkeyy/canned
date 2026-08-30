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

`javascript:`, `data:`, and `file:` schemes are rejected by the protocol check before the host check runs. The same boundary applies to the endpoint prober: Canned does not probe an address a stranger supplied that resolves inside a private range.

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

## Known limitations

- Challenges and sessions are in-process, so this server does not scale horizontally without moving them to shared storage.
- There is no rate limiting on `/api/claim/challenge`. The endpoint requires a discovered identity and issues only in-memory state, so the exposure is memory growth between prunes rather than any authorisation weakness. A public deployment should add a limiter.
- `isPrivateHost` filters by hostname. It does not re-check the address after DNS resolution, so a hostname that resolves to a private address (DNS rebinding) is not caught by this layer. Listing URLs are rendered as links rather than fetched server-side, which limits the impact.
