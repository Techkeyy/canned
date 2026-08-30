import path from "node:path";
import { createPublicClient, http } from "viem";
import { nowIso, requestJson } from "../src/core.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { loadSdk, sendNativeTransfer, writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_IDENTITY_FILES, REFERENCE_NETWORK, REFERENCE_WALLET_PATHS, referenceSpec } from "../src/reference/constants.mjs";
import { sdkRpcEnvironment } from "../src/deploy/rpc-capability.mjs";

/**
 * One bounded BSC Testnet native transfer to a named reference agent's provider:
 * enough gas to register an ERC-8004 identity and submit results. The amount is
 * capped, the source must be the dedicated Canned buyer, and the destination
 * must be the provider the live service actually signs with.
 */
const MAX_FUNDING_WEI = 3_000_000_000_000_000n; // 0.003 tBNB
const EXPECTED_BUYER = "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB";
const AGENT_URL_ENV = Object.freeze({ "health-factor": "CANNED_REFERENCE_AGENT_URL", rebalancing: "CANNED_RANGE_AGENT_URL", yield: "CANNED_YIELD_AGENT_URL" });
const DEFAULT_AGENT_URL = Object.freeze({
  "health-factor": "https://health-guard.103-195-188-198.sslip.io/erc8183",
  rebalancing: "https://range-keeper.103-195-188-198.sslip.io/erc8183",
  yield: "https://yield-scout.103-195-188-198.sslip.io/erc8183",
});

const env = process.env;
const referenceKey = process.argv[2] || env.CANNED_REFERENCE_KEY || null;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const store = await new FileStore(dataDir).init();
const log = (body) => console.log(JSON.stringify(body, null, 2));
const stop = (reason, details = {}) => { log({ status: "blocked", reason, ...details }); process.exit(2); };

const spec = referenceKey ? referenceSpec(referenceKey) : null;
if (!spec) stop(`A known reference agent key is required. Known keys: ${Object.keys(REFERENCE_WALLET_PATHS).join(", ")}`, { received: referenceKey });
const walletPaths = REFERENCE_WALLET_PATHS[referenceKey];
if (!walletPaths) stop(`No wallet configuration for reference agent key: ${referenceKey}`);

const amountWei = BigInt(env.CANNED_PROVIDER_FUNDING_WEI || MAX_FUNDING_WEI.toString());
if (amountWei > MAX_FUNDING_WEI) stop("Requested amount exceeds the authorized 0.003 tBNB ceiling.", { amountWei: amountWei.toString(), ceilingWei: MAX_FUNDING_WEI.toString() });
if (amountWei <= 0n) stop("Funding amount must be positive.");

const sdk = await loadSdk();
const safety = writeSafety(env);
if (safety.network !== REFERENCE_NETWORK) stop("Only BSC Testnet funding is authorized.", { network: safety.network });
if (!safety.writesRequested) stop("CANNED_ALLOW_TESTNET_WRITES is not true; no transfer was attempted.");
if (!safety.walletConfigured) stop("The Canned buyer wallet is not configured.");
if (String(env.CANNED_EXECUTION_WALLET_ADDRESS).toLowerCase() !== EXPECTED_BUYER.toLowerCase()) stop("The configured source wallet is not the Canned buyer.", { configured: env.CANNED_EXECUTION_WALLET_ADDRESS });

const walletsDir = path.join(dataDir, "state", walletPaths.walletsDir);
const localProvider = sdk.EVMWalletProvider.listWallets(walletsDir)[0] || null;
const identityRecord = await store.loadJson(REFERENCE_IDENTITY_FILES[referenceKey], null);
const recipient = env.CANNED_PROVIDER_FUNDING_RECIPIENT || identityRecord?.provider || localProvider;
if (!recipient) stop(`The ${spec.name} provider address could not be resolved.`);
if (localProvider && recipient.toLowerCase() !== localProvider.toLowerCase()) stop("The recipient does not match the local keystore for this agent.", { recipient, localProvider });
if (String(recipient).toLowerCase() === EXPECTED_BUYER.toLowerCase()) stop("Refusing to send to the buyer itself.");

