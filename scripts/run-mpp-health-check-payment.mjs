import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Challenge } from "mppx";
import { createHashCredential } from "@bnb-chain/mpp/client";
import { deserializeEvmReceipt } from "@bnb-chain/mpp/server";
import { createPublicClient, encodeFunctionData, http, parseAbi, parseAbiItem, parseEventLogs } from "viem";
import { loadSdk } from "../src/protocol/erc8183-buyer.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { HEALTH_FACTOR_MPP_CHAIN_ID, HEALTH_FACTOR_MPP_MAX_PRICE_RAW, HEALTH_FACTOR_MPP_NETWORK, HEALTH_FACTOR_MPP_PATH, HEALTH_FACTOR_MPP_PRICE_RAW, HEALTH_FACTOR_MPP_TOKEN } from "../src/reference/health-factor-mpp.mjs";

const EXPECTED_BUYER = "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB";
const EXPECTED_RECIPIENT = "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7";
const INDEPENDENT_RPC_URL = "https://bsc-testnet-dataseed.bnbchain.org";
const TRANSFER_ABI = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const token = HEALTH_FACTOR_MPP_TOKEN;
const chain = { id: HEALTH_FACTOR_MPP_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com"] } } };
const tokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);

function log(value) {
  console.log(JSON.stringify(value, null, 2));
}

function block(reason, details = {}) {
  log({ status: "blocked", reason, ...details });
  process.exitCode = 2;
}

function safeReason(error) {
  const message = error instanceof Error ? error.message : "MPP payment flow failed.";
  return message.replace(/https?:\/\/[^\s]+/gu, "[redacted-url]").slice(0, 500);
}

function endpointFromEnvironment() {
  const configured = env.CANNED_MPP_URL || env.CANNED_MPP_PUBLIC_URL || env.CANNED_REFERENCE_AGENT_URL;
  if (!configured) return `http://127.0.0.1:${env.PORT || "8790"}${HEALTH_FACTOR_MPP_PATH}`;
  const parsed = new URL(configured);
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  if (parsed.pathname === HEALTH_FACTOR_MPP_PATH) return parsed.toString();
  parsed.pathname = HEALTH_FACTOR_MPP_PATH;
  return parsed.toString();
}

async function loadExistingHealthTask() {
  if (env.CANNED_MPP_TASK_JSON) {
    const inline = JSON.parse(env.CANNED_MPP_TASK_JSON);
    if (inline && typeof inline === "object" && inline.snapshot && inline.account) return { account: inline.account, protocol: "venus", authoritativeSnapshot: inline.snapshot };
    if (inline && typeof inline === "object" && inline.authoritativeSnapshot && inline.account) return inline;
    throw new Error("The inline MPP task is not in the expected Health Guard form.");
  }
  const taskFile = path.resolve(env.CANNED_MPP_TASK_FILE || path.join(dataDir, "state", "health-position-snapshot.json"));
  if (!existsSync(taskFile)) throw new Error("The existing Health Guard authoritative snapshot is missing.");
  const artifact = JSON.parse(await readFile(taskFile, "utf8"));
  if (!artifact.account || !artifact.snapshot) throw new Error("The existing Health Guard snapshot is not in the expected form.");
  return { account: artifact.account, protocol: "venus", authoritativeSnapshot: artifact.snapshot };
}

function assertChallenge(challenge) {
  const details = challenge.request?.methodDetails || {};
  const amount = String(challenge.request?.amount || "");
  const currency = String(challenge.request?.currency || "");
  const recipient = String(challenge.request?.recipient || "");
  const credentials = Array.isArray(details.credentialTypes) ? details.credentialTypes : [];
  if (challenge.method !== "evm" || challenge.intent !== "charge") throw new Error("The endpoint did not offer an official EVM charge challenge.");
  if (Number(details.chainId) !== HEALTH_FACTOR_MPP_CHAIN_ID) throw new Error("The challenge is not bound to BSC Testnet.");
  if (currency.toLowerCase() !== token.toLowerCase()) throw new Error("The challenge currency is not the canonical TEST_USDT token.");
  if (recipient.toLowerCase() !== EXPECTED_RECIPIENT.toLowerCase()) throw new Error("The challenge recipient is not the Health Guard provider.");
  if (amount !== HEALTH_FACTOR_MPP_PRICE_RAW || BigInt(amount) > BigInt(HEALTH_FACTOR_MPP_MAX_PRICE_RAW)) throw new Error("The challenge amount is outside the bounded 0.01 TEST_USDT offer.");
  if (!credentials.includes("hash")) throw new Error("The challenge does not offer the payer-funded hash credential.");
  return { amount, currency, recipient, credentials, chainId: Number(details.chainId) };
}

