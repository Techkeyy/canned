import { canonicalJson, contentHashes, nowIso, safeError } from "../core.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_ORIGIN } from "./constants.mjs";

export class ReferenceAgentRuntime {
  constructor({ spec, taskHandler, clock = () => Date.now(), workerStaleMs = 90_000 } = {}) {
    if (!spec?.identity || typeof taskHandler !== "function") throw new Error("ReferenceAgentRuntime requires a spec and task handler.");
    this.spec = spec;
    this.taskHandler = taskHandler;
    this.clock = clock;
    this.workerStaleMs = workerStaleMs;
    this.startedAt = new Date(this.clock()).toISOString();
    this.worker = { state: "not_started", heartbeatAt: null, lastJobId: null, lastError: null };
    this.stats = { jobsDetected: 0, jobsWorked: 0, jobsSubmitted: 0, failures: 0 };
  }

  heartbeat({ state = "idle", jobId = null, error = null } = {}) {
    this.worker = { state, heartbeatAt: new Date(this.clock()).toISOString(), lastJobId: jobId, lastError: error ? safeError(error) : null };
    return this.worker;
  }

  health() {
    return { ok: true, origin: REFERENCE_ORIGIN, identity: this.spec.identity, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, endpointAlive: true, startedAt: this.startedAt };
  }

  readiness() {
    const heartbeatMs = this.worker.heartbeatAt ? Date.parse(this.worker.heartbeatAt) : null;
    const workerAlive = heartbeatMs !== null && this.clock() - heartbeatMs <= this.workerStaleMs && this.worker.state !== "failed";
    return {
      origin: REFERENCE_ORIGIN,
      identity: this.spec.identity,
      network: REFERENCE_NETWORK,
      chainId: REFERENCE_CHAIN_ID,
      endpoint: { alive: true, status: "up" },
      worker: { alive: workerAlive, status: this.worker.state, heartbeatAt: this.worker.heartbeatAt, staleAfterMs: this.workerStaleMs, lastJobId: this.worker.lastJobId, lastError: this.worker.lastError },
      distinction: "Endpoint liveness does not imply worker liveness.",
    };
  }

  negotiate({ request = {}, providerAddress = null, paymentToken = null, priceRaw = this.spec.priceRaw, ttlSeconds = 300 } = {}) {
    if (!providerAddress) return { ok: false, status: "not_ready", error: "Reference provider wallet is not configured; no quote was issued." };
    return { ok: false, status: "not_ready", error: "Reference quotes must be issued through the official signed NegotiationHandler; no unsigned quote was issued." };
  }

  async work({ jobId, task, previousSnapshot = null }) {
    this.stats.jobsDetected += 1;
    this.heartbeat({ state: "working", jobId });
    const started = this.clock();
    try {
      const result = await this.taskHandler({ jobId, task, previousSnapshot, runtime: this });
      const elapsedMs = this.clock() - started;
      this.stats.jobsWorked += 1;
      this.heartbeat({ state: "idle", jobId });
      return { ok: result?.ok !== false, status: result?.status || "delivered", jobId, elapsedMs, output: result?.output ?? null, canonicalOutput: result?.canonicalOutput || (result?.output ? canonicalJson(result.output) : null), evidence: result?.output ? contentHashes(result.output) : null };
    } catch (error) {
      this.stats.failures += 1;
      this.heartbeat({ state: "failed", jobId, error });
      return { ok: false, status: "error", jobId, elapsedMs: this.clock() - started, error: safeError(error), output: null };
    }
  }

  metrics() {
    return { ...this.stats, readiness: this.readiness(), generatedAt: nowIso() };
  }
}

export function createReferenceManifest({ jobId, output, metadata = {} } = {}) {
  const responseContent = canonicalJson(output);
  const manifest = { version: "1.0", jobId: Number(jobId), response: { content: responseContent, contentType: "text/plain" }, metadata: { origin: REFERENCE_ORIGIN, ...metadata } };
  return { manifest, hashes: contentHashes(manifest), responseContent };
}
