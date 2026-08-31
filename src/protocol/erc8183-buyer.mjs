import path from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { parseAbiItem } from "viem";
import { ERC8183_STATES } from "../domain.mjs";
import { contentHashes, isPublicHttpUrl, nowIso, requestJson, safeError } from "../core.mjs";

const require = createRequire(import.meta.url);
const BNB_SDK_PACKAGE = path.resolve(path.dirname(require.resolve("@bnbagent/sdk")), "..", "package.json");
const BNB_SDK_VERSION = JSON.parse(readFileSync(BNB_SDK_PACKAGE, "utf8")).version;

export function writeSafety(env = process.env) {
  const network = env.CANNED_NETWORK || "bsc-testnet";
  const writesRequested = env.CANNED_ALLOW_TESTNET_WRITES === "true";
  const hasPassword = Boolean(env.CANNED_EXECUTION_WALLET_PASSWORD);
  const hasKeyOrAddress = Boolean(env.CANNED_EXECUTION_WALLET_PRIVATE_KEY || env.CANNED_EXECUTION_WALLET_ADDRESS);
  const errors = [];
  if (writesRequested && network !== "bsc-testnet") errors.push("Canned writes are allowed only on bsc-testnet.");
  if (writesRequested && env.CANNED_CHAIN_ID !== undefined && Number(env.CANNED_CHAIN_ID) !== 97) errors.push("Canned writes require chain ID 97.");
  if (writesRequested && (!hasPassword || !hasKeyOrAddress)) errors.push("Testnet writes require a dedicated execution wallet password and address or first-import private key.");
  if (network === "bsc-mainnet" && writesRequested) errors.push("Mainnet writes are disabled by policy.");
  return { network, writesRequested, hasPassword, hasKeyOrAddress, walletConfigured: hasPassword && hasKeyOrAddress, safe: errors.length === 0, errors };
}

