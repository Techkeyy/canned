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
const matrix = JSON.parse(await readFile(path.join(dataDir, "state", "candidate-matrix.json"), "utf8").catch(() => "{\"candidates\":[],\"selected\":null}"));
const selected = matrix.selected ? matrix.candidates.find((candidate) => candidate.identity === matrix.selected.identity) : null;
const quoteTerms = selected?.quote?.accepted ? selected.quote : null;
const budget = BigInt(quoteTerms?.price || "0");
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
  candidate: selected ? { identity: selected.identity, tokenId: selected.tokenId, name: selected.name, provider: selected.provider, endpoint: selected.endpoint, readiness: selected.readiness } : null,
  freshQuote: quoteTerms ? { accepted: true, priceRaw: quoteTerms.price, currency: quoteTerms.currency, estimatedCompletionSeconds: quoteTerms.estimatedCompletionSeconds || null, expiresAtUnixSeconds: quoteTerms.quoteExpiresAt || null, signatureVerified: quoteTerms.signatureVerified === true } : null,
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
  selectedCandidate: selected ? { identity: selected.identity, name: selected.name, eligible: selected.eligible, readinessScore: selected.readinessScore, cooldownActive: selected.cooldown?.active === true } : null,
  selectionStatus: selected ? (selected.eligible ? "ready" : "blocked") : "no_candidate_ready",
  fundingStatus: snapshot.fundingStatus,
}, null, 2));
wallet.destroy();
