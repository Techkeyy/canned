import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, parseAbi } from "viem";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { ERC8004Agent } from "@bnbagent/sdk/erc8004";
import { REFERENCE_CHAIN_ID, REFERENCE_IDENTITY_FILES, REFERENCE_NETWORK, REFERENCE_WALLET_PATHS } from "../src/reference/constants.mjs";
import { referenceIdentityBindingFailures } from "../src/deploy/readiness.mjs";
import { indexerOwnerMatches, lookupIndexedAgent } from "../src/discovery/identity-lookup.mjs";

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const referenceKey = process.argv[2] || process.env.CANNED_REFERENCE_KEY || "health-factor";
const identityFile = REFERENCE_IDENTITY_FILES[referenceKey];
if (!identityFile) throw new Error(`Unknown reference agent key: ${referenceKey}. Known keys: ${Object.keys(REFERENCE_IDENTITY_FILES).join(", ")}`);
const record = JSON.parse(await readFile(path.join(dataDir, identityFile.replace("state/", "state" + path.sep)), "utf8"));
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

const walletPaths = REFERENCE_WALLET_PATHS[referenceKey];
if (!walletPaths) throw new Error(`No wallet configuration for reference agent key: ${referenceKey}`);
const walletsDir = path.join(dataDir, "state", walletPaths.walletsDir);
const passwordFile = path.join(dataDir, "state", walletPaths.passwordFile);
const password = (env[walletPaths.passwordEnv] || await readFile(passwordFile, "utf8")).trim();
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
  const lookup = await lookupIndexedAgent({ chainId: REFERENCE_CHAIN_ID, agentId: Number(record.agentId) });
  const indexed = lookup.indexed;
  const indexerLookup = { method: lookup.method, pagesScanned: lookup.pagesScanned, httpStatus: lookup.httpStatus, ...(lookup.record || {}) };
  const ownerMatch = indexerOwnerMatches({ lookup, expectedOwner: record.provider });
  const identityFailures = referenceIdentityBindingFailures({ identity: { agentId: Number(record.agentId), registry: record.registry, provider: directOwner, endpoint: resolvedEndpoint }, status: { provider: record.provider }, metadata: { origin: record.origin, category: record.category || "Health Factor Monitoring" }, expectedCategory: record.category || "Health Factor Monitoring", agentUrl: record.endpoint });
  if (ownerMatch === false) identityFailures.push("indexer_owner_mismatch");
  if (directOwner.toLowerCase() !== record.provider.toLowerCase()) identityFailures.push("direct_owner_mismatch");
  if (directUri !== sdkInfo.agentURI) identityFailures.push("direct_sdk_uri_mismatch");
  if (sdkInfo.agentId !== Number(record.agentId)) identityFailures.push("sdk_agent_id_mismatch");
  if (identityFailures.length) throw new Error(`Reference identity verification failed: ${[...new Set(identityFailures)].join(", ")}`);
  console.log(JSON.stringify({ status: "reference_identity_verified", referenceKey, agent: record.name, category: record.category || null, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, agentId: Number(record.agentId), registry: record.registry, owner: directOwner, provider: record.provider, directRegistryRead: true, sdkResolution: true, endpoint: record.endpoint, indexed8004scan: indexed, indexerState: indexed ? "indexed" : "onchain_registered_not_yet_indexed", indexerLookup, secretOutput: "none" }, null, 2));
} finally { providerWallet.destroy(); }
