/**
 * Acquire the exact BSC Testnet USDT the Altana execution proof needs, and
 * move the proof amount to the action wallet.
 *
 * The buyer does the acquiring. Keeping that separate from the action wallet
 * means the wallet whose capital a session key may spend never has to hold a
 * swap approval or run a router itself.
 *
 * Every approval is for an exact amount and is driven back to zero afterwards.
 * A leftover allowance on a router is standing permission nobody is watching.
 */
import path from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { contentHashes, nowIso } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { loadSdk, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK } from "../src/reference/constants.mjs";
import { sdkRpcEnvironment } from "../src/deploy/rpc-capability.mjs";

const USDT = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const V2_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const EXPECTED_BUYER = "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB";
const ACTION_WALLET = "0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f";

/** Directive #20 section 9: total input ceiling. Not configurable. */
const MAX_INPUT_WEI = 120_000_000_000_000_000n;   // 0.12 tBNB
const TARGET_USDT = 1_500_000_000_000_000_000n;   // 1.5
const MINIMUM_USDT = 1_200_000_000_000_000_000n;  // 1.2
const TRANSFER_TO_ACTION = 1_300_000_000_000_000_000n; // 1.3, inside the 1.2-1.5 band
const MAX_SLIPPAGE_BPS = 100n;

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const log = (body) => console.log(JSON.stringify(body, null, 2));
let wallet = null;
const stop = (reason, details = {}) => { log({ status: "blocked", reason, ...details }); wallet?.destroy(); process.exit(2); };

const sdk = await loadSdk();
const safety = writeSafety(env);
if (safety.network !== REFERENCE_NETWORK) stop("Only BSC Testnet is authorized.", { network: safety.network });
if (!safety.writesRequested) stop("CANNED_ALLOW_TESTNET_WRITES is not true; nothing was attempted.");
if (String(env.CANNED_EXECUTION_WALLET_ADDRESS).toLowerCase() !== EXPECTED_BUYER.toLowerCase()) stop("The configured wallet is not the Canned buyer.");

const rpcEnvironment = sdkRpcEnvironment(env, REFERENCE_NETWORK);
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcEnvironment.effectiveRpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcEnvironment.effectiveRpcUrl, { timeout: 30_000 }) });
const chainId = await publicClient.getChainId();
if (chainId !== REFERENCE_CHAIN_ID) stop(`Refusing to act on chain ${chainId}.`);

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const wbnbAbi = parseAbi(["function deposit() payable", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"]);
const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);

// The token must be the exact configured contract, checked by address and by
// what it reports about itself. A symbol match is not identification.
const [usdtSymbol, usdtDecimals] = await Promise.all([
  publicClient.readContract({ address: USDT, abi: erc20, functionName: "symbol" }),
  publicClient.readContract({ address: USDT, abi: erc20, functionName: "decimals" }),
]);
if (usdtSymbol !== "USDT" || Number(usdtDecimals) !== 18) stop("The configured USDT contract does not report the expected symbol and decimals.", { usdtSymbol, usdtDecimals });

wallet = new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });

/**
 * Sign and broadcast one transaction. The wallet provider only signs, so gas
 * and nonce are established here and the raw transaction is sent explicitly.
 * Each call waits for its receipt before the next, because these steps are
 * strictly ordered: an approval that has not landed cannot be swapped against.
 */
