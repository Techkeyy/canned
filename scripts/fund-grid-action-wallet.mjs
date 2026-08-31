/**
 * One bounded BSC Testnet native transfer: gas for the Altana action wallet.
 *
 * Gas only. This wallet holds the bounded execution capital and owns The
 * Leash permission, so it is deliberately not the buyer and not any provider,
 * and this script refuses to send to any of them.
 */
import path from "node:path";
import { createPublicClient, http } from "viem";
import { nowIso } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { loadSdk, sendNativeTransfer, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_WALLET_PATHS } from "../src/reference/constants.mjs";
import { sdkRpcEnvironment } from "../src/deploy/rpc-capability.mjs";

const AUTHORIZED_WEI = 10_000_000_000_000_000n; // exactly 0.01 tBNB
const EXPECTED_BUYER = "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB";
const ACTION_WALLETS_DIR = "grid-action-wallets";

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const log = (body) => console.log(JSON.stringify(body, null, 2));
const stop = (reason, details = {}) => { log({ status: "blocked", reason, ...details }); process.exit(2); };

const sdk = await loadSdk();
const safety = writeSafety(env);
if (safety.network !== REFERENCE_NETWORK) stop("Only BSC Testnet funding is authorized.", { network: safety.network });
if (!safety.writesRequested) stop("CANNED_ALLOW_TESTNET_WRITES is not true; no transfer was attempted.");
if (String(env.CANNED_EXECUTION_WALLET_ADDRESS).toLowerCase() !== EXPECTED_BUYER.toLowerCase()) stop("The configured source wallet is not the Canned buyer.");

// The recipient must be the action keystore this project actually holds.
const actionDir = path.join(dataDir, "state", ACTION_WALLETS_DIR);
const actionAddresses = sdk.EVMWalletProvider.listWallets(actionDir);
if (actionAddresses.length !== 1) stop("Expected exactly one action wallet keystore.", { found: actionAddresses.length });
const recipient = actionAddresses[0];

if (recipient.toLowerCase() === EXPECTED_BUYER.toLowerCase()) stop("Refusing to send to the buyer itself.");
for (const [key, paths] of Object.entries(REFERENCE_WALLET_PATHS)) {
  const provider = sdk.EVMWalletProvider.listWallets(path.join(dataDir, "state", paths.walletsDir))[0] || null;
  if (provider && provider.toLowerCase() === recipient.toLowerCase()) stop(`Refusing to fund ${key}'s provider wallet as an action wallet.`, { recipient });
}

// The amount is fixed, not configurable. A funding ceiling that can be raised
// by an environment variable is not a ceiling.
const amountWei = AUTHORIZED_WEI;

const rpcEnvironment = sdkRpcEnvironment(env, REFERENCE_NETWORK);
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcEnvironment.effectiveRpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcEnvironment.effectiveRpcUrl, { timeout: 20_000 }) });
const chainId = await publicClient.getChainId();
if (chainId !== REFERENCE_CHAIN_ID) stop(`Refusing to transfer on chain ${chainId}.`);

const wallet = new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });
try {
  const [senderBefore, recipientBefore] = await Promise.all([publicClient.getBalance({ address: wallet.address }), publicClient.getBalance({ address: recipient })]);
  if (senderBefore < amountWei * 2n) stop("The buyer does not hold enough tBNB for this transfer plus gas.", { senderBefore: senderBefore.toString() });
  log({ status: "funding_preflight", role: "altana_action_wallet_gas", chainId, from: wallet.address, to: recipient, amountTBNB: "0.010000", senderBeforeWei: senderBefore.toString(), recipientBeforeWei: recipientBefore.toString() });

  const result = await sendNativeTransfer({ wallet, publicClient, to: recipient, valueWei: amountWei, expectedChainId: REFERENCE_CHAIN_ID });
  const [senderAfter, recipientAfter] = await Promise.all([publicClient.getBalance({ address: wallet.address }), publicClient.getBalance({ address: recipient })]);
  const gasUsed = BigInt(result.receipt.gasUsed);
  const effectiveGasPrice = BigInt(result.receipt.effectiveGasPrice ?? result.gasPrice);
  const record = {
    kind: "altana_action_wallet_gas_funding",
    schemaVersion: 1,
    role: "user_action_wallet",
    network: REFERENCE_NETWORK,
    chainId,
    from: wallet.address,
    to: recipient,
    amountWei: amountWei.toString(),
    amountTBNB: "0.010000",
    transactionHash: result.transactionHash,
    blockNumber: String(result.receipt.blockNumber),
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    gasCostWei: (gasUsed * effectiveGasPrice).toString(),
    senderBalanceBeforeWei: senderBefore.toString(),
    senderBalanceAfterWei: senderAfter.toString(),
    recipientBalanceBeforeWei: recipientBefore.toString(),
    recipientBalanceAfterWei: recipientAfter.toString(),
    purpose: "Gas only, for a future bounded Altana session. No trading capital and no token was sent.",
    authorizedCeilingWei: AUTHORIZED_WEI.toString(),
    tokenSent: "none",
    fundedAt: nowIso(),
  };
  const evidence = await store.saveEvidence(record);
  await store.saveJson("state/grid-action-wallet-funding.json", { ...record, evidence });
  log({ status: "action_wallet_funded", ...record, evidence: evidence.sha256, secretOutput: "none" });
} finally { wallet.destroy(); }
