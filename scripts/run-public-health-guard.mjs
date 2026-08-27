import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { ReferenceAgentRuntime } from "../src/reference/foundation.mjs";
import { createReferenceSeller, negotiateReferenceQuote, processFundedReferenceJob, startReferenceWatcher } from "../src/reference/erc8183-seller.mjs";
import { buildHealthFactorDeliverable } from "../src/reference/health-factor.mjs";
import { healthBenchProviderTask } from "../src/reference/health-benchmark.mjs";
import { referenceSpec, REFERENCE_NETWORK, REFERENCE_CHAIN_ID, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { publicHealthGuardMetadata, publicReadinessSummary, validatePublicReferenceConfig } from "../src/reference/public-service.mjs";

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const agentUrl = env.CANNED_REFERENCE_AGENT_URL;
const publicConfig = validatePublicReferenceConfig({ agentUrl, chainId: env.CANNED_CHAIN_ID || REFERENCE_CHAIN_ID, network: env.CANNED_NETWORK || REFERENCE_NETWORK });
if (!publicConfig.valid) throw new Error(`Public Health Guard configuration rejected: ${publicConfig.errors.join(", ")}`);
const fulfillmentEnabled = env.CANNED_REFERENCE_ENABLE_FULFILLMENT === "true";
if (fulfillmentEnabled && env.CANNED_REFERENCE_ALLOW_TESTNET_WRITES !== "true") throw new Error("Fulfillment requires CANNED_REFERENCE_ALLOW_TESTNET_WRITES=true; no write was attempted.");

const walletsDir = path.join(dataDir, "state", "reference-provider-wallets");
const passwordFile = path.join(dataDir, "state", "reference-provider-wallet-password.txt");
const password = (env.CANNED_REFERENCE_PROVIDER_PASSWORD || await readFile(passwordFile, "utf8")).trim();
const configuredAddresses = EVMWalletProvider.listWallets(walletsDir);
const providerAddress = env.CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS || (configuredAddresses.length === 1 ? configuredAddresses[0] : null);
if (!providerAddress) throw new Error("CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS is required.");
const wallet = new EVMWalletProvider({ password, address: providerAddress, walletsDir, persist: true });
const runtime = new ReferenceAgentRuntime({ spec: referenceSpec("health-factor"), taskHandler: ({ jobId, task, previousSnapshot }) => buildHealthFactorDeliverable({ jobId, task, previousSnapshot }) });
if (fulfillmentEnabled) runtime.heartbeat({ state: "idle" });
const storageDir = path.join(dataDir, "state", "reference-deliverables");
const seller = await createReferenceSeller({ providerWallet: wallet, runtime, storageDir, agentUrl, publicMode: true });
const metadata = publicHealthGuardMetadata({ agentUrl, providerAddress: wallet.address });
const baseUrl = new URL(agentUrl);
const taskFile = env.CANNED_REFERENCE_TASK_FILE ? path.resolve(env.CANNED_REFERENCE_TASK_FILE) : null;

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
}

async function taskFromFile() {
  if (!taskFile) throw new Error("HealthBench task file is not configured; no task was executed.");
  const definition = JSON.parse(await readFile(taskFile, "utf8"));
  if (definition?.benchmarkId !== "HealthBench_v1" || definition?.immutable !== true) throw new Error("Only an immutable HealthBench_v1 definition may be executed.");
  return healthBenchProviderTask(definition);
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  response.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", agentUrl);
    if (request.method === "GET" && (url.pathname === `${baseUrl.pathname}/health` || url.pathname === "/health")) { json(response, 200, runtime.health()); return; }
    if (request.method === "GET" && (url.pathname === `${baseUrl.pathname}/readiness` || url.pathname === "/readiness")) { json(response, 200, publicReadinessSummary({ runtime, providerAddress: wallet.address, agentUrl, storageMode: seller.storageMode, fulfillmentEnabled, metadata })); return; }
    if (request.method === "GET" && (url.pathname === `${baseUrl.pathname}/status` || url.pathname === "/status")) {
      json(response, 200, { ok: true, name: metadata.name, category: metadata.category, origin: metadata.origin, network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, provider: wallet.address, paymentToken: REFERENCE_PAYMENT_TOKEN, priceRaw: referenceSpec("health-factor").priceRaw, currency: REFERENCE_PAYMENT_TOKEN, quote: "signed_provider_quote", storage: seller.storageMode, fulfillmentEnabled, serviceVersion: metadata.version });
      return;
    }
    if (request.method === "GET" && (url.pathname === `${baseUrl.pathname}/metadata` || url.pathname === "/metadata" || url.pathname === "/.well-known/agent.json")) { json(response, 200, metadata); return; }
    if (request.method === "POST" && (url.pathname === `${baseUrl.pathname}/negotiate` || url.pathname === "/negotiate")) {
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

const bindHost = env.CANNED_REFERENCE_BIND_HOST || "0.0.0.0";
const port = Number(env.PORT || env.CANNED_REFERENCE_PORT || 8790);
await new Promise((resolve) => server.listen(port, bindHost, resolve));
console.log(JSON.stringify({ status: "public_reference_service_ready", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, providerAddress: wallet.address, identity: runtime.spec.identity, protocol: "ERC-8183", endpoint: agentUrl, storage: seller.storageMode, fulfillmentEnabled, secretOutput: "none" }, null, 2));

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
if (fulfillmentEnabled) {
  await startReferenceWatcher({ seller, runtime, interval: 15, stop: abort.signal, taskResolver: async () => taskFromFile() });
} else {
  await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
}
wallet.destroy();
server.close();