async function send(label, { to, data, value = 0n }) {
  const [gasPrice, nonce] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient.getTransactionCount({ address: wallet.address, blockTag: "pending" }),
  ]);
  const gas = await publicClient.estimateGas({ account: wallet.address, to, data, value });
  const signed = await wallet.signTransaction({ to, data, value, gas: (gas * 12n) / 10n, gasPrice, nonce, chainId: REFERENCE_CHAIN_ID });
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  const gasCostWei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0n);
  log({ status: label, transactionHash: hash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), gasCostWei: String(gasCostWei) });
  return { hash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), gasCostWei: String(gasCostWei) };
}
try {
  const { encodeFunctionData } = await import("viem");
  const enc = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args });

  // How much WBNB buys the target, priced against live reserves right now.
  let low = 0n;
  let high = MAX_INPUT_WEI;
  for (let i = 0; i < 44; i += 1) {
    const mid = (low + high) / 2n;
    const out = await publicClient.readContract({ address: V2_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [mid, [WBNB, USDT]] }).catch(() => null);
    if (!out || out[out.length - 1] < TARGET_USDT) low = mid; else high = mid;
  }
  const amountIn = high;
  const quoted = await publicClient.readContract({ address: V2_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [amountIn, [WBNB, USDT]] });
  const expectedOut = quoted[quoted.length - 1];
  const minOut = (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;

  if (amountIn > MAX_INPUT_WEI) stop("The required input exceeds the 0.12 tBNB ceiling.", { amountIn: amountIn.toString() });
  if (expectedOut < MINIMUM_USDT) stop("0.12 tBNB cannot produce the 1.2 USDT minimum; refusing to spend.", { expectedOut: expectedOut.toString() });

  const nativeBefore = await publicClient.getBalance({ address: wallet.address });
  if (nativeBefore < amountIn + 20_000_000_000_000_000n) stop("The buyer does not hold enough tBNB for the swap plus gas.", { nativeBefore: nativeBefore.toString() });

  const usdtBefore = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [wallet.address] });
  const actionUsdtBefore = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] });

  log({
    status: "acquisition_preflight", chainId,
    router: V2_ROUTER, path: [WBNB, USDT],
    amountInWei: amountIn.toString(), amountInTBNB: (Number(amountIn) / 1e18).toFixed(6),
    expectedOutRaw: expectedOut.toString(), expectedOutUsdt: (Number(expectedOut) / 1e18).toFixed(4),
    minOutRaw: minOut.toString(), slippageBps: Number(MAX_SLIPPAGE_BPS),
    ceilingWei: MAX_INPUT_WEI.toString(), withinCeiling: amountIn <= MAX_INPUT_WEI,
    buyerUsdtBefore: usdtBefore.toString(), actionUsdtBefore: actionUsdtBefore.toString(),
  });

  // 1. Wrap exactly what the swap needs.
  const wrap = await send("wrapped_tbnb", { to: WBNB, data: enc(wbnbAbi, "deposit", []), value: amountIn });

  // 2. Approve the router for exactly this swap. Never unlimited.
  const approve = await send("approved_router_exact_amount", { to: WBNB, data: enc(wbnbAbi, "approve", [V2_ROUTER, amountIn]) });

  // 3. Swap.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const swap = await send("swapped_wbnb_for_usdt", { to: V2_ROUTER, data: enc(routerAbi, "swapExactTokensForTokens", [amountIn, minOut, [WBNB, USDT], wallet.address, deadline]) });

  const usdtAfterSwap = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [wallet.address] });
  const received = usdtAfterSwap - usdtBefore;
  if (received < MINIMUM_USDT) stop("The swap produced less than the 1.2 USDT minimum.", { received: received.toString() });

  // 4. Drive the router allowance back to zero. A residual approval is
  //    standing permission on a contract nobody is watching.
  const residualBefore = await publicClient.readContract({ address: WBNB, abi: wbnbAbi, functionName: "allowance", args: [wallet.address, V2_ROUTER] });
  let zeroed = null;
  if (residualBefore > 0n) zeroed = await send("router_allowance_zeroed", { to: WBNB, data: enc(wbnbAbi, "approve", [V2_ROUTER, 0n]) });
  const residualAfter = await publicClient.readContract({ address: WBNB, abi: wbnbAbi, functionName: "allowance", args: [wallet.address, V2_ROUTER] });

  // 5. Move only the proof amount to the action wallet.
  const toTransfer = received < TRANSFER_TO_ACTION ? received : TRANSFER_TO_ACTION;
  const transfer = await send("transferred_usdt_to_action_wallet", { to: USDT, data: enc(erc20, "transfer", [ACTION_WALLET, toTransfer]) });

  const [buyerUsdtFinal, actionUsdtFinal, nativeAfter, actionNative] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [wallet.address] }),
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.getBalance({ address: wallet.address }),
    publicClient.getBalance({ address: ACTION_WALLET }),
  ]);

  const record = {
    kind: "testnet_usdt_acquisition",
    schemaVersion: 1,
    network: REFERENCE_NETWORK, chainId,
    token: { address: USDT, symbol: usdtSymbol, decimals: Number(usdtDecimals) },
    route: { venue: "PancakeSwap V2", router: V2_ROUTER, path: [WBNB, USDT], selector: "0x38ed1739" },
    input: { amountInWei: amountIn.toString(), amountInTBNB: (Number(amountIn) / 1e18).toFixed(6), ceilingWei: MAX_INPUT_WEI.toString() },
    output: { expectedRaw: expectedOut.toString(), minOutRaw: minOut.toString(), receivedRaw: received.toString(), receivedUsdt: (Number(received) / 1e18).toFixed(6) },
    transactions: { wrap, approve, swap, allowanceZeroed: zeroed, transfer },
    approvals: { grantedRaw: amountIn.toString(), unlimited: false, residualBeforeRaw: residualBefore.toString(), residualAfterRaw: residualAfter.toString() },
    transferredToActionRaw: toTransfer.toString(),
    balances: {
      buyerUsdtBeforeRaw: usdtBefore.toString(), buyerUsdtAfterRaw: buyerUsdtFinal.toString(),
      actionUsdtBeforeRaw: actionUsdtBefore.toString(), actionUsdtAfterRaw: actionUsdtFinal.toString(),
      buyerNativeBeforeWei: nativeBefore.toString(), buyerNativeAfterWei: nativeAfter.toString(),
      actionNativeWei: actionNative.toString(),
    },
    mainnetWrite: false,
    acquiredAt: nowIso(),
  };
  const evidence = await store.saveEvidence(record);
  await store.saveJson("state/testnet-usdt-acquisition.json", { ...record, evidence, hashes: contentHashes(record) });
  log({ status: "usdt_acquired", ...record, evidence: evidence.sha256, secretOutput: "none" });
} finally { wallet.destroy(); }
