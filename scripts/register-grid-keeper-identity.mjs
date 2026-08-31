import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { AgentEndpoint, ERC8004Agent } from "@bnbagent/sdk/erc8004";
import { verifyQuoteSignature } from "@bnbagent/sdk/erc8183";
import { isPublicHttpUrl, requestJson } from "../src/core.mjs";
import { CATEGORY_LABELS } from "../src/domain.mjs";
import { referenceSpec, REFERENCE_CHAIN_ID, REFERENCE_ERC8183_COMMERCE_PROXY, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN, REFERENCE_WALLET_PATHS } from "../src/reference/constants.mjs";
import { publicReferenceMetadata } from "../src/reference/public-service.mjs";
import { publicReadinessFailures, referenceFleetIdentityFailures } from "../src/deploy/readiness.mjs";

const env = process.env;
const spec = referenceSpec("grid");
const expectedCategory = CATEGORY_LABELS[spec.category];
if (env.CANNED_ALLOW_TESTNET_WRITES !== "true" || env.CANNED_GRID_REGISTER_CONFIRM !== "true") throw new Error("ERC-8004 registration requires explicit testnet write and registration confirmations; no write was attempted.");
const agentUrl = env.CANNED_GRID_AGENT_URL;
if (!isPublicHttpUrl(agentUrl)) throw new Error("Registration requires a public Grid Keeper URL; local URLs are rejected.");
if ((env.CANNED_NETWORK || REFERENCE_NETWORK) !== REFERENCE_NETWORK || Number(env.CANNED_CHAIN_ID || REFERENCE_CHAIN_ID) !== REFERENCE_CHAIN_ID) throw new Error("Registration is restricted to BSC Testnet chain 97.");

const at = (suffix) => new URL(suffix, `${agentUrl.replace(/\/$/, "")}/`).toString();
const [health, readiness, status, metadataResponse] = await Promise.all(["/health", "/readiness", "/status", "/metadata"].map((suffix) => requestJson(at(suffix))));
const failures = publicReadinessFailures({ agentUrl, health, readiness, status, metadata: metadataResponse, expectedCategory });
if (readiness.body?.rpc?.capable !== true) failures.push("rpc_capability_not_verified");
if (failures.length) throw new Error(`Public readiness failed before registration: ${[...new Set(failures)].join(", ")}`);

const quote = await requestJson(at("/negotiate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: { task_description: "GridBench v1 registration readiness probe; no job will be created.", terms: { deliverables: "Signed readiness response only", quality_standards: "Must identify BSC Testnet, U, price, and expiry", success_criteria: ["No onchain job"] }, request_id: `grid-registration-${Date.now()}` } });
const envelope = quote.body || {};
const responseBody = envelope.response || envelope;
const price = responseBody.price || responseBody.terms?.price;
const currency = responseBody.currency || responseBody.terms?.currency;
const expiry = responseBody.quote_expires_at || responseBody.quoteExpiresAt;
if (!quote.ok || responseBody.accepted !== true || String(price) !== spec.priceRaw || String(currency).toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase() || !(Number(expiry) > Math.floor(Date.now() / 1000)) || !envelope.provider_sig || !envelope.negotiation_hash) {
  throw new Error("Public readiness did not return a current bounded signed quote.");
}
const rpcUrl = env.RPC_URL_BSC_TESTNET || env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com";
const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) });
const signature = await verifyQuoteSignature({ envelope, provider: status.body.provider, publicClient, expectedVerifyingContract: REFERENCE_ERC8183_COMMERCE_PROXY });
if (!signature?.valid || signature.signer.toLowerCase() !== String(status.body.provider).toLowerCase()) throw new Error("Public quote signature or provider match failed before registration.");

const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const walletsDir = path.join(dataDir, "state", REFERENCE_WALLET_PATHS.grid.walletsDir);
const passwordFile = path.join(dataDir, "state", REFERENCE_WALLET_PATHS.grid.passwordFile);
const password = (env.CANNED_GRID_PROVIDER_PASSWORD || await readFile(passwordFile, "utf8")).trim();
const providerAddress = env.CANNED_GRID_PROVIDER_ADDRESS || EVMWalletProvider.listWallets(walletsDir)[0];
if (!providerAddress) throw new Error("Grid provider wallet is not configured.");
if (String(providerAddress).toLowerCase() !== String(status.body.provider).toLowerCase()) throw new Error("The local Grid provider wallet does not match the live provider address.");

