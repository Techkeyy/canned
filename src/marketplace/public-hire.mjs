import { contentHashes, nowIso, safeError } from "../core.mjs";
import { safeRequestJson } from "../net/egress-guard.mjs";
import { selectHiringAdapter } from "./adapters.mjs";
import { REFERENCE_PAYMENT_TOKEN } from "../reference/constants.mjs";
import { formatUnits, hireAddresses, hireReadClient, isAddress } from "../protocol/hire-tx.mjs";
import { QUOTE_TTL_SECONDS, validateTask } from "./hire-store.mjs";

/**
 * Public-hire domain: who can be hired, and the fresh-quote primitive.
 *
 * Hireability is derived, never asserted. The marketplace-time derivation
 * verifies every *static* prerequisite from stored observations; the
 * per-attempt *fresh* prerequisites (live negotiation, accepted quote, valid
 * signature, sufficient expiry) are verified inside the quote call itself,
 * because a stored quote is a stale quote.
 */

export const HIRE_STATUSES = Object.freeze({
  HIREABLE: "HIREABLE",
  VERIFIED_NOT_HIREABLE: "VERIFIED — NOT CURRENTLY HIREABLE",
  DISCOVERED: "DISCOVERED — NOT VERIFIED",
  UNAVAILABLE: "UNAVAILABLE",
  UNKNOWN: "UNKNOWN",
});

/** Hard ceiling for any single public hire: 0.01 payment-token units. */
export const MAX_PUBLIC_PRICE_RAW = 10_000_000_000_000_000n;

function check(name, pass, detail) {
  return { name, pass: pass === true, detail: detail || null };
}

/** Where a fresh public quote negotiation happens, or null when unknown. */
export function negotiateUrlFor(candidate) {
  const endpoint = candidate?.services?.[0]?.endpoint || null;
  if (typeof endpoint === "string" && /^https:\/\/[^/]+\/erc8183\/?$/.test(endpoint)) {
    return `${endpoint.replace(/\/+$/, "")}/negotiate`;
  }
  const probed = (candidate?.probes || []).find((probe) => typeof probe?.negotiateEndpoint === "string" && probe.negotiateEndpoint.startsWith("https://"));
  if (probed) return probed.negotiateEndpoint;
  return null;
}

/** Whether the provider has a known job-notification path. */
export function notificationPathFor(candidate, runs = []) {
  if (candidate?.reference === true) {
    const delivered = runs.some(
      (run) => run?.agent?.identity === candidate.identity && run?.protocolJob?.funded === true && run?.terminalState === "completed",
    );
    return {
      kind: "onchain_watcher",
      verified: true,
      detail: delivered
        ? "Reference provider runs a funded-job watcher; past funded jobs were detected and delivered without any off-chain notification."
        : "Reference provider runs a funded-job watcher; the chain is the notification.",
    };
  }
  const cardText = JSON.stringify(candidate?.probes || []).toLowerCase();
  if (/notify_funded|notify-funded/.test(cardText)) {
    return { kind: "notify_funded", verified: true, detail: "Provider advertises a funded-job notification surface." };
  }
  const delivered = runs.some((run) => run?.agent?.identity === candidate.identity && run?.protocolJob?.funded === true);
  if (delivered) {
    return { kind: "observed_delivery", verified: true, detail: "A past funded job reached this provider, so a notification path exists." };
  }
  return { kind: "unknown", verified: false, detail: "No verified funded-job notification path was observed for this provider." };
}

/**
 * Derive public hireability from stored observations.
 *
 * Returns { status, ready, checks }. A HIREABLE verdict means Canned holds
 * everything needed to let a user attempt a real hire; the attempt itself
 * still takes and verifies a fresh quote.
 */