async function main() {
  const endpoint = endpointFromEnvironment();
  const task = await loadExistingHealthTask();
  const body = JSON.stringify(task);
  const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 20_000 }) });
  const independentClient = createPublicClient({ chain, transport: http(env.CANNED_MPP_VERIFY_RPC_URL || INDEPENDENT_RPC_URL, { timeout: 20_000 }) });
  const [chainId, independentChainId] = await Promise.all([publicClient.getChainId(), independentClient.getChainId()]);
  if (chainId !== HEALTH_FACTOR_MPP_CHAIN_ID || independentChainId !== HEALTH_FACTOR_MPP_CHAIN_ID) throw new Error("The configured verification RPCs are not both on BSC Testnet.");

  const unpaid = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body });
  const challengeHeader = unpaid.headers.get("WWW-Authenticate");
  if (unpaid.status !== 402 || !challengeHeader) throw new Error(`Expected an unpaid HTTP 402 challenge, received HTTP ${unpaid.status}.`);
  const challenge = Challenge.deserialize(challengeHeader);
  const offer = assertChallenge(challenge);

  const sdk = await loadSdk();
  if (String(env.CANNED_EXECUTION_WALLET_ADDRESS || "").toLowerCase() !== EXPECTED_BUYER.toLowerCase()) throw new Error("The configured payer is not the existing Canned buyer wallet.");
  if (!env.CANNED_EXECUTION_WALLET_PASSWORD) throw new Error("The existing Canned buyer wallet password is not configured.");
  const wallet = new sdk.EVMWalletProvider({ password: env.CANNED_EXECUTION_WALLET_PASSWORD, address: env.CANNED_EXECUTION_WALLET_ADDRESS, walletsDir: env.CANNED_WALLETS_DIR || path.join(dataDir, "wallets"), persist: true });
  try {
    const [bytecode, decimals, symbol, name, tokenBalance, nativeBalance, gasPrice] = await Promise.all([
      publicClient.getBytecode({ address: token }),
      publicClient.readContract({ address: token, abi: tokenAbi, functionName: "decimals" }),
      publicClient.readContract({ address: token, abi: tokenAbi, functionName: "symbol" }),
      publicClient.readContract({ address: token, abi: tokenAbi, functionName: "name" }),
      publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [wallet.address] }),
      publicClient.getBalance({ address: wallet.address }),
      publicClient.getGasPrice(),
    ]);
    if (!bytecode || bytecode === "0x" || Number(decimals) !== 18 || symbol !== "USDT" || name !== "USDT Token") throw new Error("The live token contract does not match the official TEST_USDT preset.");
    const data = encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [offer.recipient, BigInt(offer.amount)] });
    const estimatedGas = await publicClient.estimateGas({ account: wallet.address, to: token, data, value: 0n });
    const gasReserveWei = ((estimatedGas * 12n) / 10n) * gasPrice;
    if (tokenBalance < BigInt(offer.amount)) throw new Error("The existing buyer does not hold enough TEST_USDT for the exact challenge.");
    if (nativeBalance < gasReserveWei) throw new Error("The existing buyer does not hold enough tBNB for the direct transfer gas.");

    log({
      status: "preflight_ready",
      endpoint,
      protocol: "MPP",
      notB402: true,
      notX402: true,
      network: HEALTH_FACTOR_MPP_NETWORK,
      chainId: offer.chainId,
      payer: wallet.address,
      recipient: offer.recipient,
      token: { address: token, symbol, name, decimals: Number(decimals) },
      amountRaw: offer.amount,
      credential: "hash",
      settlement: "payer-funded direct ERC-20 transfer",
      approval: "none",
      independentVerificationRpc: env.CANNED_MPP_VERIFY_RPC_URL || INDEPENDENT_RPC_URL,
      broadcast: process.argv.includes("--confirm"),
    });
    if (!process.argv.includes("--confirm")) {
      block("Explicit confirmation is required before the one BSC Testnet payment broadcast.");
      return;
    }

    const [freshGasPrice, nonce] = await Promise.all([publicClient.getGasPrice(), publicClient.getTransactionCount({ address: wallet.address, blockTag: "pending" })]);
    const freshGas = await publicClient.estimateGas({ account: wallet.address, to: token, data, value: 0n });
    const signed = await wallet.signTransaction({ chainId: HEALTH_FACTOR_MPP_CHAIN_ID, nonce, to: token, data, value: 0n, gas: (freshGas * 12n) / 10n, gasPrice: freshGasPrice });
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (receipt.status !== "success") throw new Error("The payer-funded transfer did not succeed.");

    const independentReceipt = await independentClient.getTransactionReceipt({ hash });
    if (independentReceipt.status !== "success") throw new Error("The independent BSC Testnet RPC did not verify a successful transfer receipt.");
    const matchingTransfer = parseEventLogs({ abi: [TRANSFER_EVENT], logs: independentReceipt.logs, eventName: "Transfer" }).filter((event) => event.address.toLowerCase() === token.toLowerCase() && event.args.from.toLowerCase() === wallet.address.toLowerCase() && event.args.to.toLowerCase() === offer.recipient.toLowerCase() && event.args.value === BigInt(offer.amount));
    if (!matchingTransfer.length) throw new Error("The independent RPC did not expose the canonical TEST_USDT transfer log.");

    const authorization = await createHashCredential({ challenge, hash, source: `did:pkh:eip155:${HEALTH_FACTOR_MPP_CHAIN_ID}:${wallet.address}` });
    const paid = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authorization }, body });
    const receiptHeader = paid.headers.get("Payment-Receipt");
    if (paid.status !== 200 || !receiptHeader) throw new Error(`The paid MPP request did not return HTTP 200 with Payment-Receipt (HTTP ${paid.status}).`);
    const paymentReceipt = deserializeEvmReceipt(receiptHeader);
    if (paymentReceipt.challengeId !== challenge.id || paymentReceipt.reference.toLowerCase() !== hash.toLowerCase() || paymentReceipt.chainId !== HEALTH_FACTOR_MPP_CHAIN_ID || paymentReceipt.status !== "success") throw new Error("The MPP Payment-Receipt did not bind to the verified payer-funded transfer.");
    const output = await paid.json();
    if (output.origin !== "CANNED_REFERENCE" || output.category !== "health_factor_monitoring" || !output.assessment || !output.position) throw new Error("The paid response was not the deterministic Health Guard Quick Health Check deliverable.");

    const replay = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: authorization }, body });
    if (replay.status !== 402) throw new Error(`Replay protection expected HTTP 402, received HTTP ${replay.status}.`);
    const store = await new FileStore(dataDir).init();
    await store.saveJson("state/mpp-payment-evidence.json", {
      schemaVersion: 1,
      protocol: "MPP",
      notB402: true,
      notX402: true,
      network: HEALTH_FACTOR_MPP_NETWORK,
      chainId: HEALTH_FACTOR_MPP_CHAIN_ID,
      endpoint,
      payer: wallet.address,
      recipient: offer.recipient,
      token: { address: token, symbol, decimals: Number(decimals) },
      amountRaw: offer.amount,
      transactionHash: hash,
      blockNumber: String(receipt.blockNumber),
      receiptChallengeId: paymentReceipt.challengeId,
      paidStatus: paid.status,
      replayStatus: replay.status,
      work: "Canned Health Guard Quick Health Check",
      credential: "hash",
      approval: "none",
      independentReceiptVerified: true,
      createdAt: new Date().toISOString(),
    });
    log({ status: "mpp_payment_verified", transactionHash: hash, blockNumber: String(receipt.blockNumber), paidHttpStatus: paid.status, replayHttpStatus: replay.status, receiptChallengeId: paymentReceipt.challengeId, deliverable: "CANNED Health Guard Quick Health Check", evidence: "state/mpp-payment-evidence.json" });
  } finally {
    wallet.destroy();
  }
}

try {
  await main();
} catch (error) {
  block(safeReason(error));
}
