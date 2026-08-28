import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { ReferenceAgentRuntime } from "../src/reference/foundation.mjs";
import { createReferenceSeller, negotiateReferenceQuote, startReferenceWatcher } from "../src/reference/erc8183-seller.mjs";
import { buildYieldScoutDeliverable } from "../src/reference/yield-scout.mjs";
import { yieldBenchProviderTask, YIELD_BENCHMARK_ID } from "../src/reference/yield-benchmark.mjs";
import { referenceSpec, REFERENCE_NAMESPACES, REFERENCE_WALLET_PATHS, REFERENCE_NETWORK, REFERENCE_CHAIN_ID, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { publicReferenceMetadata, publicReadinessSummary, validatePublicReferenceConfig } from "../src/reference/public-service.mjs";
import { probeRpcCapability, sdkRpcEnvironment } from "../src/deploy/rpc-capability.mjs";
import { nowIso } from "../src/core.mjs";

const REFERENCE_KEY = "yield";
const NAMESPACE = REFERENCE_NAMESPACES[REFERENCE_KEY];
const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const agentUrl = env.CANNED_YIELD_AGENT_URL;
const publicConfig = validatePublicReferenceConfig({ agentUrl, chainId: env.CANNED_CHAIN_ID || REFERENCE_CHAIN_ID, network: env.CANNED_NETWORK || REFERENCE_NETWORK });
if (!publicConfig.valid) throw new Error(`Public Yield Scout configuration rejected: ${publicConfig.errors.join(", ")}`);
const fulfillmentEnabled = env.CANNED_YIELD_ENABLE_FULFILLMENT === "true";
if (fulfillmentEnabled && env.CANNED_YIELD_ALLOW_TESTNET_WRITES !== "true") throw new Error("Fulfillment requires CANNED_YIELD_ALLOW_TESTNET_WRITES=true; no write was attempted.");

// The lesson from Verified Run #1: refuse to start a funded-job watcher on an
// RPC that cannot serve the log range verifyJob performs. A healthy HTTP
// surface over a blind watcher is worse than not starting at all.
const rpcEnvironment = sdkRpcEnvironment(env, REFERENCE_NETWORK);
let rpcCapability = { ...(await probeRpcCapability({ rpcUrl: rpcEnvironment.effectiveRpcUrl })), environment: rpcEnvironment, checkedAt: nowIso() };
if (fulfillmentEnabled && rpcCapability.capable !== true) {
  throw new Error(`Refusing to start the funded-job watcher: ${rpcCapability.reason} Set ${rpcEnvironment.perNetworkKey} to an endpoint that serves it. Note that CANNED_RPC_URL is not read by the BNB SDK.`);
}

const walletPaths = REFERENCE_WALLET_PATHS[REFERENCE_KEY];
const walletsDir = path.join(dataDir, "state", walletPaths.walletsDir);
const passwordFile = path.join(dataDir, "state", walletPaths.passwordFile);
const password = (env.CANNED_YIELD_PROVIDER_PASSWORD || await readFile(passwordFile, "utf8")).trim();
const configuredAddresses = EVMWalletProvider.listWallets(walletsDir);
const providerAddress = env.CANNED_YIELD_PROVIDER_ADDRESS || (configuredAddresses.length === 1 ? configuredAddresses[0] : null);
if (!providerAddress) throw new Error("CANNED_YIELD_PROVIDER_ADDRESS is required.");
const wallet = new EVMWalletProvider({ password, address: providerAddress, walletsDir, persist: true });

const spec = referenceSpec(REFERENCE_KEY);
const runtime = new ReferenceAgentRuntime({ spec, taskHandler: ({ jobId, task }) => buildYieldScoutDeliverable({ jobId, task }) });
if (fulfillmentEnabled) runtime.heartbeat({ state: "idle" });
const storageDir = path.join(dataDir, "state", NAMESPACE.deliverables);
const seller = await createReferenceSeller({ providerWallet: wallet, runtime, storageDir, agentUrl, publicMode: true, servicePriceRaw: spec.priceRaw });
const registeredAgentId = env.CANNED_YIELD_AGENT_ID ? Number(env.CANNED_YIELD_AGENT_ID) : null;
const registeredRegistry = env.CANNED_YIELD_REGISTRY || null;
if (registeredAgentId !== null && (!Number.isInteger(registeredAgentId) || !registeredRegistry)) throw new Error("CANNED_YIELD_AGENT_ID requires a matching CANNED_YIELD_REGISTRY.");
const metadata = publicReferenceMetadata({ agentUrl, providerAddress: wallet.address, agentId: registeredAgentId, registry: registeredRegistry, referenceKey: REFERENCE_KEY });
const baseUrl = new URL(agentUrl);
const taskFile = env.CANNED_YIELD_TASK_FILE ? path.resolve(env.CANNED_YIELD_TASK_FILE) : null;

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
}

