import path from "node:path";
import { createReferenceManifest } from "./foundation.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK } from "./constants.mjs";

export async function createReferenceSeller({ providerWallet, runtime, storageDir, agentUrl, servicePriceRaw = runtime.spec.priceRaw } = {}) {
  if (!providerWallet || !runtime) throw new Error("Reference seller requires a provider wallet and runtime.");
  const sdk = await import("@bnbagent/sdk/erc8183");
  const rootSdk = await import("@bnbagent/sdk");
  const storage = await import("@bnbagent/sdk/storage");
  const erc8183Client = await rootSdk.ERC8183Client.create({ walletProvider: providerWallet, network: REFERENCE_NETWORK });
  const negotiationHandler = await sdk.NegotiationHandler.fromErc8183Client(erc8183Client, { servicePrice: String(servicePriceRaw), walletProvider: providerWallet, quoteTtlSeconds: 900 });
  const resolvedStorageDir = storageDir || path.resolve(process.cwd(), "data", "reference-deliverables");
  const jobOps = await sdk.ERC8183JobOps.create({
    walletProvider: providerWallet,
    network: REFERENCE_NETWORK,
    storageProvider: new storage.LocalStorageProvider(resolvedStorageDir),
    servicePrice: BigInt(servicePriceRaw),
    agentUrl,
  });
  return { sdk, jobOps, erc8183Client, negotiationHandler, storageDir: resolvedStorageDir, chainId: REFERENCE_CHAIN_ID, network: REFERENCE_NETWORK };
}

export async function negotiateReferenceQuote({ seller, request } = {}) {
  if (!seller?.negotiationHandler) throw new Error("Reference seller has no signed negotiation handler.");
  const result = await seller.negotiationHandler.negotiate(request);
  return result.toDict();
}

export async function processFundedReferenceJob({ seller, runtime, job, task, previousSnapshot = null } = {}) {
  if (!seller?.jobOps || !runtime || !job) throw new Error("A seller, runtime, and funded job are required.");
  const jobId = Number(job.jobId ?? job.id);
  const verification = await seller.jobOps.verifyJob(jobId);
  if (verification.valid !== true) return { ok: false, status: "rejected", jobId, verification };
  const worked = await runtime.work({ jobId, task, previousSnapshot });
  if (!worked.ok) return worked;
  const submitted = await seller.jobOps.submitResult(jobId, worked.canonicalOutput, { origin: runtime.spec.identity, referenceOrigin: "CANNED_REFERENCE", taskVersion: runtime.spec.key });
  if (submitted.success !== true) return { ...worked, ok: false, status: "submit_failed", submission: submitted };
  runtime.stats.jobsSubmitted += 1;
  const deliverable = createReferenceManifest({ jobId, output: worked.output, metadata: { referenceAgent: runtime.spec.identity } });
  return { ...worked, ok: true, status: "submitted", submission: { txHash: submitted.txHash || null }, deliverable: { manifestHash: deliverable.hashes.keccak256, contentHash: deliverable.hashes.sha256 } };
}

export function startReferenceWatcher({ seller, runtime, taskResolver, interval = 30, stop } = {}) {
  if (!seller?.jobOps || !runtime || typeof taskResolver !== "function") throw new Error("Reference watcher requires seller, runtime, and taskResolver.");
  return import("@bnbagent/sdk/erc8183").then(({ fundedJobWatcher }) => fundedJobWatcher(seller.jobOps, async (job) => {
    const task = await taskResolver(job);
    const result = await processFundedReferenceJob({ seller, runtime, job, task });
    if (result.status === "submit_failed" && result.submission?.retryable === true) return { retry: true };
    return undefined;
  }, { interval, stop }));
}
