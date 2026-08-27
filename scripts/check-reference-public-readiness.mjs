import { createPublicClient, http } from "viem";
import { verifyQuoteSignature } from "@bnbagent/sdk/erc8183";
import { requestJson, isPublicHttpUrl } from "../src/core.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";

const agentUrl = process.env.CANNED_REFERENCE_AGENT_URL;
if (!isPublicHttpUrl(agentUrl)) throw new Error("CANNED_REFERENCE_AGENT_URL must be a public HTTP(S) URL; localhost is not accepted.");
const required = (suffix) => new URL(suffix, `${agentUrl.replace(/\/$/, "")}/`).toString();
const [health, readiness, status, metadata] = await Promise.all(["/health", "/readiness", "/status", "/metadata"].map((suffix) => requestJson(required(suffix))));
const failures = [];
if (!health.ok || health.body?.chainId !== REFERENCE_CHAIN_ID) failures.push("health_chain_guard");
if (!readiness.ok || readiness.body?.network !== REFERENCE_NETWORK) failures.push("readiness_network");
if (readiness.body?.endpoint?.transport !== "public_http") failures.push("public_transport");
if (readiness.body?.storage?.public !== true) failures.push("durable_public_storage");
if (!status.ok || status.body?.paymentToken?.toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase()) failures.push("payment_token");
if (!metadata.ok || metadata.body?.origin !== "CANNED_REFERENCE" || metadata.body?.category !== "Health Factor Monitoring") failures.push("metadata_provenance");
const quoteRequest = { task_description: "HealthBench v1 readiness probe; no job will be created.", terms: { deliverables: "Signed readiness response only", quality_standards: "Must identify BSC Testnet, U, price, and expiry", success_criteria: "No onchain job" }, request_id: `readiness-${Date.now()}` };
const quote = await requestJson(required("/negotiate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: quoteRequest });
const envelope = quote.body || {};
const responseBody = envelope.response || envelope;
const price = responseBody.price || responseBody.terms?.price;
const currency = responseBody.currency || responseBody.terms?.currency;
const expiry = responseBody.quote_expires_at || responseBody.quoteExpiresAt;
if (!quote.ok || envelope.accepted !== true || !envelope.provider_sig || !envelope.negotiation_hash) failures.push("signed_quote");
if (String(price) !== "1000000000000000") failures.push("quote_price");
if (String(currency).toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase()) failures.push("quote_currency");
if (!(Number(expiry) > Math.floor(Date.now() / 1000))) failures.push("quote_expiry");
let signature = null;
if (quote.ok && envelope.provider_sig && envelope.negotiation_hash) {
  const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [process.env.CANNED_RPC_URL || "https://bsc-testnet-rpc.publicnode.com"] } } };
  const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 12_000 }) });
  try { signature = await verifyQuoteSignature({ envelope, provider: status.body.provider, publicClient, expectedVerifyingContract: metadata.body?.protocols?.[0]?.verifyingContract || undefined }); } catch (error) { failures.push("quote_signature_read"); }
  if (signature && (!signature.valid || signature.signer.toLowerCase() !== String(status.body.provider).toLowerCase())) failures.push("quote_provider_match");
}
if (failures.length) throw new Error(`Public readiness failed: ${failures.join(", ")}`);
console.log(JSON.stringify({ status: "public_readiness_verified", network: REFERENCE_NETWORK, chainId: REFERENCE_CHAIN_ID, endpoint: agentUrl, provider: status.body.provider, quote: { accepted: true, priceRaw: String(price), currency, expiresAt: Number(expiry), signatureValid: signature?.valid === true, signer: signature?.valid ? signature.signer : null }, storage: readiness.body.storage, worker: readiness.body.worker, watcher: readiness.body.watcher, secretOutput: "none" }, null, 2));
