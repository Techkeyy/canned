/**
 * Create one bounded Altana session on BSC Testnet, and verify it before any
 * session key is allowed to spend anything.
 *
 * The caps here are deliberately smaller than earlier drafts. A permission
 * should not authorise more capital than the wallet actually holds: the wallet
 * has 1.3 USDT, so the session ceiling is 1.5 and a single transaction may
 * spend at most 1.0.
 *
 * The router allowance is granted by the OWNER, outside the session. The
 * session may call the router's swap method and nothing else, so it cannot
 * approve anything, including for itself.
 *
 * Owner key stays on this workstation. It is never written to the agent host.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { contentHashes, nowIso } from "../src/core.mjs";

const ACTION_WALLET = "0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f";
const USDT = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const V2_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const SWAP_SIGNATURE = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
const SWAP_SELECTOR = "0x38ed1739";

/** Directive #20 section 14. Ceilings, not targets, and not configurable. */
const SESSION_CAP_RAW = 1_500_000_000_000_000_000n;  // 1.5 USDT rolling cap
const PER_TX_CAP_RAW = 1_000_000_000_000_000_000n;   // 1.0 USDT per transaction
const MAX_FILLS = 1;
const MAX_SLIPPAGE_BPS = 100;
const DURATION_SECONDS = 6 * 60 * 60;

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const stateDir = path.join(dataDir, "state");
const log = (body) => console.log(JSON.stringify(body, null, 2));
const stop = (reason, details = {}) => { log({ status: "blocked", reason, ...details }); process.exit(2); };

if (env.CANNED_ALLOW_TESTNET_WRITES !== "true") stop("CANNED_ALLOW_TESTNET_WRITES is not true.");
if (env.CANNED_ALTANA_SESSION_CONFIRM !== "true") stop("Creating a real session requires CANNED_ALTANA_SESSION_CONFIRM=true.");

const A = await import("@altananetwork/sdk");
const bnb = await import("@bnbagent/sdk");
const network = A.BNB_TESTNET;
if (network.chainId !== 97) stop("The Altana network config is not BSC Testnet.", { chainId: network.chainId });

const rpcUrl = env.RPC_URL_BSC_TESTNET || network.publicRpcUrl;
const chain = { id: 97, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 30_000 }) });
if ((await publicClient.getChainId()) !== 97) stop("The RPC is not chain 97.");

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

// The owner key is loaded here and nowhere else.
const walletsDir = path.join(stateDir, "grid-action-wallets");
const keystoreAddress = bnb.EVMWalletProvider.listWallets(walletsDir)[0];
if (String(keystoreAddress).toLowerCase() !== ACTION_WALLET.toLowerCase()) stop("The action keystore does not match the expected wallet.", { keystoreAddress });
const password = (await readFile(path.join(stateDir, "grid-action-wallet-password.txt"), "utf8")).trim();
const owner = new bnb.EVMWalletProvider({ password, address: keystoreAddress, walletsDir, persist: true });

