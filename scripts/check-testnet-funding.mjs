import { readFile } from "node:fs/promises";
import path from "node:path";
import { formatEther, formatUnits, createPublicClient, http } from "viem";
import { FileStore } from "../src/persistence/file-store.mjs";
import { negotiateA2A } from "../src/protocol/a2a.mjs";

const root = path.resolve(process.cwd());
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(root, "data"));
const sdk = await import("@bnbagent/sdk");
sdk.loadEnv(root);
if (!process.env.CANNED_EXECUTION_WALLET_PASSWORD || !process.env.CANNED_EXECUTION_WALLET_ADDRESS) throw new Error("Canned wallet configuration is missing. Run npm run wallet:create first.");

const walletsDir = path.resolve(process.env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"));
const wallet = new sdk.EVMWalletProvider({ password: process.env.CANNED_EXECUTION_WALLET_PASSWORD, address: process.env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir, persist: true });
const client = await sdk.ERC8183Client.create({ network: "bsc-testnet", walletProvider: wallet });
const chain = {
  id: client.network.chainId,
  name: "BSC Testnet",
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: { default: { http: [client.network.rpcUrl] } },
};
const publicClient = createPublicClient({ chain, transport: http(client.network.rpcUrl, { timeout: 12_000 }) });
const candidateReport = JSON.parse(await readFile(path.join(dataDir, "inventory", "verified-candidates.json"), "utf8"));
const candidate = candidateReport.candidates.find((item) => item.tokenId === "1923");
if (!candidate) throw new Error("Selected candidate identity 1923 is not present in the inventory artifact.");
const a2a = candidate.probes.find((probe) => probe.callable && /a2a/i.test(probe.type));
if (!a2a) throw new Error("Selected candidate has no callable A2A endpoint in the inventory artifact.");
const quoteProbe = await negotiateA2A({
  endpoint: a2a.endpoint,
  card: a2a.card,
  taskDescription: "Canned pre-funding quote probe for a bounded rebalancing benchmark. Return terms only; do not execute an onchain action.",
  deliverables: "signed quote only",
  qualityStandards: "no execution",
});
const quoteTerms = quoteProbe.quote?.terms || quoteProbe.quote || null;
if (!quoteProbe.accepted || !quoteTerms?.price || !quoteTerms.currency) throw new Error("Selected candidate did not return a fresh accepted quote.");

const [rpcChainId, nativeBalance, gasPriceWei, tokenAddress, decimals, symbol, tokenBalance, allowance, disputeWindow] = await Promise.all([
  publicClient.getChainId(),
  publicClient.getBalance({ address: wallet.address }),
  publicClient.getGasPrice(),
  client.paymentToken(),
  client.tokenDecimals(),
  client.tokenSymbol(),
  client.tokenBalance(wallet.address),
  client.tokenAllowance(wallet.address, client.commerce.address),
  client.policy.disputeWindow(),
]);
const budget = BigInt(quoteTerms.price);
const planningGasUnits = 500_000n;
const estimatedGasWei = gasPriceWei * planningGasUnits;
const snapshot = {
  schemaVersion: 1,
  kind: "canned_testnet_funding_check",
  observedAt: new Date().toISOString(),
  network: client.network.name,
  chainId: rpcChainId,
  rpcUrl: client.network.rpcUrl,
  wallet: { address: wallet.address, keyLocation: wallet.keyLocation, encryptedKeystore: wallet.exists() },
  native: { symbol: "tBNB", balanceWei: nativeBalance.toString(), balance: formatEther(nativeBalance), gasPriceWei: gasPriceWei.toString(), planningGasUnits: planningGasUnits.toString(), estimatedNeedWei: estimatedGasWei.toString(), estimatedNeed: formatEther(estimatedGasWei) },
  paymentToken: { address: tokenAddress, symbol, decimals, balanceRaw: tokenBalance.toString(), balance: formatUnits(tokenBalance, decimals), requiredBudgetRaw: budget.toString(), requiredBudget: formatUnits(budget, decimals), allowanceToCommerceRaw: allowance.toString(), allowanceToCommerce: formatUnits(allowance, decimals), allowanceShortfallRaw: allowance >= budget ? "0" : (budget - allowance).toString() },
  commerce: { address: client.commerce.address, router: client.router.address, policy: client.policy.address, disputeWindowSeconds: disputeWindow.toString() },
  candidate: { identity: candidate.identity, tokenId: candidate.tokenId, name: candidate.name, provider: candidate.agentWallet || candidate.ownerAddress, endpoint: a2a.endpoint },
  freshQuote: { accepted: quoteProbe.accepted === true, priceRaw: quoteTerms.price, currency: quoteTerms.currency, estimatedCompletionSeconds: quoteProbe.quote?.estimated_completion_seconds || null, expiresAtUnixSeconds: quoteProbe.quote?.quote_expires_at || quoteTerms.quote_expires_at || null, negotiationHash: quoteProbe.negotiationHash, providerSignaturePresent: Boolean(quoteProbe.providerSignature) },
  fundingStatus: { needsNativeGas: nativeBalance < estimatedGasWei, needsPaymentToken: tokenBalance < budget, needsAllowance: allowance < budget },
  notes: ["Gas need is a bounded planning estimate for self-paid create/register/approval/fund calls at the observed gas price; the SDK may sponsor eligible calls.", "Payment token address, symbol, decimals, and Commerce addresses were read through the official SDK.", "No transaction was sent by this check."],
};
const store = await new FileStore(dataDir).init();
const saved = await store.saveJson("state/funding-check.json", snapshot);
console.log(JSON.stringify({
  artifact: saved.relativePath,
  walletAddress: wallet.address,
  chainId: rpcChainId,
  tBNBBalance: snapshot.native.balance,
  paymentToken: `${symbol} ${tokenAddress}`,
  paymentTokenBalance: snapshot.paymentToken.balance,
  requiredBudget: snapshot.paymentToken.requiredBudget,
  allowanceToCommerce: snapshot.paymentToken.allowanceToCommerce,
  estimatedNativeGasNeed: snapshot.native.estimatedNeed,
  freshQuote: snapshot.freshQuote,
  fundingStatus: snapshot.fundingStatus,
}, null, 2));
wallet.destroy();
