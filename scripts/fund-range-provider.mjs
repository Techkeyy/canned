import path from "node:path";
import { createPublicClient, http } from "viem";
import { nowIso } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { loadSdk, sendNativeTransfer, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK } from "../src/reference/constants.mjs";

/**
 * One bounded BSC Testnet native transfer: enough gas for the Range Keeper
 * provider to register its ERC-8004 identity and submit results. The amount is
 * a hard ceiling, the destination is pinned to the live Range Keeper provider,
 * and the source must be the dedicated Canned buyer.
 */
const MAX_FUNDING_WEI = 3_000_000_000_000_000n; // 0.003 tBNB
const EXPECTED_BUYER = "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB";

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const log = (body) => console.log(JSON.stringify(body, null, 2));
const stop = (reason, details = {}) => { log({ status: "blocked", reason, ...details }); process.exit(2); };

const amountWei = BigInt(env.CANNED_RANGE_FUNDING_WEI || MAX_FUNDING_WEI.toString());
if (amountWei > MAX_FUNDING_WEI) stop("Requested amount exceeds the authorized 0.003 tBNB ceiling.", { amountWei: amountWei.toString(), ceilingWei: MAX_FUNDING_WEI.toString() });
if (amountWei <= 0n) stop("Funding amount must be positive.");

const sdk = await loadSdk();
const safety = writeSafety(env);
if (safety.network !== REFERENCE_NETWORK) stop("Only BSC Testnet funding is authorized.", { network: safety.network });
if (!safety.writesRequested) stop("CANNED_ALLOW_TESTNET_WRITES is not true; no transfer was attempted.");
if (!safety.walletConfigured) stop("The Canned buyer wallet is not configured.");
if (String(env.CANNED_EXECUTION_WALLET_ADDRESS).toLowerCase() !== EXPECTED_BUYER.toLowerCase()) stop("The configured source wallet is not the Canned buyer.", { configured: env.CANNED_EXECUTION_WALLET_ADDRESS });

// The destination must be the provider the live Range Keeper actually signs with.
const identityRecord = await store.loadJson("state/reference-range-identity.json", null);
const walletsDir = path.join(dataDir, "state", "range-provider-wallets");
const localProvider = sdk.EVMWalletProvider.listWallets(walletsDir)[0] || null;
const recipient = env.CANNED_RANGE_PROVIDER_ADDRESS || identityRecord?.provider || localProvider;
if (!recipient) stop("The Range Keeper provider address could not be resolved.");
if (localProvider && recipient.toLowerCase() !== localProvider.toLowerCase()) stop("The recipient does not match the local Range Keeper keystore.", { recipient, localProvider });

const agentUrl = env.CANNED_RANGE_AGENT_URL || "https://range-keeper.103-195-188-198.sslip.io/erc8183";
const statusResponse = await fetch(`${agentUrl.replace(/\/$/, "")}/status`).catch(() => null);
const liveStatus = statusResponse && statusResponse.ok ? await statusResponse.json() : null;
if (!liveStatus) stop("The live Range Keeper status endpoint did not answer; refusing to fund an unverified provider.");
if (String(liveStatus.provider).toLowerCase() !== recipient.toLowerCase()) stop("The live Range Keeper provider does not match the funding recipient.", { live: liveStatus.provider, recipient });
if (Number(liveStatus.chainId) !== REFERENCE_CHAIN_ID) stop("The live Range Keeper is not on chain 97.");
if (String(recipient).toLowerCase() === EXPECTED_BUYER.toLowerCase()) stop("Refusing to send to the buyer itself.");

const healthRecord = await store.loadJson("state/reference-health-identity.json", null);
if (healthRecord && String(healthRecord.provider).toLowerCase() === recipient.toLowerCase()) stop("Refusing to fund the Health Guard provider under a Range Keeper directive.");

const rpcUrl = env.RPC_URL_BSC_TESTNET || env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000 }) });
const chainId = await publicClient.getChainId();
if (chainId !== REFERENCE_CHAIN_ID) stop(`Refusing to transfer on chain ${chainId}.`);

const wallet = new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });
try {
  const [senderBefore, recipientBefore] = await Promise.all([publicClient.getBalance({ address: wallet.address }), publicClient.getBalance({ address: recipient })]);
  log({ status: "funding_preflight", chainId, from: wallet.address, to: recipient, amountWei: amountWei.toString(), amountTBNB: (Number(amountWei) / 1e18).toFixed(6), senderBeforeWei: senderBefore.toString(), recipientBeforeWei: recipientBefore.toString(), liveProviderMatch: true });

  const result = await sendNativeTransfer({ wallet, publicClient, to: recipient, valueWei: amountWei, expectedChainId: REFERENCE_CHAIN_ID });
  const [senderAfter, recipientAfter] = await Promise.all([publicClient.getBalance({ address: wallet.address }), publicClient.getBalance({ address: recipient })]);
  const gasUsed = BigInt(result.receipt.gasUsed);
  const effectiveGasPrice = BigInt(result.receipt.effectiveGasPrice ?? result.gasPrice);
  const record = {
    kind: "range_provider_gas_funding",
    schemaVersion: 1,
    network: REFERENCE_NETWORK,
    chainId,
    from: wallet.address,
    to: recipient,
    amountWei: amountWei.toString(),
    amountTBNB: (Number(amountWei) / 1e18).toFixed(6),
    transactionHash: result.transactionHash,
    blockNumber: String(result.receipt.blockNumber),
    gasUsed: gasUsed.toString(),
    effectiveGasPrice: effectiveGasPrice.toString(),
    gasCostWei: (gasUsed * effectiveGasPrice).toString(),
    senderBalanceBeforeWei: senderBefore.toString(),
    senderBalanceAfterWei: senderAfter.toString(),
    recipientBalanceBeforeWei: recipientBefore.toString(),
    recipientBalanceAfterWei: recipientAfter.toString(),
    purpose: "ERC-8004 registration gas and provider submitResult gas for Canned Range Keeper",
    authorizedCeilingWei: MAX_FUNDING_WEI.toString(),
    fundedAt: nowIso(),
  };
  const evidence = await store.saveEvidence(record);
  await store.saveJson("state/range-provider-funding.json", { ...record, evidence });
  log({ status: "range_provider_funded", ...record, evidence: evidence.sha256, secretOutput: "none" });
} finally { wallet.destroy(); }
