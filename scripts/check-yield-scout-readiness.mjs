import { createPublicClient, http } from "viem";
import { verifyQuoteSignature } from "@bnbagent/sdk/erc8183";
import { requestJson, isPublicHttpUrl } from "../src/core.mjs";
import { CATEGORY_LABELS } from "../src/domain.mjs";
import { referenceSpec, REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { publicReadinessFailures } from "../src/deploy/readiness.mjs";

const spec = referenceSpec("yield");
const expectedCategory = CATEGORY_LABELS[spec.category];
const agentUrl = process.env.CANNED_YIELD_AGENT_URL;
if (!isPublicHttpUrl(agentUrl)) throw new Error("CANNED_YIELD_AGENT_URL must be a public HTTP(S) URL; localhost is not accepted.");
const at = (suffix) => new URL(suffix, `${agentUrl.replace(/\/$/, "")}/`).toString();

const [health, readiness, status, metadata] = await Promise.all(["/health", "/readiness", "/status", "/metadata"].map((suffix) => requestJson(at(suffix))));
const failures = publicReadinessFailures({ agentUrl, health, readiness, status, metadata, expectedCategory });

const quoteRequest = {
  task_description: "YieldBench v1 readiness probe; no job will be created.",
  terms: { deliverables: "Signed readiness response only", quality_standards: "Must identify BSC Testnet, U, price, and expiry", success_criteria: ["No onchain job"] },
  request_id: `yield-readiness-${Date.now()}`,
};
const quote = await requestJson(at("/negotiate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: quoteRequest });
const envelope = quote.body || {};
const responseBody = envelope.response || envelope;
const price = responseBody.price || responseBody.terms?.price;
const currency = responseBody.currency || responseBody.terms?.currency;
const expiry = responseBody.quote_expires_at || responseBody.quoteExpiresAt;
if (!quote.ok || responseBody.accepted !== true || !envelope.provider_sig || !envelope.negotiation_hash) failures.push("signed_quote");
if (String(price) !== spec.priceRaw) failures.push("quote_price");
if (String(currency).toLowerCase() !== REFERENCE_PAYMENT_TOKEN.toLowerCase()) failures.push("quote_currency");
if (!(Number(expiry) > Math.floor(Date.now() / 1000))) failures.push("quote_expiry");

let signature = null;
if (quote.ok && envelope.provider_sig && envelope.negotiation_hash) {
  // A single read endpoint is a single point of failure for a readiness verdict.
  // Try each in turn so a dropped request is not reported as a bad signature.
  const candidates = [process.env.RPC_URL_BSC_TESTNET, process.env.CANNED_RPC_URL, "https://bsc-testnet-rpc.publicnode.com", "https://bsc-prebsc-dataseed.bnbchain.org"].filter(Boolean);
  let readError = null;
  for (const rpcUrl of candidates) {
    const chain = { id: REFERENCE_CHAIN_ID, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) });
    try {
      signature = await verifyQuoteSignature({ envelope, provider: status.body.provider, publicClient, expectedVerifyingContract: metadata.body?.protocols?.[0]?.verifyingContract || undefined });
      readError = null;
      break;
    } catch (error) { readError = error; }
  }
  if (readError) failures.push("quote_signature_read");
  if (signature && (!signature.valid || signature.signer.toLowerCase() !== String(status.body.provider).toLowerCase())) failures.push("quote_provider_match");
}

// A Yield Scout that could move capital would invalidate the benchmark.
if (status.body?.executionPolicy?.capitalMovement !== false) failures.push("execution_policy_allows_capital_movement");
if (status.body?.executionPolicy?.automaticIntervention !== false) failures.push("execution_policy_allows_automatic_intervention");
if (readiness.body?.rpc?.capable !== true) failures.push("rpc_capability_not_verified");

if (failures.length) throw new Error(`Yield Scout readiness failed: ${[...new Set(failures)].join(", ")}`);
console.log(JSON.stringify({
  status: "yield_scout_readiness_verified",
  agent: spec.name,
  category: expectedCategory,
  venue: spec.venue,
  network: REFERENCE_NETWORK,
  chainId: REFERENCE_CHAIN_ID,
  endpoint: agentUrl,
  provider: status.body.provider,
  quote: { accepted: true, priceRaw: String(price), currency, expiresAt: Number(expiry), signatureValid: signature?.valid === true, signer: signature?.valid ? signature.signer : null },
  storage: readiness.body.storage,
  worker: readiness.body.worker,
  watcher: readiness.body.watcher,
  rpc: readiness.body.rpc,
  executionPolicy: status.body.executionPolicy,
  secretOutput: "none",
}, null, 2));
