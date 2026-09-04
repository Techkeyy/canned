import { createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http, keccak256, parseAbi, toHex } from "viem";
import { bscTestnet } from "viem/chains";
import { contentHashes, nowIso, safeError } from "../core.mjs";
import { officialErc8183Addresses } from "../reference/altana.mjs";

/**
 * Non-custodial public-hire transaction layer.
 *
 * The buyer is always the user's own wallet. Canned never signs, never holds
 * a customer key, and never proxies an arbitrary transaction: the server
 * builds an exact, fully-specified action plan from its own verified quote
 * state, and independently verifies every transaction the wallet broadcasts.
 *
 * Function signatures below mirror the official Commerce/Router contracts
 * bundled in `@bnbagent/sdk` (verified against the shipped bundle ABI:
 * createJob(address,address,uint256,string,address),
 * setBudget(uint256,uint256,bytes), fund(uint256,uint256,bytes),
 * registerJob(uint256,address), claimRefund(uint256),
 * reject(uint256,bytes32,bytes), settle(uint256,bytes)).
 */

export const HIRE_CHAIN_ID = 97;

const COMMERCE_ABI = parseAbi([
  "function createJob(address provider, address evaluator, uint256 expiredAt, string description, address hook) returns (uint256 jobId)",
  "function setBudget(uint256 jobId, uint256 amount, bytes optParams)",
  "function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)",
  "function reject(uint256 jobId, bytes32 reason, bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function getJob(uint256 jobId) view returns (uint256 id, address client, address provider, address evaluator, string description, uint256 budget, uint256 expiredAt, uint8 status, address hook, bytes32 deliverable, uint256 submittedAt)",
  "event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook)",
  "event JobFunded(uint256 indexed jobId, address indexed client, address provider, uint256 amount)",
  "event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)",
]);

const ROUTER_ABI = parseAbi([
  "function registerJob(uint256 jobId, address policy)",
  "function settle(uint256 jobId, bytes evidence)",
  "function jobPolicy(uint256 jobId) view returns (address)",
]);

const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

const POLICY_ABI = parseAbi(["function disputeWindow() view returns (uint256)"]);

export const HIRE_ABIS = Object.freeze({ COMMERCE_ABI, ROUTER_ABI, ERC20_ABI, POLICY_ABI });

let addressesPromise = null;
export function hireAddresses() {
  if (!addressesPromise) addressesPromise = officialErc8183Addresses();
  return addressesPromise;
}

let publicClientPromise = null;
/** Read-only chain client. Never signs. RPC comes from env or the SDK preset. */
export function hirePublicClient() {
  if (!publicClientPromise) {
    publicClientPromise = (async () => {
      const sdk = await import("@bnbagent/sdk/erc8183");
      const network = sdk.resolveErc8183Network("bsc-testnet");
      const rpcUrl = process.env.CANNED_RPC_URL || process.env.RPC_URL || network.rpcUrl;
      return createPublicClient({ chain: bscTestnet, transport: http(rpcUrl, { timeout: 20_000 }) });
    })();
  }
  return publicClientPromise;
}

let readClientPromise = null;
/** SDK read-only client (no wallet): reads work, writes raise. */
export function hireReadClient() {
  if (!readClientPromise) {
    readClientPromise = (async () => {
      const { loadSdk } = await import("./erc8183-buyer.mjs");
      const sdk = await loadSdk();
      return sdk.ERC8183Client.create({ network: "bsc-testnet" });
    })();
  }
  return readClientPromise;
}

export function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

export function isTxHash(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(String(value || ""));
}

export function isIdempotencyKey(value) {
  return /^[A-Za-z0-9_-]{8,64}$/.test(String(value || ""));
}

/** Exact on-chain description for createJob, built from the signed quote. */
export async function hireJobDescription(quoteEnvelope) {
  const sdkErc8183 = await import("@bnbagent/sdk/erc8183");
  const description = sdkErc8183.buildJobDescription(quoteEnvelope);
  if (typeof description !== "string" || !description.length) {
    throw new Error("The negotiated quote envelope did not produce a job description.");
  }
  return { description, descriptionHash: contentHashes(description).keccak256 };
}

