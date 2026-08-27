import { decodeFunctionData, parseAbi } from "viem";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "./constants.mjs";

export const ALTANA_NETWORK = "BNB_TESTNET";
export const ALTANA_SUPPORTED_CHAIN_ID = REFERENCE_CHAIN_ID;

const ERC8183_ABI = parseAbi([
  "function createJob(address provider,address evaluator,uint256 expiredAt,string description,address hook)",
  "function setBudget(uint256 jobId,uint256 amount)",
  "function fund(uint256 jobId,uint256 expectedBudget,bytes optParams)",
  "function claimRefund(uint256 jobId)",
  "function registerJob(uint256 jobId,address policy)",
  "function settle(uint256 jobId,bytes evidence)",
  "function markExpired(uint256 jobId)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender,uint256 amount)"]);

function validAddress(value) { return /^0x[0-9a-fA-F]{40}$/.test(String(value || "")); }

export function buildAltanaSessionPolicy({ commerceAddress, routerAddress, paymentToken = REFERENCE_PAYMENT_TOKEN, maxSpendRaw = "0", expiry, includeSettlement = false } = {}) {
  if (!validAddress(commerceAddress) || !validAddress(routerAddress) || !validAddress(paymentToken)) throw new Error("Altana policy requires explicit commerce, router, and payment-token addresses.");
  if (!Number.isInteger(Number(expiry)) || Number(expiry) <= Math.floor(Date.now() / 1000)) throw new Error("Altana session expiry must be a future Unix timestamp.");
  const calls = [
    { to: commerceAddress, signature: "createJob(address,address,uint256,string,address)" },
    { to: commerceAddress, signature: "setBudget(uint256,uint256)" },
    { to: commerceAddress, signature: "fund(uint256,uint256,bytes)" },
    { to: commerceAddress, signature: "claimRefund(uint256)" },
    { to: routerAddress, signature: "registerJob(uint256,address)" },
    { to: routerAddress, signature: "markExpired(uint256)" },
  ];
  if (includeSettlement) calls.push({ to: routerAddress, signature: "settle(uint256,bytes)" });
  return {
    network: ALTANA_NETWORK,
    networkAlias: REFERENCE_NETWORK,
    chainId: REFERENCE_CHAIN_ID,
    expiry: Number(expiry),
    permissions: {
      calls,
      spend: [{ limit: BigInt(maxSpendRaw), period: "day", token: paymentToken }],
    },
    notes: ["Approval is deliberately excluded from the session; the buyer must pre-approve only the exact Commerce contract for the bounded amount.", "No calls array omission is permitted; omission would mean unrestricted calls.", "No mainnet network is accepted."],
  };
}

function allowedSignature(abi, data) {
  try {
    const decoded = decodeFunctionData({ abi, data });
    const item = abi.find((entry) => entry.type === "function" && entry.name === decoded.functionName);
    return item ? `${item.name}(${item.inputs.map((input) => input.type).join(",")})` : null;
  } catch { return null; }
}

export function validateAltanaSessionPolicy(policy, { nowSeconds = Math.floor(Date.now() / 1000), expectedChainId = REFERENCE_CHAIN_ID } = {}) {
  const errors = [];
  if (Number(policy?.chainId) !== expectedChainId || policy?.network !== ALTANA_NETWORK) errors.push("wrong_altana_testnet");
  if (Number(policy?.expiry) <= nowSeconds) errors.push("expired_session");
  if (!Array.isArray(policy?.permissions?.calls) || policy.permissions.calls.length === 0) errors.push("explicit_call_allowlist_required");
  if (!Array.isArray(policy?.permissions?.spend) || policy.permissions.spend.length !== 1) errors.push("one_bounded_spend_cap_required");
  for (const call of policy?.permissions?.calls || []) {
    if (!validAddress(call.to) || typeof call.signature !== "string" || !call.signature.includes("(")) errors.push("malformed_call_permission");
  }
  const spend = policy?.permissions?.spend?.[0];
  if (spend) {
    try {
      if (BigInt(spend.limit) < 0n || !validAddress(spend.token) || spend.period !== "day") errors.push("malformed_spend_permission");
    } catch { errors.push("malformed_spend_permission"); }
  }
  return { valid: errors.length === 0, errors };
}

export function validateAltanaCall({ policy, to, data, value = 0n } = {}) {
  const errors = [];
  if (!validAddress(to)) errors.push("call_target_invalid");
  const signature = allowedSignature([...ERC8183_ABI, ...ERC20_ABI], data);
  const match = policy?.permissions?.calls?.some((call) => call.to.toLowerCase() === String(to).toLowerCase() && call.signature === signature) || false;
  if (!match) errors.push("call_not_allowlisted");
  try { if (BigInt(value) < 0n) errors.push("negative_value"); } catch { errors.push("value_invalid"); }
  return { valid: errors.length === 0, errors, signature };
}