// The recipient must be the provider the live service actually signs with, and
// must not belong to any other reference agent.
for (const [otherKey, file] of Object.entries(REFERENCE_IDENTITY_FILES)) {
  if (otherKey === referenceKey) continue;
  const other = await store.loadJson(file, null);
  if (other?.provider && String(other.provider).toLowerCase() === String(recipient).toLowerCase()) {
    stop(`Refusing to fund ${otherKey}'s provider under a ${referenceKey} directive.`, { recipient, conflictsWith: otherKey });
  }
}
for (const [otherKey, paths] of Object.entries(REFERENCE_WALLET_PATHS)) {
  if (otherKey === referenceKey) continue;
  const otherLocal = sdk.EVMWalletProvider.listWallets(path.join(dataDir, "state", paths.walletsDir))[0] || null;
  if (otherLocal && otherLocal.toLowerCase() === String(recipient).toLowerCase()) stop(`Refusing to fund ${otherKey}'s keystore address under a ${referenceKey} directive.`, { recipient, conflictsWith: otherKey });
}

const agentUrl = env[AGENT_URL_ENV[referenceKey]] || DEFAULT_AGENT_URL[referenceKey];
const liveStatus = await requestJson(`${agentUrl.replace(/\/$/, "")}/status`, { timeoutMs: 20_000 });
if (!liveStatus.ok || !liveStatus.body) stop("The live status endpoint did not answer; refusing to fund an unverified provider.", { agentUrl, httpStatus: liveStatus.status });
if (String(liveStatus.body.provider).toLowerCase() !== String(recipient).toLowerCase()) stop("The live provider does not match the funding recipient.", { live: liveStatus.body.provider, recipient });
if (Number(liveStatus.body.chainId) !== REFERENCE_CHAIN_ID) stop("The live service is not on chain 97.");

const rpcEnvironment = sdkRpcEnvironment(env, REFERENCE_NETWORK);
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcEnvironment.effectiveRpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcEnvironment.effectiveRpcUrl, { timeout: 20_000 }) });
const chainId = await publicClient.getChainId();
if (chainId !== REFERENCE_CHAIN_ID) stop(`Refusing to transfer on chain ${chainId}.`);

const wallet = new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });
try {
  const [senderBefore, recipientBefore] = await Promise.all([publicClient.getBalance({ address: wallet.address }), publicClient.getBalance({ address: recipient })]);
  log({ status: "funding_preflight", referenceKey, agent: spec.name, chainId, from: wallet.address, to: recipient, amountWei: amountWei.toString(), amountTBNB: (Number(amountWei) / 1e18).toFixed(6), senderBeforeWei: senderBefore.toString(), recipientBeforeWei: recipientBefore.toString(), liveProviderMatch: true });

  const result = await sendNativeTransfer({ wallet, publicClient, to: recipient, valueWei: amountWei, expectedChainId: REFERENCE_CHAIN_ID });
  const [senderAfter, recipientAfter] = await Promise.all([publicClient.getBalance({ address: wallet.address }), publicClient.getBalance({ address: recipient })]);
  const gasUsed = BigInt(result.receipt.gasUsed);
  const effectiveGasPrice = BigInt(result.receipt.effectiveGasPrice ?? result.gasPrice);
  const record = {
    kind: "reference_provider_gas_funding",
    schemaVersion: 1,
    referenceKey,
    agent: spec.name,
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
    purpose: `ERC-8004 registration gas and provider submitResult gas for ${spec.name}`,
    authorizedCeilingWei: MAX_FUNDING_WEI.toString(),
    fundedAt: nowIso(),
  };
  const evidence = await store.saveEvidence(record);
  await store.saveJson(`state/${referenceKey}-provider-funding.json`, { ...record, evidence });
  log({ status: "reference_provider_funded", ...record, evidence: evidence.sha256, secretOutput: "none" });
} finally { wallet.destroy(); }