/**
 * Build the exact wallet action plan from server-owned quote state.
 *
 * Nothing here trusts client input: every address, amount, and byte string
 * comes from the verified quote and official deployments. `jobId` is filled
 * in after the create step mines (the client reports the receipt; the server
 * derives the job id from the JobCreated event and returns the remaining
 * steps bound to it).
 */
export async function buildHireTxPlan({ quote, buyer, allowanceSufficient = false, jobId = null }) {
  const addresses = await hireAddresses();
  const amount = BigInt(quote.amountRaw);
  const steps = [];
  if (!allowanceSufficient) {
    steps.push({
      kind: "approve",
      title: "Approve the exact job amount",
      purpose: `Allow the ERC-8183 Commerce contract to pull exactly ${quote.amountHuman} ${quote.tokenSymbol} for this job only. No unlimited approval.`,
      chainId: HIRE_CHAIN_ID,
      to: quote.token,
      value: "0",
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [addresses.commerceAddress, amount] }),
      token: quote.token,
      spender: addresses.commerceAddress,
      amount: quote.amountRaw,
    });
  }
  steps.push({
    kind: "create",
    title: "Create the ERC-8183 job",
    purpose: "Opens the job on chain with you as the buyer (client), the chosen provider, the quoted expiry, and the exact quoted terms.",
    chainId: HIRE_CHAIN_ID,
    to: addresses.commerceAddress,
    value: "0",
    data: encodeFunctionData({
      abi: COMMERCE_ABI,
      functionName: "createJob",
      args: [quote.provider, addresses.routerAddress, BigInt(quote.jobExpiredAt), quote.description, addresses.routerAddress],
    }),
    provider: quote.provider,
    evaluator: addresses.routerAddress,
    hook: addresses.routerAddress,
    jobExpiredAt: String(quote.jobExpiredAt),
    descriptionHash: quote.descriptionHash,
  });
  const jobRef = jobId === null ? "{jobId from the create receipt}" : String(jobId);
  for (const step of [
    {
      kind: "register",
      title: "Bind the settlement policy",
      purpose: "Registers the official policy on the Router so the job can settle after delivery. Client-only, single-shot.",
      contract: "router",
      functionName: "registerJob",
      argsNote: [jobRef, addresses.policyAddress],
    },
    {
      kind: "budget",
      title: "Set the exact job budget",
      purpose: `Locks the budget to exactly ${quote.amountHuman} ${quote.tokenSymbol}. Nothing more can be pulled.`,
      contract: "commerce",
      functionName: "setBudget",
      argsNote: [jobRef, quote.amountRaw],
    },
    {
      kind: "fund",
      title: "Fund the escrow",
      purpose: `Moves exactly ${quote.amountHuman} ${quote.tokenSymbol} into escrow. The provider is paid only on valid delivery.`,
      contract: "commerce",
      functionName: "fund",
      argsNote: [jobRef, quote.amountRaw],
    },
  ]) {
    const to = step.contract === "router" ? addresses.routerAddress : addresses.commerceAddress;
    steps.push({
      kind: step.kind,
      title: step.title,
      purpose: step.purpose,
      chainId: HIRE_CHAIN_ID,
      to,
      value: "0",
      jobId: jobId === null ? null : String(jobId),
      ...(step.functionName === "registerJob"
        ? { data: jobId === null ? null : encodeFunctionData({ abi: ROUTER_ABI, functionName: "registerJob", args: [BigInt(jobId), addresses.policyAddress] }) }
        : step.functionName === "setBudget"
          ? { data: jobId === null ? null : encodeFunctionData({ abi: COMMERCE_ABI, functionName: "setBudget", args: [BigInt(jobId), amount, "0x"] }) }
          : { data: jobId === null ? null : encodeFunctionData({ abi: COMMERCE_ABI, functionName: "fund", args: [BigInt(jobId), amount, "0x"] }) }),
      ...(step.functionName === "registerJob" ? { policy: addresses.policyAddress } : { amount: quote.amountRaw, token: quote.token }),
      requiresJobId: true,
    });
  }
  return {
    chainId: HIRE_CHAIN_ID,
    network: "bsc-testnet",
    buyer: buyer.toLowerCase(),
    commerce: addresses.commerceAddress,
    router: addresses.routerAddress,
    policy: addresses.policyAddress,
    paymentToken: quote.token,
    amount: quote.amountRaw,
    amountHuman: quote.amountHuman,
    tokenSymbol: quote.tokenSymbol,
    promptCount: steps.length,
    promptCountWithoutApproval: steps.length - (allowanceSufficient ? 0 : 1),
    allowanceSufficient,
    gasEstimate: {
      available: false,
      detail: "Your wallet shows the live network fee before each prompt; an exact total cannot be known until the create receipt supplies the job ID for later calls.",
    },
    steps,
    note: "Send each transaction from your own wallet, in order, waiting for each receipt. Report every transaction hash to Canned so it can verify the job independently.",
  };
}