export function derivePublicHireability({ candidate, record = null, runs = [] } = {}) {
  const checks = [];
  const chainOk = candidate?.chainId === 97 && candidate?.network === "bsc-testnet";
  checks.push(check("chain_is_bsc_testnet", chainOk, chainOk ? "BSC testnet, chain 97." : "Hiring is restricted to BSC testnet (chain 97)."));
  const provider = candidate?.agentWallet || candidate?.ownerAddress || null;
  const providerOk = isAddress(provider);
  checks.push(check("provider_resolved", providerOk, providerOk ? `Provider ${provider}.` : "No provider wallet address is known."));
  const reachable = (record?.currentAvailability || candidate?.currentAvailability) === "reachable";
  checks.push(check("endpoint_reachable", reachable, reachable ? "Endpoint answered the last probe." : "Endpoint is not currently reachable."));
  const erc8183 = candidate?.supports?.erc8183 === true;
  checks.push(check("erc8183_supported", erc8183, erc8183 ? "ERC-8183 buyer path implemented." : "No ERC-8183 hire surface was observed."));
  const adapter = selectHiringAdapter(candidate, { chainId: 97 });
  const adapterReady = adapter.status === "ready";
  checks.push(
    check("adapter_ready", adapterReady, adapterReady ? `Fresh-quote adapter ready (${adapter.protocol}).` : adapter.reason || "No verified safe activation path."),
  );
  const token = candidate?.hiring?.currency || (candidate?.reference === true ? REFERENCE_PAYMENT_TOKEN : null);
  const tokenOk = isAddress(token);
  checks.push(check("payment_token_known", tokenOk, tokenOk ? `Settlement token ${token}.` : "Settlement token is unknown."));
  let priceOk = false;
  try {
    priceOk = /^\d+$/.test(String(candidate?.hiring?.price || "")) && BigInt(candidate.hiring.price) > 0n && BigInt(candidate.hiring.price) <= MAX_PUBLIC_PRICE_RAW;
  } catch { priceOk = false; }
  checks.push(check("price_within_policy", priceOk, priceOk ? "Advertised price parses and fits the public ceiling." : "No usable advertised price within the public ceiling."));
  const notify = notificationPathFor(candidate, runs);
  checks.push(check("provider_notification_path", notify.verified, `${notify.kind}: ${notify.detail}`));
  const negotiateUrl = negotiateUrlFor(candidate);
  checks.push(check("negotiation_route_known", negotiateUrl !== null, negotiateUrl || "No verified negotiation endpoint."));

  const ready = checks.every((item) => item.pass);
  let status = HIRE_STATUSES.VERIFIED_NOT_HIREABLE;
  if (ready) status = HIRE_STATUSES.HIREABLE;
  return { status, ready, operatorReady: adapterReady, operatorStatus: adapter.status, protocol: adapter.protocol || null, checks };
}

const NEGOTIATE_TERMS = Object.freeze({
  health_factor_monitoring: {
    deliverables: "Structured Health Factor assessment for the described position",
    quality_standards: "Authoritative protocol reads only; bounded, non-transactional recommendation",
    success_criteria: ["Deliverable submitted onchain", "No capital movement"],
  },
  rebalancing: {
    deliverables: "Range health assessment and bounded rebalancing recommendation for the described position",
    quality_standards: "Authoritative pool reads only; no transaction by the agent",
    success_criteria: ["Deliverable submitted onchain", "No capital movement"],
  },
  yield_optimisation: {
    deliverables: "Yield comparison and move-or-stay recommendation for the described asset",
    quality_standards: "Authoritative market reads only; costs priced honestly",
    success_criteria: ["Deliverable submitted onchain", "No capital movement"],
  },
  grid_trading: {
    deliverables: "Bounded grid execution outcome for the described pair and range",
    quality_standards: "Only levels inside the granted permission may execute",
    success_criteria: ["Deliverable submitted onchain", "No execution outside the permission"],
  },
});

function negotiateTerms(category, description) {
  const terms = NEGOTIATE_TERMS[category] || {
    deliverables: "Result for the described task",
    quality_standards: "Honest, evidence-bound output",
    success_criteria: ["Deliverable submitted onchain"],
  };
  return { task_description: description, terms, request_id: `public-${Date.now()}-${Math.floor(Math.random() * 1e6)}` };
}

/**
 * Take a REAL fresh provider quote and verify it end to end.
 *
 * Never trusts client-supplied price, provider, token, or expiry: every
 * binding comes from the provider-signed envelope plus live chain reads.
 */