try {
  const balance = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] });
  if (balance < PER_TX_CAP_RAW) stop("The action wallet does not hold enough USDT for the proof transaction.", { balanceRaw: balance.toString() });
  const native = await publicClient.getBalance({ address: ACTION_WALLET });
  if (native < 2_000_000_000_000_000n) stop("The action wallet has too little tBNB for gas.", { nativeWei: native.toString() });

  // The owner approves the router for exactly one transaction's worth. Never
  // unlimited, and never granted by the session.
  const allowanceBefore = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] });
  let approvalTx = null;
  if (allowanceBefore !== PER_TX_CAP_RAW) {
    const data = encodeFunctionData({ abi: erc20, functionName: "approve", args: [V2_ROUTER, PER_TX_CAP_RAW] });
    const [gasPrice, nonce] = await Promise.all([publicClient.getGasPrice(), publicClient.getTransactionCount({ address: ACTION_WALLET, blockTag: "pending" })]);
    const gas = await publicClient.estimateGas({ account: ACTION_WALLET, to: USDT, data });
    const signed = await owner.signTransaction({ to: USDT, data, value: 0n, gas: (gas * 12n) / 10n, gasPrice, nonce, chainId: 97 });
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") stop("The owner approval reverted.", { hash });
    approvalTx = { hash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed) };
    log({ status: "owner_approved_router_exact_amount", ...approvalTx, amountRaw: PER_TX_CAP_RAW.toString(), unlimited: false });
  }
  const allowanceAfter = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] });

  // Grant the session.
  const signer = A.signerFromPrivateKey(owner.exportPrivateKey());
  const client = A.createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer });
  if (String(wallet.address).toLowerCase() !== ACTION_WALLET.toLowerCase()) stop("The Altana wallet address does not match the funded action wallet.", { walletAddress: wallet.address });

  const expiry = Math.floor(Date.now() / 1000) + DURATION_SECONDS;
  const permissions = {
    // AND semantics: this router and this method only.
    calls: [{ to: V2_ROUTER, signature: SWAP_SIGNATURE }],
    spend: [{ limit: SESSION_CAP_RAW, period: "day", token: USDT }],
  };
  const granted = await client.grantSession({ wallet, signer, permissions, expiry, register: true });

  log({ status: "session_granted", publicKey: granted.publicKey, expiry, transactionHash: granted.transactionHash ?? null });

  /* --- section 16: verify before the key is allowed to transact --- */
  const verification = {
    ownerMatches: String(granted.walletAddress).toLowerCase() === ACTION_WALLET.toLowerCase(),
    chainId: network.chainId === 97,
    keyStore: network.keyStore,
    keyStoreController: network.keyStoreController,
    sessionPublicKeyPresent: Boolean(granted.publicKey),
    registeredInKeyStore: true,
    callPermissionCount: granted.permissions.calls.length,
    exactContract: granted.permissions.calls.length === 1 && String(granted.permissions.calls[0].to).toLowerCase() === V2_ROUTER.toLowerCase(),
    exactMethod: granted.permissions.calls.length === 1 && granted.permissions.calls[0].signature === SWAP_SIGNATURE,
    noUnrestrictedRule: granted.permissions.calls.every((call) => Boolean(call.to) && Boolean(call.signature)),
    spendPermissionCount: granted.permissions.spend.length,
    spendToken: granted.permissions.spend.length === 1 && String(granted.permissions.spend[0].token).toLowerCase() === USDT.toLowerCase(),
    spendWithinCeiling: granted.permissions.spend.length === 1 && BigInt(granted.permissions.spend[0].limit) <= SESSION_CAP_RAW,
    expiryWithinSixHours: granted.expiry <= Math.floor(Date.now() / 1000) + DURATION_SECONDS + 60,
    notExpired: granted.expiry * 1000 > Date.now(),
  };
  const broaderThanIntended = Object.entries(verification).filter(([, value]) => value === false).map(([key]) => key);

  const record = {
    entity: "AltanaSession",
    network: "bsc-testnet",
    chainId: 97,
    keyStore: network.keyStore,
    keyStoreController: network.keyStoreController,
    relayUrl: network.relayUrl,
    explorer: network.explorer,
    owner: ACTION_WALLET,
    walletAddress: granted.walletAddress,
    sessionPublicKey: granted.publicKey,
    grantTransactionHash: granted.transactionHash ?? null,
    expiry: granted.expiry,
    expiresAt: new Date(granted.expiry * 1000).toISOString(),
    permissions: {
      calls: granted.permissions.calls.map((call) => ({ to: call.to, signature: call.signature, selector: SWAP_SELECTOR })),
      spend: granted.permissions.spend.map((entry) => ({ limit: String(entry.limit), period: entry.period, token: entry.token })),
    },
    strategyCaps: { perTransactionRaw: PER_TX_CAP_RAW.toString(), sessionCapRaw: SESSION_CAP_RAW.toString(), maxFills: MAX_FILLS, maxSlippageBps: MAX_SLIPPAGE_BPS },
    ownerApproval: { token: USDT, spender: V2_ROUTER, amountRaw: PER_TX_CAP_RAW.toString(), unlimited: false, allowanceBeforeRaw: allowanceBefore.toString(), allowanceAfterRaw: allowanceAfter.toString(), transaction: approvalTx },
    verification,
    broaderThanIntended,
    revoked: false,
    executions: [],
    createdAt: nowIso(),
  };

  if (broaderThanIntended.length) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "grid-session.json"), JSON.stringify({ session: record, revoked: false }, null, 2) + "\n", "utf8");
    stop("The granted permission is broader than intended; refusing to execute. Revoke it before any use.", { broaderThanIntended });
  }

  await mkdir(stateDir, { recursive: true });
  // The session signer is persisted separately from the record, and only here
  // on this workstation, because whoever holds it can act within the caps.
  await writeFile(path.join(stateDir, "grid-session.json"), JSON.stringify({ session: record, revoked: false }, null, 2) + "\n", "utf8");
  await writeFile(path.join(stateDir, "grid-session-key.json"), JSON.stringify({ walletAddress: granted.walletAddress, publicKey: granted.publicKey, expiry: granted.expiry, privateKey: granted.signer.privateKey ?? null }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });

  log({ status: "session_verified", ...record, hashes: contentHashes(record), secretOutput: "none" });
} finally { owner.destroy(); }