/** Fetch and sanity-check a transaction receipt. Throws fail-closed. */
export async function verifiedReceipt(txHash) {
  if (!isTxHash(txHash)) throw new Error("Malformed transaction hash.");
  const publicClient = await hirePublicClient();
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (!receipt) throw new Error("Transaction receipt not found; it may still be pending.");
  if (receipt.status !== "success") throw new Error("Transaction reverted on chain.");
  const chainId = await publicClient.getChainId();
  if (chainId !== HIRE_CHAIN_ID) throw new Error(`Receipt is from chain ${chainId}; expected BSC testnet (97).`);
  const tx = await publicClient.getTransaction({ hash: txHash });
  return { receipt, tx };
}

/** Decode JobCreated from a create receipt; fails closed on any mismatch. */
export function decodeJobCreated(receipt, { commerce, buyer, provider }) {
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== String(commerce).toLowerCase()) continue;
    let decoded = null;
    try {
      decoded = decodeEventLog({ abi: COMMERCE_ABI, data: log.data, topics: log.topics });
    } catch { continue; }
    if (decoded?.eventName !== "JobCreated") continue;
    const jobId = decoded.args?.jobId;
    if (jobId === undefined || jobId === null) continue;
    const client = String(decoded.args.client || "").toLowerCase();
    const jobProvider = String(decoded.args.provider || "").toLowerCase();
    if (client !== String(buyer).toLowerCase()) throw new Error("Job client is not the expected buyer.");
    if (jobProvider !== String(provider).toLowerCase()) throw new Error("Job provider is not the quoted provider.");
    return { jobId: String(jobId), client, provider: jobProvider };
  }
  throw new Error("No JobCreated event from the Commerce contract in this receipt.");
}

/** Confirm an approval receipt covers at least the required amount. */
export function decodeApproval(receipt, { token, buyer, spender, required }) {
  for (const log of receipt.logs || []) {
    if (String(log.address).toLowerCase() !== String(token).toLowerCase()) continue;
    let decoded = null;
    try {
      decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics });
    } catch { continue; }
    if (decoded?.eventName !== "Approval") continue;
    if (String(decoded.args?.owner || "").toLowerCase() !== String(buyer).toLowerCase()) continue;
    if (String(decoded.args?.spender || "").toLowerCase() !== String(spender).toLowerCase()) continue;
    if (BigInt(decoded.args.value) < BigInt(required)) {
      throw new Error("Approval amount is below the quoted job amount.");
    }
    return { approved: String(decoded.args.value) };
  }
  throw new Error("No sufficient Approval event for the Commerce spender in this receipt.");
}

