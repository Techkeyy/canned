import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { AgentEndpoint, ERC8004Agent } from "@bnbagent/sdk/erc8004";
import { verifyQuoteSignature } from "@bnbagent/sdk/erc8183";
import { isPublicHttpUrl, requestJson } from "../src/core.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_ERC8183_COMMERCE_PROXY, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { publicHealthGuardMetadata } from "../src/reference/public-service.mjs";
import { publicReadinessFailures } from "../src/deploy/readiness.mjs";

const env = process.env;
if (env.CANNED_ALLOW_TESTNET_WRITES !== "true" || env.CANNED_REFERENCE_REGISTER_CONFIRM !== "true") throw new Error("ERC-8004 registration requires explicit testnet write and registration confirmations; no write was attempted.");
const agentUrl = env.CANNED_REFERENCE_AGENT_URL;
if (!isPublicHttpUrl(agentUrl)) throw new Error("Registration requires a public Health Guard URL; local URLs are rejected.");
if ((env.CANNED_NETWORK || REFERENCE_NETWORK) !== REFERENCE_NETWORK || Number(env.CANNED_CHAIN_ID || REFERENCE_CHAIN_ID) !== REFERENCE_CHAIN_ID) throw new Error("Registration is restricted to BSC Testnet chain 97.");

async function verifyPublicReadiness() {
  const endpoint = (suffix) => new URL(suffix, `${agentUrl.replace(/\/$/, "")}/`).toString();
  const [health, readiness, status, metadata] = await Promise.all(["/health", "/readiness", "/status", "/metadata"].map((suffix) => requestJson(endpoint(suffix))));
  const failures = publicReadinessFailures({ agentUrl, health, readiness, status, metadata });
  if (failures.length) throw new Error(`Public readiness failed before registration: ${failures.join(", ")}`);
  const quote = await requestJson(endpoint("/negotiate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task_description: "HealthBench v1 registration readiness probe; no job will be created.", terms: { deliverables: "Signed readiness response only", quality_standards: "Must identify BSC Testnet, U, price, and expiry", success_criteria: ["No onchain job"] }, request_id: `registration-readiness-${Date.now()}` }) });
  const envelope = quote.body || {};
  const responseBody = envelope.response || envelope;
  const accepted = responseBody.accepted === true;
  const price = responseBody.price || responseBody.terms?.price;
  const currency = responseBody.currency || responseBody.terms?.currency;
  const expiry = responseBody.quote_expires_at || responseBody.quoteExpiresAt;
  if (!quote.ok || !accepted || String(price) !== "1000000000000000" || String(currency).toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase() || !(Number(expiry) > Math.floor(Date.now() / 1000)) || !envelope.provider_sig || !envelope.negotiation_hash) throw new Error("Public readiness did not return a current bounded signed quote.");
  const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com"] } } };
  const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 12_000 }) });
  const signature = await verifyQuoteSignature({ envelope, provider: status.body.provider, publicClient, expectedVerifyingContract: REFERENCE_ERC8183_COMMERCE_PROXY });
  if (!signature?.valid || signature.signer.toLowerCase() !== String(status.body.provider).toLowerCase()) throw new Error("Public quote signature or provider match failed before registration.");
  return { provider: status.body.provider, quote: { priceRaw: String(price), currency, expiresAt: Number(expiry), signatureValid: true, signer: signature.signer }, readinessCheckedAt: new Date().toISOString() };
}

const publicReadiness = await verifyPublicReadiness();
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const walletsDir = path.join(dataDir, "state", "reference-provider-wallets");
const passwordFile = path.join(dataDir, "state", "reference-provider-wallet-password.txt");
const password = (env.CANNED_REFERENCE_PROVIDER_PASSWORD || await readFile(passwordFile, "utf8")).trim();
const providerAddress = env.CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS || EVMWalletProvider.listWallets(walletsDir)[0];
if (!providerAddress) throw new Error("Reference provider wallet is not configured.");
const wallet = new EVMWalletProvider({ password, address: providerAddress, walletsDir, persist: true });
try {
  const sdk = await ERC8004Agent.create({ walletProvider: wallet, network: REFERENCE_NETWORK });
  const metadata = publicHealthGuardMetadata({ agentUrl, providerAddress: wallet.address });
  const endpoint = new AgentEndpoint({ name: "ERC-8183", endpoint: agentUrl, version: metadata.version, capabilities: ["health", "readiness", "signed-quotes", "provider-storage-delivery"] });
  const agentUri = sdk.generateAgentUri({ name: metadata.name, description: metadata.description, endpoints: [endpoint], supportedTrust: ["ERC-8183", "CANNED_REFERENCE"] });
  const result = await sdk.registerAgent(agentUri, [
    { key: "category", value: metadata.category },
    { key: "origin", value: metadata.origin },
    { key: "network", value: REFERENCE_NETWORK },
    { key: "chain_id", value: String(REFERENCE_CHAIN_ID) },
    { key: "provider", value: wallet.address },
    { key: "service_endpoint", value: agentUrl },
    { key: "service_version", value: metadata.version },
  ]);
  const info = result.agentId === null ? null : await sdk.getAgentInfo(result.agentId);
  const record = { schemaVersion: 1, name: metadata.name, origin: metadata.origin, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, agentId: result.agentId, registry: sdk.contractAddress, transactionHash: result.transactionHash, agentUri: result.agentURI, provider: wallet.address, endpoint: agentUrl, publicReadinessVerified: true, quoteVerified: true, negotiationProbe: publicReadiness.quote, readinessCheckedAt: publicReadiness.readinessCheckedAt, onchain: info, indexer: "pending_independent_8004scan_check" };
  await mkdir(path.join(dataDir, "state"), { recursive: true });
  await writeFile(path.join(dataDir, "state", "reference-health-identity.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ status: "erc8004_registered", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, agentId: result.agentId, registry: sdk.contractAddress, transactionHash: result.transactionHash, endpoint: agentUrl, provider: wallet.address, indexer: "pending_independent_8004scan_check", secretOutput: "none" }, null, 2));
} finally { wallet.destroy(); }