async function taskFromFile() {
  if (!taskFile) throw new Error("YieldBench task file is not configured; no task was executed.");
  const definition = JSON.parse(await readFile(taskFile, "utf8"));
  if (definition?.benchmarkId !== YIELD_BENCHMARK_ID || definition?.immutable !== true) throw new Error("Only an immutable YieldBench_v1 definition may be executed.");
  return yieldBenchProviderTask(definition);
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", agentUrl);
    const at = (suffix) => url.pathname === `${baseUrl.pathname}${suffix}` || url.pathname === suffix;
    if (request.method === "GET" && at("/health")) { json(response, 200, runtime.health()); return; }
    if (request.method === "GET" && at("/readiness")) { json(response, 200, publicReadinessSummary({ runtime, providerAddress: wallet.address, agentUrl, storageMode: seller.storageMode, fulfillmentEnabled, metadata, rpc: rpcCapability })); return; }
    if (request.method === "GET" && at("/status")) {
      json(response, 200, { ok: true, name: metadata.name, category: metadata.category, venue: metadata.venue, origin: metadata.origin, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, provider: wallet.address, paymentToken: REFERENCE_PAYMENT_TOKEN, priceRaw: spec.priceRaw, currency: REFERENCE_PAYMENT_TOKEN, quote: "signed_provider_quote", storage: seller.storageMode, fulfillmentEnabled, serviceVersion: metadata.version, executionPolicy: spec.executionPolicy });
      return;
    }
    if (request.method === "GET" && (at("/metadata") || url.pathname === "/.well-known/agent.json")) { json(response, 200, metadata); return; }
    if (request.method === "GET" && at("/rpc")) { json(response, 200, { capable: rpcCapability.capable, checks: rpcCapability.checks, reason: rpcCapability.reason, configuredVia: rpcEnvironment.perNetworkConfigured ? rpcEnvironment.perNetworkKey : rpcEnvironment.genericConfigured ? "RPC_URL" : "sdk_default", usingSdkDefault: rpcEnvironment.usingSdkDefault, checkedAt: rpcCapability.checkedAt, secretOutput: "none" }); return; }
    if (request.method === "POST" && at("/negotiate")) {
      const result = await negotiateReferenceQuote({ seller, request: await requestBody(request) });
      json(response, 200, result);
      return;
    }
    const jobMatch = url.pathname.match(/(?:^|\/erc8183)\/job\/(\d+)$/);
    if (request.method === "GET" && jobMatch) { const result = await seller.jobOps.getJob(Number(jobMatch[1])); json(response, result.success === false ? 404 : 200, result); return; }
    const responseMatch = url.pathname.match(/(?:^|\/erc8183)\/job\/(\d+)\/response$/);
    if (request.method === "GET" && responseMatch) { const result = await seller.jobOps.getResponse(Number(responseMatch[1])); json(response, result.success === false ? 404 : 200, result); return; }
    json(response, 404, { error: "not found" });
  } catch (error) { json(response, 422, { error: "request rejected", reason: error.message }); }
});

const bindHost = env.CANNED_YIELD_BIND_HOST || "0.0.0.0";
const port = Number(env.PORT || env.CANNED_YIELD_PORT || NAMESPACE.port);
await new Promise((resolve) => server.listen(port, bindHost, resolve));
console.log(JSON.stringify({ status: "public_reference_service_ready", agent: spec.name, referenceKey: REFERENCE_KEY, venue: spec.venue, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, providerAddress: wallet.address, identity: spec.identity, protocol: "ERC-8183", endpoint: agentUrl, storage: seller.storageMode, fulfillmentEnabled, rpc: { capable: rpcCapability.capable, configuredVia: rpcEnvironment.perNetworkConfigured ? rpcEnvironment.perNetworkKey : "sdk_default" }, secretOutput: "none" }, null, 2));

const abort = new AbortController();
const heartbeatTimer = setInterval(() => runtime.refreshHeartbeats(), 30_000);
heartbeatTimer.unref?.();
// Re-probe periodically so a provider that silently loses log access stops
// reporting itself ready instead of accepting jobs it cannot serve.
const rpcTimer = setInterval(async () => {
  try { rpcCapability = { ...(await probeRpcCapability({ rpcUrl: rpcEnvironment.effectiveRpcUrl })), environment: rpcEnvironment, checkedAt: nowIso() }; } catch { /* keep the previous observation */ }
}, 300_000);
rpcTimer.unref?.();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
if (fulfillmentEnabled) {
  await startReferenceWatcher({ seller, runtime, interval: 15, stop: abort.signal, taskResolver: async () => taskFromFile() });
} else {
  await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
}
clearInterval(heartbeatTimer);
clearInterval(rpcTimer);
wallet.destroy();
server.close();
