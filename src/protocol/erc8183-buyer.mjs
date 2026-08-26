import path from "node:path";
import { ERC8183_STATES } from "../domain.mjs";
import { canonicalJson, contentHashes, nowIso, safeError } from "../core.mjs";

export function writeSafety(env = process.env) {
  const network = env.CANNED_NETWORK || "bsc-testnet";
  const writesRequested = env.CANNED_ALLOW_TESTNET_WRITES === "true";
  const hasPassword = Boolean(env.CANNED_EXECUTION_WALLET_PASSWORD);
  const hasKeyOrAddress = Boolean(env.CANNED_EXECUTION_WALLET_PRIVATE_KEY || env.CANNED_EXECUTION_WALLET_ADDRESS);
  const errors = [];
  if (writesRequested && network !== "bsc-testnet") errors.push("Canned writes are allowed only on bsc-testnet.");
  if (writesRequested && (!hasPassword || !hasKeyOrAddress)) errors.push("Testnet writes require a dedicated execution wallet password and address or first-import private key.");
  if (network === "bsc-mainnet" && writesRequested) errors.push("Mainnet writes are disabled by policy.");
  return { network, writesRequested, hasPassword, hasKeyOrAddress, walletConfigured: hasPassword && hasKeyOrAddress, safe: errors.length === 0, errors };
}

let sdkPromise;
export async function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@bnbagent/sdk");
  return sdkPromise;
}

export async function sdkStatus() {
  try {
    const sdk = await loadSdk();
    return { available: Boolean(sdk.ERC8183Client && sdk.EVMWalletProvider), version: "0.5.4", package: "@bnbagent/sdk" };
  } catch (error) {
    return { available: false, package: "@bnbagent/sdk", error: safeError(error) };
  }
}

export async function createBuyer({ env = process.env, dataDir = env.CANNED_DATA_DIR || path.resolve(process.cwd(), "data") } = {}) {
  const safety = writeSafety(env);
  if (!safety.writesRequested) throw new Error("Canned testnet writes are not explicitly enabled; buyer writes are blocked.");
  if (!safety.walletConfigured) throw new Error("Canned execution wallet is not configured; buyer writes are blocked.");
  if (!safety.safe) throw new Error(safety.errors.join(" "));
  const sdk = await loadSdk();
  const wallet = new sdk.EVMWalletProvider({
    password: env.CANNED_EXECUTION_WALLET_PASSWORD,
    privateKey: env.CANNED_EXECUTION_WALLET_PRIVATE_KEY || undefined,
    address: env.CANNED_EXECUTION_WALLET_ADDRESS || undefined,
    walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"),
    persist: true,
  });
  const client = await sdk.ERC8183Client.create({ network: safety.network, walletProvider: wallet });
  return { sdk, wallet, client, network: safety.network };
}

function txShape(result) {
  return result ? { transactionHash: result.transactionHash || null, status: result.status ?? null } : null;
}

async function protocolSnapshot(client, jobId) {
  const job = await client.getJob(BigInt(jobId));
  return {
    id: String(job.id),
    client: job.client,
    provider: job.provider,
    evaluator: job.evaluator,
    description: job.description,
    budget: String(job.budget),
    expiredAt: String(job.expiredAt),
    statusCode: Number(job.status),
    status: ERC8183_STATES[Number(job.status)] || "UNKNOWN",
    hook: job.hook,
    deliverable: job.deliverable,
    submittedAt: String(job.submittedAt),
  };
}

export async function createFundedJob({ agent, precommit, quote, store, env = process.env }) {
  const safety = writeSafety(env);
  if (!safety.safe || !safety.writesRequested || !safety.walletConfigured) {
    return { ok: false, status: "blocked", error: safety.writesRequested ? "A dedicated execution wallet is required before funding." : "Testnet writes are not explicitly enabled.", safety };
  }
  const provider = agent.agentWallet || agent.ownerAddress;
  if (!provider) return { ok: false, status: "blocked", error: "Candidate has no provider wallet address." };
  const quotedTerms = quote?.quote?.terms || quote?.quote || null;
  if (!quotedTerms?.price || !quotedTerms?.currency) return { ok: false, status: "blocked", error: "A signed quote with price and currency is required before funding." };
  const buyer = await createBuyer({ env });
  const record = {
    kind: "protocol_job",
    protocol: "ERC-8183",
    network: safety.network,
    runId: precommit.runId,
    agentIdentity: agent.identity,
    provider,
    precommitHash: precommit.manifestHash,
    state: "not_started",
    funded: false,
    events: [],
    createdAt: nowIso(),
  };
  const persist = async (event, extra = {}) => {
    record.events.push({ at: nowIso(), event, ...extra });
    await store.saveJson(`state/protocol-job-${precommit.runId}.json`, record);
  };
  try {
    const expiredAt = BigInt(precommit.deadlineAtUnixSeconds);
    const description = canonicalJson({
      type: "canned-precommit-v1",
      benchmarkId: precommit.benchmarkId,
      manifestHash: precommit.manifestHash,
      negotiationHash: quote.negotiationHash,
    });
    const created = await buyer.client.createJob({ provider, expiredAt, description });
    if (created.jobId === null || created.jobId === undefined) throw new Error("ERC-8183 createJob returned no job ID.");
    record.jobId = String(created.jobId);
    record.state = "created";
    await persist("create_job", { tx: txShape(created), snapshot: await protocolSnapshot(buyer.client, created.jobId) });
    const registered = await buyer.client.registerJob(created.jobId);
    await persist("register_job", { tx: txShape(registered), snapshot: await protocolSnapshot(buyer.client, created.jobId) });
    const budget = BigInt(quotedTerms.price);
    const funded = await buyer.client.fund(created.jobId, budget, { approveFloor: 0n });
    record.state = "funded";
    record.funded = true;
    await persist("fund_job", { tx: txShape(funded), snapshot: await protocolSnapshot(buyer.client, created.jobId) });
    return { ok: true, status: "funded", record, client: buyer.client, wallet: buyer.wallet };
  } catch (error) {
    record.state = "error";
    record.error = safeError(error);
    await persist("error", { error: record.error });
    return { ok: false, status: "error", record, error: record.error };
  }
}

export async function readJob({ client, jobId }) {
  return protocolSnapshot(client, jobId);
}
