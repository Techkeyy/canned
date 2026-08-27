import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { ERC8004Agent } from "@bnbagent/sdk/erc8004";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK } from "../src/reference/constants.mjs";
import { referenceIdentityBindingFailures } from "../src/deploy/readiness.mjs";
import { Eight004ScanAdapter } from "../src/discovery/8004scan.mjs";

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const record = JSON.parse(await readFile(path.join(dataDir, "state", "reference-health-identity.json"), "utf8"));
if (record?.network !== REFERENCE_NETWORK || Number(record.chainId) !== REFERENCE_CHAIN_ID || record?.agentId === null || record?.agentId === undefined) throw new Error("Reference identity record is incomplete or not BSC Testnet.");
if (!record.endpoint || !record.provider) throw new Error("Reference identity record lacks endpoint or provider.");

const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com"] } } };
const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 12_000 }) });
const registryAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function getAgentWallet(uint256 agentId) view returns (address)", "function tokenURI(uint256 tokenId) view returns (string)"]);
const [directOwner, directWallet, directUri] = await Promise.all([
  publicClient.readContract({ address: record.registry, abi: registryAbi, functionName: "ownerOf", args: [BigInt(record.agentId)] }),
  publicClient.readContract({ address: record.registry, abi: registryAbi, functionName: "getAgentWallet", args: [BigInt(record.agentId)] }),
  publicClient.readContract({ address: record.registry, abi: registryAbi, functionName: "tokenURI", args: [BigInt(record.agentId)] }),
]);

const walletsDir = path.join(dataDir, "state", "reference-provider-wallets");
const passwordFile = path.join(dataDir, "state", "reference-provider-wallet-password.txt");
const password = (env.CANNED_REFERENCE_PROVIDER_PASSWORD || await readFile(passwordFile, "utf8")).trim();
const providerWallet = new EVMWalletProvider({ password, address: record.provider, walletsDir, persist: true });
try {
  const sdkAgent = await ERC8004Agent.create({ walletProvider: providerWallet, network: REFERENCE_NETWORK });
  if (sdkAgent.contractAddress.toLowerCase() !== record.registry.toLowerCase()) throw new Error("SDK registry address does not match the recorded registry.");
  const sdkInfo = await sdkAgent.getAgentInfo(Number(record.agentId));
  const resolved = await ERC8004Agent.parseAgentUri(sdkInfo.agentURI);
  const services = resolved?.services || resolved?.endpoints || [];
  const resolvedEndpoint = services.map((service) => service?.endpoint).find(Boolean) || null;
  // Ask the indexer for this agent directly. Scanning only the first page of
  // getAllAgents reports a high token ID as unindexed when it is simply not on
  // page one, which understates the real indexing state.
  const scan = new Eight004ScanAdapter();
  const indexedResponse = await scan.detail(REFERENCE_CHAIN_ID, Number(record.agentId));
  const indexedBody = indexedResponse.ok ? indexedResponse.body : null;
  const indexed = String(indexedBody?.token_id ?? "") === String(record.agentId) && Number(indexedBody?.chain_id) === REFERENCE_CHAIN_ID;
  const indexerLookup = { ok: indexedResponse.ok, httpStatus: indexedResponse.status, canonicalAgentId: indexedBody?.agent_id ?? null, name: indexedBody?.name ?? null, ownerAddress: indexedBody?.owner_address ?? null };
  const identityFailures = referenceIdentityBindingFailures({ identity: { agentId: Number(record.agentId), registry: record.registry, provider: directOwner, endpoint: resolvedEndpoint }, status: { provider: record.provider }, metadata: { origin: record.origin, category: "Health Factor Monitoring" }, agentUrl: record.endpoint });
  if (indexed && String(indexedBody.owner_address).toLowerCase() !== String(record.provider).toLowerCase()) identityFailures.push("indexer_owner_mismatch");
  if (directOwner.toLowerCase() !== record.provider.toLowerCase()) identityFailures.push("direct_owner_mismatch");
  if (directUri !== sdkInfo.agentURI) identityFailures.push("direct_sdk_uri_mismatch");
  if (sdkInfo.agentId !== Number(record.agentId)) identityFailures.push("sdk_agent_id_mismatch");
  if (identityFailures.length) throw new Error(`Reference identity verification failed: ${[...new Set(identityFailures)].join(", ")}`);
  console.log(JSON.stringify({ status: "reference_identity_verified", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, agentId: Number(record.agentId), registry: record.registry, owner: directOwner, provider: record.provider, directRegistryRead: true, sdkResolution: true, endpoint: record.endpoint, indexed8004scan: indexed, indexerState: indexed ? "indexed" : "onchain_registered_not_yet_indexed", indexerLookup, secretOutput: "none" }, null, 2));
} finally { providerWallet.destroy(); }