export async function sendNativeTransfer({ wallet, publicClient, to, valueWei, expectedChainId = 97 } = {}) {
  if (!wallet || !publicClient || !to) throw new Error("Native transfer requires a wallet, public client, and recipient.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(to))) throw new Error("Native transfer recipient is not a valid EVM address.");
  const chainId = await publicClient.getChainId();
  if (chainId !== expectedChainId) throw new Error(`Refusing native transfer on chain ${chainId}; expected ${expectedChainId}.`);
  const value = BigInt(valueWei);
  if (value <= 0n) throw new Error("Native transfer amount must be positive.");
  const gas = 21_000n;
  const gasPrice = await publicClient.getGasPrice();
  const balance = await publicClient.getBalance({ address: wallet.address });
  if (balance < value + gas * gasPrice) throw new Error("Buyer wallet lacks the bounded native transfer amount plus transfer gas.");
  const nonce = await publicClient.getTransactionCount({ address: wallet.address, blockTag: "pending" });
  const signed = await wallet.signTransaction({ to, value, gas, gasPrice, nonce, chainId: expectedChainId });
  const transactionHash = await publicClient.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
  if (receipt.status !== "success") throw new Error("Bounded native provider funding transaction failed.");
  return { transactionHash, receipt, gasPrice, value };
}

export function preflightGuards({ chainId, expectedChainId = 97, provider, expectedProvider, tokenAddress, quoteCurrency, quoteAccepted, quoteSignaturePresent, quoteExpiresAt, nowSeconds = Math.floor(Date.now() / 1000), tokenBalance = 0n, requiredBudget = 0n, nativeBalance = 0n, estimatedGasWei = 0n }) {
  const errors = [];
  if (chainId !== expectedChainId) errors.push(`wrong_chain:${chainId}`);
  if (provider && expectedProvider && provider.toLowerCase() !== expectedProvider.toLowerCase()) errors.push("provider_mismatch");
  if (!tokenAddress || !quoteCurrency || tokenAddress.toLowerCase() !== quoteCurrency.toLowerCase()) errors.push("payment_token_mismatch");
  if (quoteAccepted !== true) errors.push("quote_not_accepted");
  if (quoteSignaturePresent !== true) errors.push("quote_signature_missing");
  if (quoteExpiresAt && nowSeconds >= Number(quoteExpiresAt)) errors.push("quote_expired");
  if (BigInt(tokenBalance) < BigInt(requiredBudget)) errors.push("insufficient_payment_token");
  if (BigInt(nativeBalance) < BigInt(estimatedGasWei)) errors.push("insufficient_native_gas");
  return { ok: errors.length === 0, errors };
}

let sdkPromise;
export async function loadSdk() {
  if (!sdkPromise) sdkPromise = import("@bnbagent/sdk").then((sdk) => { sdk.loadEnv?.(process.cwd()); return sdk; });
  return sdkPromise;
}

export async function sdkStatus() {
  try {
    const sdk = await loadSdk();
    return { available: Boolean(sdk.ERC8183Client && sdk.EVMWalletProvider), version: BNB_SDK_VERSION, package: "@bnbagent/sdk" };
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

export function txShape(result) {
  if (!result) return null;
  const receipt = result.receipt || {};
  const gasUsed = receipt.gasUsed === undefined || receipt.gasUsed === null ? null : BigInt(receipt.gasUsed);
  const effectiveGasPrice = receipt.effectiveGasPrice === undefined || receipt.effectiveGasPrice === null ? null : BigInt(receipt.effectiveGasPrice);
  return {
    transactionHash: result.transactionHash || null,
    status: result.status ?? null,
    blockNumber: receipt.blockNumber === undefined || receipt.blockNumber === null ? null : String(receipt.blockNumber),
    gasUsed: gasUsed === null ? null : gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice === null ? null : effectiveGasPrice.toString(),
    gasCostWei: gasUsed !== null && effectiveGasPrice !== null ? (gasUsed * effectiveGasPrice).toString() : null,
  };
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
  const sdk = await loadSdk();
  const safety = writeSafety(env);
  if (!safety.safe || !safety.writesRequested || !safety.walletConfigured) {
    return { ok: false, status: "blocked", error: safety.writesRequested ? "A dedicated execution wallet is required before funding." : "Testnet writes are not explicitly enabled.", safety };
  }
  const provider = agent.agentWallet || agent.ownerAddress;
  if (!provider) return { ok: false, status: "blocked", error: "Candidate has no provider wallet address." };
  const quotedTerms = quote?.quote?.terms || quote?.quote || null;
  if (!quotedTerms?.price || !quotedTerms?.currency) return { ok: false, status: "blocked", error: "A signed quote with price and currency is required before funding." };
  const quoteExpiresAt = quote?.quote?.quote_expires_at || quotedTerms.quote_expires_at;
  if (quoteExpiresAt && Math.floor(Date.now() / 1000) >= Number(quoteExpiresAt)) return { ok: false, status: "blocked", error: "The signed quote has expired; renegotiate before funding." };
  const buyer = await createBuyer({ env });
  const paymentToken = await buyer.client.paymentToken();
  if (paymentToken.toLowerCase() !== String(quotedTerms.currency).toLowerCase()) {
    buyer.wallet.destroy();
    return { ok: false, status: "blocked", error: "Quote currency does not match the live ERC-8183 Commerce payment token.", paymentToken, quotedCurrency: quotedTerms.currency };
  }
  const record = {
    kind: "protocol_job",
    protocol: "ERC-8183",
    network: safety.network,
    runId: precommit.runId,
    agentIdentity: agent.identity,
    provider,
    budget: String(quotedTerms.price),
    paymentToken,
    quote: { negotiationHash: quote.negotiationHash || null, price: String(quotedTerms.price), currency: quotedTerms.currency, quoteExpiresAt: quoteExpiresAt || null },
    precommitHash: precommit.manifestHash,
    state: "not_started",
    funded: false,
    events: [],
    createdAt: nowIso(),
  };
  const persist = async (event, extra = {}) => {
    record.events.push({ at: nowIso(), event, ...extra });
    if (extra.snapshot) record.currentState = extra.snapshot.status;
    await store.saveJson(`state/protocol-job-${precommit.runId}.json`, record);
  };
  try {
    const expiredAt = BigInt(precommit.deadlineAtUnixSeconds);
    const sdkErc8183 = await import("@bnbagent/sdk/erc8183");
    const quoteEnvelope = quote?.rawResponse?.result?.parts?.find((part) => part.kind === "data")?.data || null;
    if (!quoteEnvelope) throw new Error("The negotiated quote envelope is missing; refusing to create an unbound ERC-8183 job.");
    const description = sdkErc8183.buildJobDescription(quoteEnvelope);
    const descriptionHash = contentHashes(description).keccak256;
    const created = await buyer.client.createJob({ provider, expiredAt, description });
    if (created.jobId === null || created.jobId === undefined) throw new Error("ERC-8183 createJob returned no job ID.");
    record.jobId = String(created.jobId);
    record.state = "created";
    const createdSnapshot = await protocolSnapshot(buyer.client, created.jobId);
    record.precommitBinding = { level: "ONCHAIN_SIGNED_QUOTE_BOUND_PRECOMMIT", method: "ERC-8183 job.description", manifestHash: precommit.manifestHash, signedQuoteDescriptionHash: descriptionHash };
    await persist("create_job", { tx: txShape(created), snapshot: createdSnapshot, precommitBinding: record.precommitBinding });
    const registered = await buyer.client.registerJob(created.jobId);
    await persist("register_job", { tx: txShape(registered), snapshot: await protocolSnapshot(buyer.client, created.jobId) });
    const budget = BigInt(quotedTerms.price);
    const budgetSet = await buyer.client.setBudget(created.jobId, budget);
    await persist("set_budget", { tx: txShape(budgetSet), snapshot: await protocolSnapshot(buyer.client, created.jobId), budget: budget.toString() });
    const fundStartBlock = await buyer.client.publicClient.getBlockNumber();
    const funded = await buyer.client.fund(created.jobId, budget, { approveFloor: 0n });
    const fundReceiptBlock = funded.receipt?.blockNumber === undefined || funded.receipt?.blockNumber === null ? await buyer.client.publicClient.getBlockNumber() : BigInt(funded.receipt.blockNumber);
    try {
      const approvalEvent = parseAbiItem("event Approval(address indexed owner,address indexed spender,uint256 value)");
      const approvals = await buyer.client.publicClient.getLogs({ address: paymentToken, event: approvalEvent, args: { owner: buyer.wallet.address }, fromBlock: fundStartBlock, toBlock: fundReceiptBlock });
      const seen = new Set();
      for (const approval of approvals) {
        if (seen.has(approval.transactionHash)) continue;
        seen.add(approval.transactionHash);
        const receipt = await buyer.client.publicClient.getTransactionReceipt({ hash: approval.transactionHash });
        await persist("approve_payment_token", { automatic: true, spender: approval.args.spender, value: String(approval.args.value), tx: txShape({ transactionHash: approval.transactionHash, status: receipt.status === "success" ? 1 : 0, receipt }) });
      }
    } catch (error) {
      await persist("approval_observation_error", { error: safeError(error) });
    }
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

export async function appendProtocolEvent({ store, runId, event, extra = {} }) {
  const relativePath = `state/protocol-job-${runId}.json`;
  const record = await store.loadJson(relativePath, null);
  if (!record) throw new Error(`Protocol job record not found for ${runId}.`);
  record.events.push({ at: nowIso(), event, ...extra });
  if (extra.snapshot) record.currentState = extra.snapshot.status || record.currentState;
  await store.saveJson(relativePath, record);
  return record;
}

export async function readJob({ client, jobId }) {
  return protocolSnapshot(client, jobId);
}

export const IPFS_GATEWAYS = Object.freeze(["https://gateway.pinata.cloud/ipfs/", "https://ipfs.io/ipfs/", "https://dweb.link/ipfs/", "https://cloudflare-ipfs.com/ipfs/"]);

/**
 * Resolve a deliverable reference to fetchable HTTP candidates. An `ipfs://`
 * reference stays content-addressed: the CID is preserved and only the gateway
 * varies, so retrieval never depends on the provider's own server.
 */
export function deliverableFetchCandidates(reference) {
  const value = String(reference || "");
  if (/^ipfs:\/\//i.test(value)) {
    const cidPath = value.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    return { scheme: "ipfs", cid: cidPath.split("/")[0], contentAddressed: true, candidates: IPFS_GATEWAYS.map((gateway) => `${gateway}${cidPath}`) };
  }
  if (isPublicHttpUrl(value)) return { scheme: "https", cid: null, contentAddressed: false, candidates: [value] };
  return { scheme: "unsupported", cid: null, contentAddressed: false, candidates: [] };
}

export async function fetchDeliverable(reference, { timeoutMs = 30_000 } = {}) {
  const resolved = deliverableFetchCandidates(reference);
  const attempts = [];
  for (const candidate of resolved.candidates) {
    try {
      const response = await requestJson(candidate, { timeoutMs });
      attempts.push({ url: candidate, status: response.status, ok: response.ok });
      if (response.ok && response.body !== undefined && response.body !== null) return { ...resolved, ok: true, url: candidate, response, attempts };
    } catch (error) {
      attempts.push({ url: candidate, error: safeError(error) });
    }
  }
  return { ...resolved, ok: false, url: null, response: null, attempts };
}