// Two reference agents must never resolve to the same identity or endpoint.
const siblings = {};
for (const [key, file] of [["health-factor", "reference-health-identity.json"], ["rebalancing", "reference-range-identity.json"], ["yield", "reference-yield-identity.json"]]) {
  siblings[key] = await readFile(path.join(dataDir, "state", file), "utf8").then(JSON.parse).catch(() => null);
}
for (const [key, record] of Object.entries(siblings)) {
  if (!record) continue;
  if (String(record.provider).toLowerCase() === String(providerAddress).toLowerCase()) throw new Error(`Grid Keeper must not reuse the ${key} provider wallet.`);
  if (record.endpoint === agentUrl) throw new Error(`Grid Keeper must not reuse the ${key} endpoint.`);
  // 2003, 2005 and 2034 are already taken and must never be reused.
  if (record.agentId !== null && record.agentId !== undefined && String(record.agentId) === String(env.CANNED_GRID_AGENT_ID)) throw new Error(`Grid Keeper must not reuse ${key} agent id ${record.agentId}.`);
}

const wallet = new EVMWalletProvider({ password, address: providerAddress, walletsDir, persist: true });
try {
  const nativeBalance = await publicClient.getBalance({ address: wallet.address });
  const sdk = await ERC8004Agent.create({ walletProvider: wallet, network: REFERENCE_NETWORK });
  const metadata = publicReferenceMetadata({ agentUrl, providerAddress: wallet.address, referenceKey: spec.key });
  const endpoint = new AgentEndpoint({ name: "ERC-8183", endpoint: agentUrl, version: metadata.version, capabilities: ["health", "readiness", "signed-quotes", "provider-storage-delivery", "rpc-capability"] });
  const agentUri = sdk.generateAgentUri({ name: metadata.name, description: metadata.description, endpoints: [endpoint], supportedTrust: ["ERC-8183", "CANNED_REFERENCE"] });
  const result = await sdk.registerAgent(agentUri, [
    { key: "category", value: metadata.category },
    { key: "venue", value: metadata.venue || "PancakeSwap" },
    { key: "origin", value: metadata.origin },
    { key: "network", value: REFERENCE_NETWORK },
    { key: "chain_id", value: String(REFERENCE_CHAIN_ID) },
    { key: "provider", value: wallet.address },
    { key: "service_endpoint", value: agentUrl },
    { key: "service_version", value: metadata.version },
    // Recorded on chain because it is the one thing a buyer most needs to
    // know about this agent, and it differs from every sibling.
    { key: "execution_policy", value: "bounded_session_key_execution_user_revocable" },
    { key: "execution_model", value: "agent_managed_price_triggered_execution" },
  ]);
  const info = result.agentId === null ? null : await sdk.getAgentInfo(result.agentId);
  const record = {
    schemaVersion: 1,
    referenceKey: spec.key,
    name: metadata.name,
    origin: metadata.origin,
    category: metadata.category,
    venue: metadata.venue,
    network: REFERENCE_NETWORK,
    chainId: REFERENCE_CHAIN_ID,
    agentId: result.agentId,
    registry: sdk.contractAddress,
    transactionHash: result.transactionHash,
    agentUri: result.agentURI,
    provider: wallet.address,
    endpoint: agentUrl,
    publicReadinessVerified: true,
    quoteVerified: true,
    negotiationProbe: { priceRaw: String(price), currency, expiresAt: Number(expiry), signatureValid: true, signer: signature.signer },
    readinessCheckedAt: new Date().toISOString(),
    providerNativeBalanceWeiAtRegistration: nativeBalance.toString(),
    onchain: info,
    indexer: "pending_independent_8004scan_check",
  };
  const fleetFailures = referenceFleetIdentityFailures({ ...siblings, grid: record });
  if (fleetFailures.length) throw new Error(`Reference fleet identity collision: ${fleetFailures.join(", ")}`);
  await mkdir(path.join(dataDir, "state"), { recursive: true });
  await writeFile(path.join(dataDir, "state", "reference-grid-identity.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ status: "erc8004_registered", agent: metadata.name, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, agentId: result.agentId, registry: sdk.contractAddress, transactionHash: result.transactionHash, endpoint: agentUrl, provider: wallet.address, distinctFromSiblings: Object.values(siblings).filter(Boolean).every((entry) => entry.agentId !== result.agentId), indexer: "pending_independent_8004scan_check", secretOutput: "none" }, null, 2));
} finally { wallet.destroy(); }