export async function altanaAvailability() {
  try {
    const sdk = await import("@altananetwork/sdk");
    return { installed: true, package: "@altananetwork/sdk", version: sdk.VERSION || null, network: ALTANA_NETWORK, chainId: REFERENCE_CHAIN_ID };
  } catch {
    return { installed: false, package: "@altananetwork/sdk", network: ALTANA_NETWORK, chainId: REFERENCE_CHAIN_ID, reason: "Optional Altana SDK is not installed; no session write is available." };
  }
}

export async function officialErc8183Addresses() {
  const sdk = await import("@bnbagent/sdk/erc8183");
  const network = sdk.resolveErc8183Network(REFERENCE_NETWORK);
  if (Number(network.chainId) !== REFERENCE_CHAIN_ID) throw new Error("Official ERC-8183 deployment metadata did not resolve to BSC testnet chain 97.");
  return { network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, commerceAddress: network.commerceContract, routerAddress: network.routerContract, registryAddress: network.registryContract, policyAddress: network.policyContract };
}

export class AltanaAuthorityProvider {
  constructor({ nowSeconds = () => Math.floor(Date.now() / 1000), grantSession = null, execute = null, revokeSession = null } = {}) {
    this.nowSeconds = nowSeconds;
    this.grantSessionFn = grantSession;
    this.executeFn = execute;
    this.revokeSessionFn = revokeSession;
  }

  prepare(options = {}) {
    const policy = buildAltanaSessionPolicy(options);
    const validation = validateAltanaSessionPolicy(policy, { nowSeconds: this.nowSeconds() });
    if (!validation.valid) throw new Error(`Altana policy rejected: ${validation.errors.join(", ")}`);
    return { status: "prepared", policy, validation, userConfirmationRequired: true };
  }

  inspect(session) {
    const policy = { network: ALTANA_NETWORK, chainId: REFERENCE_CHAIN_ID, expiry: session?.expiry, permissions: session?.permissions };
    return { ...validateAltanaSessionPolicy(policy, { nowSeconds: this.nowSeconds() }), walletAddress: session?.walletAddress || null, publicKey: session?.publicKey || null, expiry: session?.expiry || null };
  }

  async grant({ policy, confirmed = false } = {}) {
    if (!confirmed) throw new Error("Altana session grant requires explicit operator confirmation.");
    if (typeof this.grantSessionFn !== "function") throw new Error("Altana SDK grantSession is not configured; no session write was attempted.");
    return this.grantSessionFn({ permissions: policy.permissions, expiry: policy.expiry, register: true });
  }

  async execute({ policy, to, data, value = 0n, session = null } = {}) {
    if (session) {
      const sessionCheck = this.inspect(session);
      if (!sessionCheck.valid) throw new Error(`Altana session rejected: ${sessionCheck.errors.join(", ")}`);
    }
    const allowed = validateAltanaCall({ policy, to, data, value });
    if (!allowed.valid) throw new Error(`Altana call rejected: ${allowed.errors.join(", ")}`);
    if (typeof this.executeFn !== "function") throw new Error("Altana SDK execute is not configured; no session write was attempted.");
    return this.executeFn({ calls: [{ to, data, value }], session });
  }

  async revoke({ publicKey, confirmed = false } = {}) {
    if (!confirmed) throw new Error("Altana session revocation requires explicit operator confirmation.");
    if (!publicKey) throw new Error("Altana session public key is required for revocation.");
    if (typeof this.revokeSessionFn !== "function") throw new Error("Altana SDK revokeSession is not configured; no revocation write was attempted.");
    return this.revokeSessionFn({ publicKey });
  }
}

export async function createOfficialAltanaAuthority({ wallet, signer } = {}) {
  if (!wallet || !signer) throw new Error("Official Altana authority requires an admin wallet and signer; no session write was attempted.");
  const sdk = await import("@altananetwork/sdk");
  if (Number(sdk.BNB_TESTNET?.chainId) !== REFERENCE_CHAIN_ID) throw new Error("Altana BNB_TESTNET did not resolve to chain 97.");
  const client = sdk.createClient({ chains: [sdk.BNB_TESTNET], defaultChainId: REFERENCE_CHAIN_ID });
  const authority = new AltanaAuthorityProvider({
    grantSession: ({ permissions, expiry, register }) => client.grantSession({ wallet, signer, chainId: REFERENCE_CHAIN_ID, permissions, expiry, register }),
    execute: ({ calls, session }) => {
      if (!session) throw new Error("Altana session object is required for session execution; no write was attempted.");
      return client.execute({ session, calls, chainId: REFERENCE_CHAIN_ID });
    },
    revokeSession: ({ publicKey }) => client.revokeSession({ wallet, signer, chainId: REFERENCE_CHAIN_ID, session: publicKey }),
  });
  return { client, authority, network: ALTANA_NETWORK, chainId: REFERENCE_CHAIN_ID };
}