/** Authoritative on-chain job read. */
export async function readHireJob(jobId) {
  const client = await hireReadClient();
  const job = await client.getJob(BigInt(jobId));
  return {
    id: String(job.id),
    client: String(job.client).toLowerCase(),
    provider: String(job.provider).toLowerCase(),
    evaluator: String(job.evaluator),
    description: job.description,
    descriptionHash: contentHashes(job.description).keccak256,
    budget: String(job.budget),
    expiredAt: String(job.expiredAt),
    statusCode: Number(job.status),
    status: ["OPEN", "FUNDED", "SUBMITTED", "COMPLETED", "REJECTED", "EXPIRED"][Number(job.status)] || "UNKNOWN",
    hook: String(job.hook),
    deliverable: String(job.deliverable),
    submittedAt: String(job.submittedAt),
  };
}

/** Decode a wallet-submitted calldata and name the function. Fails closed. */
export function decodeHireCall(data) {
  for (const abi of [COMMERCE_ABI, ROUTER_ABI, ERC20_ABI]) {
    try {
      const decoded = decodeFunctionData({ abi, data });
      return { functionName: decoded.functionName, args: decoded.args };
    } catch { /* try the next ABI */ }
  }
  throw new Error("Transaction calldata is not a recognized hire action.");
}

export const ZERO_REASON = "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Available post-creation buyer actions for a given chain state. */
export async function availableHireActions({ job, quote }) {
  const addresses = await hireAddresses();
  const actions = [];
  if (job.status === "OPEN") {
    actions.push({
      kind: "cancel",
      title: "Cancel the open job",
      purpose: "Cancels the job before any escrow moved. No funds at risk.",
      chainId: HIRE_CHAIN_ID,
      to: addresses.commerceAddress,
      value: "0",
      data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "reject", args: [BigInt(job.id), ZERO_REASON, "0x"] }),
    });
  }
  if (job.status === "EXPIRED") {
    actions.push({
      kind: "refund",
      title: "Claim the refund",
      purpose: "The job expired; the escrowed amount returns to your wallet. Anyone may submit this.",
      chainId: HIRE_CHAIN_ID,
      to: addresses.commerceAddress,
      value: "0",
      data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "claimRefund", args: [BigInt(job.id)] }),
    });
  }
  if (job.status === "SUBMITTED") {
    actions.push({
      kind: "settle",
      title: "Settle after the dispute window",
      purpose: "Permissionless settlement once the policy dispute window has passed.",
      chainId: HIRE_CHAIN_ID,
      to: addresses.routerAddress,
      value: "0",
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "settle", args: [BigInt(job.id), "0x"] }),
    });
  }
  return actions;
}

/** Map the authoritative chain state to the product lifecycle state. */
export function hireLifecycleFrom({ chainStatus, notifyState, deliverableValid, refundable }) {
  if (chainStatus === "COMPLETED") return "COMPLETED";
  if (chainStatus === "REJECTED") return "REJECTED";
  if (chainStatus === "EXPIRED") return refundable ? "REFUND_AVAILABLE" : "TIMED_OUT";
  if (chainStatus === "SUBMITTED") return deliverableValid === true ? "DELIVERED" : "DELIVERY_PENDING";
  if (chainStatus === "FUNDED") return notifyState === "notified" ? "IN_PROGRESS" : "PROVIDER_NOTIFIED";
  return "FUNDED";
}

export async function tokenMeta(token) {
  const publicClient = await hirePublicClient();
  const [decimals, balance] = await Promise.all([
    publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
    null,
  ]);
  return { decimals: Number(decimals), balance };
}

export function formatUnits(raw, decimals) {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = String(value % base).padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : String(whole);
}

export function quoteError(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

export async function disputeWindowSeconds() {
  const publicClient = await hirePublicClient();
  const addresses = await hireAddresses();
  const window = await publicClient.readContract({ address: addresses.policyAddress, abi: POLICY_ABI, functionName: "disputeWindow" });
  return Number(window);
}

export { nowIso, safeError, toHex };