export async function negotiatePublicQuote({ candidate, category = null, taskDescription, buyer, fetchImpl, resolver } = {}) {
  const buyerOk = isAddress(buyer);
  if (!buyerOk) return { ok: false, reason: "A valid buyer wallet address is required before a quote." };
  const task = validateTask({ description: taskDescription });
  if (!task.ok) return { ok: false, reason: task.reason };
  const negotiateUrl = negotiateUrlFor(candidate);
  if (!negotiateUrl) return { ok: false, reason: "This agent has no verified negotiation endpoint, so no fresh quote can be taken." };
  const provider = candidate?.agentWallet || candidate?.ownerAddress || null;
  if (!isAddress(provider)) return { ok: false, reason: "Provider address is unresolved; quoting is refused." };

  const request = negotiateTerms(category, task.description);
  let quoteResponse;
  try {
    quoteResponse = await safeRequestJson(negotiateUrl, {
      ...(fetchImpl ? { requestImpl: fetchImpl } : {}),
      ...(resolver ? { resolver } : {}),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: request,
      timeoutMs: 20_000,
    });
  } catch (error) {
    return { ok: false, reason: `Negotiation request failed: ${safeError(error)}` };
  }
  if (quoteResponse.blocked) return { ok: false, reason: `Negotiation endpoint refused by egress policy (${quoteResponse.error}).` };
  if (!quoteResponse.ok) return { ok: false, reason: "The provider did not answer the negotiation request." };
  const envelope = quoteResponse.body || {};
  const quoted = envelope.response || {};
  if (quoted.accepted !== true || !envelope.provider_sig || !envelope.negotiation_hash) {
    return { ok: false, reason: quoted.reason ? `Provider declined the quote: ${quoted.reason}` : "The provider did not return an accepted signed quote." };
  }
  const requestedTask = envelope?.request?.task_description;
  if (typeof requestedTask !== "string" || requestedTask !== task.description) {
    return { ok: false, reason: "The provider quote is not bound to the task you submitted." };
  }
  const terms = quoted.terms || {};
  const priceRaw = String(terms.price ?? "");
  if (!/^\d+$/.test(priceRaw)) return { ok: false, reason: "The quote did not carry a numeric price." };
  if (BigInt(priceRaw) <= 0n || BigInt(priceRaw) > MAX_PUBLIC_PRICE_RAW) {
    return { ok: false, reason: "The quoted price is outside the public ceiling; stopping for explicit review.", priceRaw };
  }

  // Signature verification against the registered provider, anchored to the
  // official Commerce contract — the same check the operator path uses.
  let signature = null;
  try {
    const addresses = await hireAddresses();
    const publicClient = (await hireReadClient()).publicClient;
    const { verifyQuoteSignature } = await import("@bnbagent/sdk/erc8183");
    signature = await verifyQuoteSignature({ envelope, provider, publicClient, expectedVerifyingContract: addresses.commerceAddress });
  } catch (error) {
    return { ok: false, reason: `Quote signature verification failed: ${safeError(error)}` };
  }
  if (signature?.valid !== true || String(signature.signer).toLowerCase() !== String(provider).toLowerCase()) {
    return { ok: false, reason: "The provider quote signature did not verify against the registered provider.", signature };
  }
  if (Number(envelope.chain_id) !== 97) return { ok: false, reason: "The signed quote is not bound to BSC testnet." };

  // Settlement token must equal the live Commerce payment token.
  let paymentToken = null;
  try {
    paymentToken = String(await (await hireReadClient()).paymentToken()).toLowerCase();
  } catch (error) {
    return { ok: false, reason: `Live payment token unreadable: ${safeError(error)}` };
  }
  if (String(terms.currency || "").toLowerCase() !== paymentToken) {
    return { ok: false, reason: "Quote currency does not match the live ERC-8183 payment token.", quotedCurrency: terms.currency, paymentToken };
  }

  const quoteExpiresAt = Number(envelope.quote_expires_at || quoted.quote_expires_at || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(quoteExpiresAt) || quoteExpiresAt - nowSeconds < 120) {
    return { ok: false, reason: "The quote expiry is missing or too short to complete a hire safely." };
  }

  // Canonical job description: the exact bytes the buyer transaction carries
  // and the provider watcher verifies. Built server-side, never client-side.
  let description = null;
  try {
    const { hireJobDescription } = await import("../protocol/hire-tx.mjs");
    description = await hireJobDescription(envelope);
  } catch (error) {
    return { ok: false, reason: `Quoted terms could not be bound to a job description: ${safeError(error)}` };
  }

  const expiresAt = Math.min(quoteExpiresAt, nowSeconds + QUOTE_TTL_SECONDS);
  return {
    ok: true,
    buyer: buyer.toLowerCase(),
    provider: provider.toLowerCase(),
    token: paymentToken,
    amountRaw: priceRaw,
    quoteExpiresAt,
    expiresAt,
    estimatedCompletionSeconds: quoted.estimated_completion_seconds ?? terms.estimatedCompletionSeconds ?? null,
    negotiationHash: envelope.negotiation_hash,
    providerSignature: envelope.provider_sig,
    description: description.description,
    descriptionHash: description.descriptionHash,
    taskDescription: task.description,
    quotedAt: nowIso(),
  };
}

export function publicQuoteView(record) {
  return {
    quoteId: record.quoteId,
    agent: { identity: record.agentIdentity, name: record.agentName },
    buyer: record.buyer,
    provider: record.provider,
    network: "bsc-testnet",
    chainId: 97,
    token: record.token,
    tokenSymbol: record.tokenSymbol,
    amount: record.amountRaw,
    amountHuman: record.amountHuman,
    maximumSpend: record.amountRaw,
    expiresAt: record.expiresAt,
    estimatedCompletionSeconds: record.estimatedCompletionSeconds,
    permissions: record.permissions,
    executionModel: record.executionModel || null,
    task: { description: record.taskDescription },
    status: record.status,
  };
}

export { contentHashes, formatUnits };
