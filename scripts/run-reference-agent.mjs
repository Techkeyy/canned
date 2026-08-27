import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ReferenceAgentRuntime } from "../src/reference/foundation.mjs";
import { createReferenceSeller, negotiateReferenceQuote, startReferenceWatcher } from "../src/reference/erc8183-seller.mjs";
import { buildHealthFactorDeliverable } from "../src/reference/health-factor.mjs";
import { referenceSpec, REFERENCE_NETWORK, REFERENCE_CHAIN_ID } from "../src/reference/constants.mjs";
import { EVMWalletProvider } from "@bnbagent/sdk";

const env = process.env;
if (env.CANNED_REFERENCE_ALLOW_TESTNET_WRITES !== "true") throw new Error("Reference seller writes are disabled. Set CANNED_REFERENCE_ALLOW_TESTNET_WRITES=true only for an explicit testnet run.");
if ((env.CANNED_NETWORK || REFERENCE_NETWORK) !== REFERENCE_NETWORK || Number(env.CANNED_CHAIN_ID || REFERENCE_CHAIN_ID) !== REFERENCE_CHAIN_ID) throw new Error("Reference seller is restricted to BSC testnet chain 97.");
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const walletsDir = path.join(dataDir, "state", "reference-provider-wallets");
const passwordFile = path.join(dataDir, "state", "reference-provider-wallet-password.txt");
const password = (env.CANNED_REFERENCE_PROVIDER_PASSWORD || await readFile(passwordFile, "utf8")).trim();
const configuredAddresses = EVMWalletProvider.listWallets(walletsDir);
const providerAddress = env.CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS || (configuredAddresses.length === 1 ? configuredAddresses[0] : null);
if (!providerAddress) throw new Error("CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS is required.");
const wallet = new EVMWalletProvider({ password, address: providerAddress, walletsDir, persist: true });
const runtime = new ReferenceAgentRuntime({ spec: referenceSpec("health-factor"), taskHandler: ({ jobId, task, previousSnapshot }) => buildHealthFactorDeliverable({ jobId, task, previousSnapshot }) });
runtime.heartbeat({ state: "idle" });
const port = Number(env.CANNED_REFERENCE_PORT || 8790);
const agentUrl = env.CANNED_REFERENCE_AGENT_URL || `http://127.0.0.1:${port}/erc8183`;
const storageDir = path.join(dataDir, "state", "reference-deliverables");
const seller = await createReferenceSeller({ providerWallet: wallet, runtime, storageDir, agentUrl });
async function requestBody(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); } }
async function taskFromFile() {
  const file = env.CANNED_REFERENCE_TASK_FILE;
  if (!file) throw new Error("CANNED_REFERENCE_TASK_FILE is required; the seller will not invent a Venus position.");
  return JSON.parse(await readFile(path.resolve(file), "utf8"));
}
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", env.CANNED_REFERENCE_AGENT_URL || "http://127.0.0.1").pathname;
  if (request.method === "GET" && pathname.endsWith("/health")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(runtime.health())); return; }
  if (request.method === "GET" && pathname.endsWith("/readiness")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(runtime.readiness())); return; }
  if (request.method === "POST" && pathname.endsWith("/negotiate")) {
    try { const result = await negotiateReferenceQuote({ seller, request: await requestBody(request) }); response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(result)); } catch (error) { response.writeHead(422, { "Content-Type": "application/json" }); response.end(JSON.stringify({ accepted: false, reason: error.message })); }
    return;
  }
  const deliverable = pathname.match(/\/job\/(\d+)\/response$/);
  if (request.method === "GET" && deliverable) {
    try { const body = await readFile(path.join(storageDir, `erc8183-job-${deliverable[1]}.json`), "utf8"); response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(body); } catch { response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "deliverable not yet available" })); }
    return;
  }
  response.writeHead(404, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "not found" }));
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
console.log(JSON.stringify({ status: "reference_seller_ready", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, providerAddress: wallet.address, identity: runtime.spec.identity, protocol: "ERC-8183", endpoint: agentUrl, watcher: "fundedJobWatcher", submitter: "ERC8183JobOps.submitResult", secretOutput: "none" }, null, 2));
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
await startReferenceWatcher({ seller, runtime, interval: 15, stop: abort.signal, taskResolver: async () => taskFromFile() });
wallet.destroy();
server.close();
