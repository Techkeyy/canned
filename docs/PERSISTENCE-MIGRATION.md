# Persistence migration plan

The current local file store remains the evidence source for this milestone. It keeps state, raw artifacts, inventory, precommits, protocol jobs, reference deliverables, and provider history separate. The `Evidence` hash is a content commitment, not a claim that the content is true.

## Migration sequence

1. Keep canonical manifests and run state versioned with a schema number.
2. Move queryable entities to PostgreSQL: Agent, ServiceCapability, HireAttempt, BenchmarkRun, ControlRun, Evidence, TrackRecord, AgentStatus, AuthorityGrant, and SchedulerPolicy.
3. Move raw deliverables and manifests to immutable object storage or IPFS, retaining SHA-256 and Keccak-256 hashes plus media type and redaction policy.
4. Keep onchain references, transaction receipts, session grant/revoke hashes, and protocol state as append-only observations.
5. Add dual-write verification for one migration window; compare canonical hashes before switching reads.
6. Preserve a local export/import tool that can rebuild the public index without wallet credentials.

No secret, wallet password, session key, or private key belongs in the database, object store, public manifest, or Git history.
