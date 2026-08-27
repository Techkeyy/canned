import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, parseAbi, encodeFunctionData, formatEther, formatUnits } from "viem";
import { EVMWalletProvider } from "@bnbagent/sdk";
import "../src/core.mjs";
import { readVenusCorePosition, officialVenusCoreTestnet } from "../src/reference/venus.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK } from "../src/reference/constants.mjs";

const env = process.env;
if (env.CANNED_ALLOW_TESTNET_WRITES !== "true" || env.CANNED_HEALTH_POSITION_CONFIRM !== "true") throw new Error("Health position creation requires explicit BSC Testnet write and position confirmations; no write was attempted.");
if ((env.CANNED_NETWORK || REFERENCE_NETWORK) !== REFERENCE_NETWORK || Number(env.CANNED_CHAIN_ID || REFERENCE_CHAIN_ID) !== REFERENCE_CHAIN_ID) throw new Error("Health position creation is restricted to BSC Testnet chain 97.");
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const contracts = officialVenusCoreTestnet();
const rpcUrl = env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
if (/mainnet|chainid=56|\b56\b/i.test(rpcUrl)) throw new Error("Mainnet RPC is forbidden.");
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });
if (await publicClient.getChainId() !== REFERENCE_CHAIN_ID) throw new Error("RPC chain guard failed; expected chain 97.");
const buyerPassword = env.CANNED_EXECUTION_WALLET_PASSWORD;
const buyerAddress = env.CANNED_EXECUTION_WALLET_ADDRESS;
if (!buyerPassword || !buyerAddress) throw new Error("Canned buyer wallet configuration is missing.");
const buyerWalletsDir = path.resolve(env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"));
const buyer = new EVMWalletProvider({ password: buyerPassword, address: buyerAddress, walletsDir: buyerWalletsDir, persist: true });
const benchmarkWalletsDir = path.join(dataDir, "state", "health-benchmark-wallets");
const benchmarkPassword = (env.CANNED_HEALTH_BENCHMARK_PASSWORD || await readFile(path.join(dataDir, "state", "health-benchmark-wallet-password.txt"), "utf8")).trim();
const configured = EVMWalletProvider.listWallets(benchmarkWalletsDir);
const benchmarkAddress = env.CANNED_HEALTH_BENCHMARK_ADDRESS || (configured.length === 1 ? configured[0] : null);
if (!benchmarkAddress) throw new Error("HealthBench wallet is missing; run npm run health:wallet:create first.");
const benchmark = new EVMWalletProvider({ password: benchmarkPassword, address: benchmarkAddress, walletsDir: benchmarkWalletsDir, persist: true });
const allowedTargets = new Set([buyer.address.toLowerCase(), benchmark.address.toLowerCase(), contracts.comptroller.toLowerCase(), contracts.vBNB.toLowerCase(), contracts.vUSDT.toLowerCase()]);
const txs = [];
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const venusAbi = parseAbi(["function enterMarkets(address[] vTokens) returns (uint256[])", "function mint() payable", "function borrow(uint256 borrowAmount) returns (uint256)"]);

async function send({ signer, to, data, value = 0n, label, maxGas = 1_000_000n }) {
  if (!allowedTargets.has(to.toLowerCase())) throw new Error(`Target not allowlisted for HealthBench: ${to}`);
  const nonce = await publicClient.getTransactionCount({ address: signer.address, blockTag: "pending" });
  const gasEstimate = await publicClient.estimateGas({ account: signer.address, to, data, value });
  if (gasEstimate > maxGas) throw new Error(`${label} gas estimate exceeds the bounded limit.`);
  const gas = (gasEstimate * 120n) / 100n + 1n;
  const gasPrice = await publicClient.getGasPrice();
  const signed = await signer.signTransaction({ chainId: REFERENCE_CHAIN_ID, nonce, to, data, value, gas, gasPrice });
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${label} reverted in the confirmed receipt.`);
  const record = { label, hash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), effectiveGasPrice: String(receipt.effectiveGasPrice || gasPrice) };
  txs.push(record);
  return record;
}

try {
  const fundAmount = 20_000_000_000_000_000n;
  const collateralAmount = 5_000_000_000_000_000n;
  const borrowAmount = 100_000n;
  const buyerBalance = await publicClient.getBalance({ address: buyer.address });
  const gasPrice = await publicClient.getGasPrice();
  if (buyerBalance < fundAmount + gasPrice * 100_000n) throw new Error("Buyer wallet does not have enough bounded native gas for the benchmark-wallet funding transfer.");
  await send({ signer: buyer, to: benchmark.address, value: fundAmount, data: "0x", label: "fund disposable HealthBench wallet", maxGas: 100_000n });
  await send({ signer: benchmark, to: contracts.comptroller, data: encodeFunctionData({ abi: venusAbi, functionName: "enterMarkets", args: [[contracts.vBNB]] }), label: "enter Venus vBNB market" });
  await send({ signer: benchmark, to: contracts.vBNB, data: encodeFunctionData({ abi: venusAbi, functionName: "mint", args: [] }), value: collateralAmount, label: "supply tiny BNB collateral" });
  await send({ signer: benchmark, to: contracts.vUSDT, data: encodeFunctionData({ abi: venusAbi, functionName: "borrow", args: [borrowAmount] }), label: "borrow tiny USDT debt" });
  const snapshot = await readVenusCorePosition({ publicClient, account: benchmark.address, contracts });
  const artifact = { schemaVersion: 1, kind: "health_benchmark_position", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, account: benchmark.address, contracts, position: { collateral: { market: contracts.vBNB, amountRaw: collateralAmount.toString(), amount: formatEther(collateralAmount) }, debt: { market: contracts.vUSDT, underlying: contracts.usdt, amountRaw: borrowAmount.toString(), amount: formatUnits(borrowAmount, 6) } }, transactions: txs, snapshot, createdAt: new Date().toISOString() };
  await mkdir(path.join(dataDir, "state"), { recursive: true });
  await writeFile(path.join(dataDir, "state", "health-position-snapshot.json"), `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ status: "health_position_created", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, benchmarkAddress: benchmark.address, collateral: "0.005 BNB", debt: "0.1 USDT", transactions: txs.map(({ label, ...publicTx }) => ({ label, ...publicTx })), snapshotArtifact: "state/health-position-snapshot.json", secretOutput: "none" }, null, 2));
} finally { buyer.destroy(); benchmark.destroy(); }
