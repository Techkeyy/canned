# Durable Health Guard deployment

This package deploys the existing `scripts/run-public-health-guard.mjs` as a long-running BSC Testnet ERC-8183 seller. It does not deploy a new Health Guard implementation, expose signing operations, or enable a paid buyer run.

## Current storage contract

The installed `@bnbagent/sdk@0.5.4` `IPFSStorageProvider.fromEnv()` expects `STORAGE_API_KEY`. For Pinata, place the JWT in that server-only variable. The optional `STORAGE_API_URL` and `STORAGE_GATEWAY_URL` defaults target Pinata. Do not rename it to `PINATA_JWT` unless the application adapter is deliberately changed and reviewed.

## Before touching the VPS

Use an existing VPS hostname and existing SSH profile only. Run `scripts/inspect-vps-readonly.sh` after login and record the OS, resources, listening ports, reverse proxy, systemd, firewall, and existing workloads. Do not overwrite an existing application or invent DNS records.

The intended internal port is `8790`, subject to the read-only port check. The public URL must be a dedicated HTTPS hostname ending in `/erc8183`.

## systemd installation

1. Create a dedicated `canned` service user and `/opt/canned`, `/etc/canned`, and `/var/lib/canned` directories.
2. Copy the repository application files to `/opt/canned` and run `npm ci --omit=dev` there.
3. Copy the frozen `data/state/healthbench-v1.json` definition to `/etc/canned/healthbench-v1.json`. This is the frozen benchmark source only; do not copy the human baseline evidence into the service.
4. Copy the encrypted reference-provider wallet directory to `/etc/canned/reference-provider-wallets` with restrictive permissions.
5. Copy `health-guard.env.example` to `/etc/canned/health-guard.env`, fill values locally, and set mode `600`. Keep `STORAGE_API_KEY` and `CANNED_REFERENCE_PROVIDER_PASSWORD` only in this file or a host secret manager.
6. Install `canned-health-guard.service` into `/etc/systemd/system/`, then run `systemctl daemon-reload` and start it only after configuration review.
7. Initially keep `CANNED_REFERENCE_ENABLE_FULFILLMENT=false` and `CANNED_REFERENCE_ALLOW_TESTNET_WRITES=false`. After the URL, wallet, storage, and task-file configuration is reviewed, set both to `true` on the VPS to start the seller watcher. These are seller-side BSC Testnet permissions and do not start a buyer payment or HealthBench execution.

## Docker alternative

Copy the env file, task definition, and encrypted provider wallet directory to the paths used by `docker-compose.health-guard.yml`. Build and run with the compose file from `deploy/`. The container binds only to `127.0.0.1:8790` on the VPS and uses `restart: unless-stopped`.

## Reverse proxy

Use either the Caddy or Nginx template as a dedicated virtual host. Replace the placeholder only after confirming an existing DNS record points to this VPS. Obtain or reuse valid TLS for that hostname. The proxy must preserve the `/erc8183` path and must not route another application's path to this service.

## Storage readiness

After the service environment has the Pinata JWT, run `npm run reference:storage:check` from that environment. It uploads two deterministic harmless JSON probes, verifies public gateway retrieval and content hashes, confirms changed content receives a different CID, and never prints the credential. Unpin both probe CIDs later if appropriate.

Then run `npm run reference:public:check` from an external network. It must verify public DNS/TLS/HTTP, chain 97, U, provider, bounded signed quote, IPFS storage, and worker/watcher status. Do not register ERC-8004 or run HealthBench if any check fails.

After a separately authorized testnet registration, run `npm run reference:identity:verify`. It performs direct registry reads, SDK resolution, endpoint/provider binding checks, and an independent 8004scan lookup without broadcasting.

## Restart check

After readiness is otherwise green, perform one controlled service restart. Confirm the public health/readiness endpoints, watcher heartbeat, provider address, endpoint, storage, and logs remain safe. A restart must not change the provider or public URL.

ERC-8004 registration remains a separate, explicit BSC Testnet write. HealthBench remains intentionally unexecuted until a later directive.
