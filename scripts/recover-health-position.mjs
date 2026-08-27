import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, formatEther, formatUnits } from "viem";
import "../src/core.mjs";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { VENUS_CORE_COMPTROLLER_ABI, VENUS_MARKET_READ_ABI, officialVenusCoreTestnet, readVenusCorePosition } from "../src/reference/venus.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK } from "../src/reference/constants.mjs";

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const contracts = officialVenusCoreTestnet();
const rpcUrl = env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
if (/mainnet|chainid=56|\b56\b/i.test(rpcUrl)) throw new Error("Mainnet RPC is forbidden.");
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });
if (await publicClient.getChainId() !== REFERENCE_CHAIN_ID) throw new Error("RPC chain guard failed; expected chain 97.");
const walletDir = path.join(dataDir, "state", "health-benchmark-wallets");
const configured = EVMWalletProvider.listWallets(walletDir);
const account = env.CANNED_HEALTH_BENCHMARK_ADDRESS || (configured.length === 1 ? configured[0] : null);
if (!account) throw new Error("HealthBench wallet is missing.");
const buyerAddress = env.CANNED_EXECUTION_WALLET_ADDRESS;
if (!buyerAddress) throw new Error("Canned buyer address is missing from local configuration.");
const latest = await publicClient.getBlockNumber();
const requestedFromBlock = env.CANNED_HEALTH_RECOVERY_FROM_BLOCK ? BigInt(env.CANNED_HEALTH_RECOVERY_FROM_BLOCK) : null;
const fromBlock = requestedFromBlock !== null ? requestedFromBlock : (latest > 5_000n ? latest - 5_000n : 0n);
const traces = [];
for (let end = latest; end >= fromBlock; end -= 100n) {
  const start = end - 99n < fromBlock ? fromBlock : end - 99n;
  const window = await publicClient.request({ method: "trace_filter", params: [{ fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}`, fromAddress: [buyerAddress, account], toAddress: [account, contracts.comptroller, contracts.vBNB, contracts.vUSDT] }] });
  traces.push(...(window || []));
}
const hashSet = new Set((traces || []).filter((trace) => trace?.transactionHash).map((trace) => trace.transactionHash));
const receipts = [];
for (const hash of hashSet) {
  const receipt = await publicClient.getTransactionReceipt({ hash });
  if (receipt.status !== "success") continue;
  const tx = await publicClient.getTransaction({ hash });
  const from = tx.from.toLowerCase();
  const to = tx.to?.toLowerCase();
  const input = tx.input.slice(0, 10).toLowerCase();
  const label = from === buyerAddress.toLowerCase() && to === account.toLowerCase() ? "fund disposable HealthBench wallet" :
    to === contracts.comptroller.toLowerCase() && input === "0xc2998238" ? "enter Venus vBNB market" :
    to === contracts.vBNB.toLowerCase() && input === "0x1249c58b" ? "supply tiny BNB collateral" :
    to === contracts.vUSDT.toLowerCase() && input === "0xc5ebeaec" ? "borrow tiny USDT debt" : null;
  if (label) receipts.push({ label, hash, blockNumber: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), effectiveGasPrice: String(receipt.effectiveGasPrice || tx.gasPrice || 0n) });
}
const snapshot = await readVenusCorePosition({ publicClient, account, contracts });
const [assetsIn, vbnbSnapshot, usdtSnapshot] = await Promise.all([
  publicClient.readContract({ address: contracts.comptroller, abi: VENUS_CORE_COMPTROLLER_ABI, functionName: "getAssetsIn", args: [account] }),
  publicClient.readContract({ address: contracts.vBNB, abi: VENUS_MARKET_READ_ABI, functionName: "getAccountSnapshot", args: [account] }),
  publicClient.readContract({ address: contracts.vUSDT, abi: VENUS_MARKET_READ_ABI, functionName: "getAccountSnapshot", args: [account] }),
]);
if (!assetsIn.some((item) => item.toLowerCase() === contracts.vBNB.toLowerCase()) || String(usdtSnapshot[2]) !== "100000") throw new Error("The recovered public state does not match the bounded HealthBench position; no artifact was written.");
receipts.sort((left, right) => Number(left.blockNumber) - Number(right.blockNumber));
const artifact = { schemaVersion: 1, kind: "health_benchmark_position", recovery: true, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, account, contracts, position: { collateral: { market: contracts.vBNB, amountRaw: "5000000000000000", amount: formatEther(5000000000000000n) }, debt: { market: contracts.vUSDT, underlying: contracts.usdt, amountRaw: "100000", amount: formatUnits(100000n, 6) } }, transactions: receipts, snapshot, publicStateCheck: { assetsIn, vBNBAccountSnapshot: vbnbSnapshot.map(String), vUSDTAccountSnapshot: usdtSnapshot.map(String), checkedAt: new Date().toISOString() }, createdAt: new Date().toISOString() };
if (receipts.length < 4) throw new Error("Could not recover all four bounded setup transaction hashes; no artifact was written.");
await mkdir(path.join(dataDir, "state"), { recursive: true });
await writeFile(path.join(dataDir, "state", "health-position-snapshot.json"), `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({ status: "health_position_recovered", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, benchmarkAddress: account, transactions: receipts, snapshotArtifact: "state/health-position-snapshot.json", secretOutput: "none" }, null, 2));
