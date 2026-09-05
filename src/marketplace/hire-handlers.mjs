import { contentHashes, nowIso, safeError } from "../core.mjs";
import { safeRequestJson } from "../net/egress-guard.mjs";
import { fetchDeliverable } from "../protocol/erc8183-buyer.mjs";
import { validateSubmittedDeliverable } from "../benchmark/validation.mjs";
import { buildPublicAgent, publicRunsOnly } from "./public-api.mjs";
import { applyListing } from "./listings.mjs";
import { deriveAgentRecord } from "./model.mjs";
import {
  HIRE_STATUSES,
  MAX_PUBLIC_PRICE_RAW,
  derivePublicHireability,
  negotiatePublicQuote,
  publicQuoteView,
} from "./public-hire.mjs";
import {
  findHireByIdempotency,
  findHireByQuote,
  findHireByTx,
  getHire,
  getQuote,
  hiresForBuyer,
  newHireId,
  newQuoteId,
  putHire,
  putQuote,
  quoteExpired,
  transitionQuote,
  validateTask,
  withHireLock,
} from "./hire-store.mjs";
import {
  HIRE_CHAIN_ID,
  availableHireActions,
  buildHireTxPlan,
  decodeApproval,
  decodeHireCall,
  decodeJobCreated,
  disputeWindowSeconds,
  formatUnits,
  hireAddresses,
  hireLifecycleFrom,
  hirePublicClient,
  hireReadClient,
  isAddress,
  isIdempotencyKey,
  isTxHash,
  readHireJob,
  verifiedReceipt,
} from "../protocol/hire-tx.mjs";

/**
 * Public-hire request handlers.
 *
 * Every handler derives expectations from server-owned state (the verified
 * quote, the hire record, live chain reads) and never from client claims
 * about price, provider, token, amount, or chain.
 */

const STEP_ORDER = ["approve", "create", "register", "budget", "fund"];

function fail(status, error, extra = {}) {
  return { http: status, body: { error, ...extra } };
}

function ok(body) {
  return { http: 200, body };
}

export function resolveCandidate(candidates, identity) {
  return (candidates || []).find((item) => item.identity === identity) || null;
}

function candidateContext({ candidates, runs, listings, identity }) {
  const candidate = resolveCandidate(candidates, identity);
  if (!candidate) return { error: fail(404, "unknown_identity", { reason: "Canned has no record of this agent." }) };
  const listing = (listings || {})[identity] || null;
  const withListing = applyListing(candidate, listing);
  const record = deriveAgentRecord(withListing, runs);
  const agent = buildPublicAgent({ candidate, runs, listing });
  return { candidate, withListing, record, agent, listing };
}

function taskHashOf(description) {
  return contentHashes({ description }).keccak256;
}

/** POST /api/hire/quote — take a real fresh provider quote. */
export async function handleHireQuote({ store, candidates, runs, listings, body }) {
  const identity = String(body?.identity || "").trim();
  const buyer = String(body?.buyer || "").trim();
  if (!identity) return fail(400, "identity_required", { reason: "Choose the agent you want to hire." });
  if (!isAddress(buyer)) return fail(400, "buyer_required", { reason: "Connect a wallet so the quote binds to your address." });
  const task = validateTask(body?.task);
  if (!task.ok) return fail(400, "task_invalid", { reason: task.reason });

  const ctx = candidateContext({ candidates, runs, listings, identity });
  if (ctx.error) return ctx.error;
  const hireability = derivePublicHireability({ candidate: ctx.withListing, record: ctx.record, runs });
  if (!hireability.ready) {
    return fail(409, "not_hireable", {
      reason: "This agent cannot currently be hired through Canned.",
      statusLabel: hireability.status,
      checks: hireability.checks,
    });
  }

  const negotiated = await negotiatePublicQuote({
    candidate: ctx.withListing,
    category: ctx.agent.category?.claimedCategory || null,
    taskDescription: task.description,
    buyer,
  });
  if (!negotiated.ok) {
    return fail(422, "quote_failed", { reason: negotiated.reason, priceRaw: negotiated.priceRaw || null });
  }

  let symbol = "U";
  let decimals = 18;
  try {
    const readClient = await hireReadClient();
    symbol = await readClient.tokenSymbol().catch(() => "U");
    decimals = await readClient.tokenDecimals().catch(() => 18);
  } catch { /* read-only metadata is best-effort; raw amount governs */ }

  const record = {
    quoteId: newQuoteId(),
    status: "ISSUED",
    agentIdentity: ctx.candidate.identity,
    agentName: ctx.candidate.name,
    buyer: buyer.toLowerCase(),
    provider: negotiated.provider,
    token: negotiated.token,
    tokenSymbol: symbol,
    tokenDecimals: Number(decimals),
    amountRaw: negotiated.amountRaw,
    amountHuman: formatUnits(negotiated.amountRaw, Number(decimals)),
    quoteExpiresAt: negotiated.quoteExpiresAt,
    expiresAt: negotiated.expiresAt,
    estimatedCompletionSeconds: negotiated.estimatedCompletionSeconds,
    negotiationHash: negotiated.negotiationHash,
    providerSignature: negotiated.providerSignature,
    description: negotiated.description,
    descriptionHash: negotiated.descriptionHash,
    taskDescription: negotiated.taskDescription,
    taskHash: taskHashOf(negotiated.taskDescription),
    permissions: ctx.agent.permissions,
    executionModel: ctx.agent.executionModel,
    jobExpiredAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await putQuote(store, record);
  return ok({ ...publicQuoteView(record), checks: hireability.checks });
}

/** Serialize prepare retries so one quote cannot produce two hire records. */
export async function handleHirePrepare(args) {
  return withHireLock(`prepare:${String(args?.body?.quoteId || "")}`, () => handleHirePrepareUnlocked(args));
}

/** POST /api/hire/prepare — bind a quote to a buyer attempt + exact tx plan. */
async function handleHirePrepareUnlocked({ store, candidates, runs, listings, body }) {
  const quoteId = String(body?.quoteId || "").trim();
  const buyer = String(body?.buyer || "").trim();
  const idempotencyKey = String(body?.idempotencyKey || "").trim();
  if (!quoteId) return fail(400, "quote_required", { reason: "A quote is required before preparation." });
  if (!isAddress(buyer)) return fail(400, "buyer_required", { reason: "Connect the wallet the quote was issued for." });
  if (!isIdempotencyKey(idempotencyKey)) {
    return fail(400, "idempotency_required", { reason: "Supply an idempotency key (8-64 letters, digits, dash, underscore) so a retry never creates a second hire." });
  }

  const quote = await getQuote(store, quoteId);
  if (!quote) return fail(404, "unknown_quote", { reason: "This quote does not exist. Take a fresh one." });
  if (quote.status === "CONSUMED") {
    const existing = await findHireByQuote(store, quoteId);
    return fail(409, "quote_consumed", { reason: "This quote already funded a job.", hireId: existing?.hireId || null });
  }
  if (quoteExpired(quote)) {
    await transitionQuote(store, quoteId, ["ISSUED", "PREPARED"], "EXPIRED");
    return fail(410, "quote_expired", { reason: "The quote expired before confirmation. Take a fresh one; nothing was spent." });
  }
  if (quote.buyer !== buyer.toLowerCase()) return fail(403, "buyer_mismatch", { reason: "This quote was issued to a different wallet." });

  // One logical hire per quote: resume it, never duplicate it.
  const byKey = await findHireByIdempotency(store, idempotencyKey);
  if (byKey && byKey.quoteId !== quoteId) {
    return fail(409, "idempotency_reuse", { reason: "This idempotency key already belongs to another hire.", hireId: byKey.hireId });
  }
  const resumed = byKey || (await findHireByQuote(store, quoteId));
  if (resumed) return ok(await hireView({ store, hire: resumed, includePlan: true }));

  const ctx = candidateContext({ candidates, runs, listings, identity: quote.agentIdentity });
  if (ctx.error) return ctx.error;
  const hireability = derivePublicHireability({ candidate: ctx.withListing, record: ctx.record, runs });
  if (!hireability.ready) {
    return fail(409, "not_hireable", { reason: "The agent stopped being hireable after the quote was issued.", checks: hireability.checks });
  }
  if ((ctx.withListing.agentWallet || ctx.withListing.ownerAddress || "").toLowerCase() !== quote.provider) {
    return fail(409, "provider_changed", { reason: "The registered provider changed after the quote. Take a fresh quote." });
  }

  // Live chain reads: allowance (approve only when needed) and balances.
  // Nothing is spent here; these are reads.
  let allowanceSufficient = false;
  try {
    const addresses = await hireAddresses();
    const publicClient = await hirePublicClient();
    const { ERC20_ABI } = await import("../protocol/hire-tx.mjs").then((m) => m.HIRE_ABIS);
    const [allowance, balance, native] = await Promise.all([
      publicClient.readContract({ address: quote.token, abi: ERC20_ABI, functionName: "allowance", args: [quote.buyer, addresses.commerceAddress] }),
      publicClient.readContract({ address: quote.token, abi: ERC20_ABI, functionName: "balanceOf", args: [quote.buyer] }),
      publicClient.getBalance({ address: quote.buyer }),
    ]);
    allowanceSufficient = BigInt(allowance) >= BigInt(quote.amountRaw);
    if (BigInt(balance) < BigInt(quote.amountRaw)) {
      return fail(409, "insufficient_token", { reason: `The buyer wallet holds less than the quoted ${quote.amountHuman} ${quote.tokenSymbol}. No transaction was requested.` });
    }
    if (native === 0n) {
      return fail(409, "insufficient_gas", { reason: "The buyer wallet has no native balance for transaction fees. No transaction was requested." });
    }
  } catch (error) {
    return fail(502, "chain_read_failed", { reason: `Live balance checks failed: ${error.message}. No transaction was requested.` });
  }

  // Job expiry: provider window + live dispute window + safety buffer.
  let disputeWindow = 0;
  try {
    disputeWindow = await disputeWindowSeconds();
  } catch (error) {
    return fail(502, "chain_read_failed", { reason: `Live dispute window unreadable: ${error.message}. Refusing to bind an expiry blindly.` });
  }
  const estimated = Number(quote.estimatedCompletionSeconds) > 0 ? Number(quote.estimatedCompletionSeconds) : 300;
  const deliveryWindow = Math.max(600, estimated * 5);
  const jobExpiredAt = Math.floor(Date.now() / 1000) + deliveryWindow + Number(disputeWindow) + 300;

  const prepared = await transitionQuote(store, quoteId, "ISSUED", "PREPARED", { jobExpiredAt });
  if (!prepared) return fail(409, "quote_state_changed", { reason: "The quote changed state while preparing. Take a fresh one." });

  const hire = {
    hireId: newHireId(),
    quoteId,
    idempotencyKey,
    buyer: quote.buyer,
    agentIdentity: quote.agentIdentity,
    agentName: quote.agentName,
    provider: quote.provider,
    token: quote.token,
    tokenSymbol: quote.tokenSymbol,
    amountRaw: quote.amountRaw,
    amountHuman: quote.amountHuman,
    taskHash: quote.taskHash,
    jobId: null,
    jobExpiredAt,
    state: "PREPARED",
    chainStatus: null,
    transactions: {},
    notifyState: "pending",
    notifyDetail: null,
    deliverableUrl: null,
    result: null,
    failure: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await putHire(store, hire);
  return ok(await hireView({ store, hire, includePlan: true, allowanceSufficient }));
}

/** Full hire view: review facts, exact plan, remaining steps, lifecycle. */
export async function hireView({ store, hire, includePlan = false, allowanceSufficient = null }) {
  const quote = await getQuote(store, hire.quoteId);
  const addresses = await hireAddresses();
  let plan = null;
  if (includePlan && quote && hire.state !== "FUNDED" && hire.state !== "COMPLETED") {
    const done = new Set(Object.keys(hire.transactions || {}));
    if (allowanceSufficient === null && hire.jobId !== null) allowanceSufficient = true;
    if (allowanceSufficient === null) {
      try {
        const publicClient = await hirePublicClient();
        const { ERC20_ABI } = await import("../protocol/hire-tx.mjs").then((m) => m.HIRE_ABIS);
        const allowance = await publicClient.readContract({ address: quote.token, abi: ERC20_ABI, functionName: "allowance", args: [hire.buyer, addresses.commerceAddress] });
        allowanceSufficient = BigInt(allowance) >= BigInt(quote.amountRaw);
      } catch { allowanceSufficient = false; }
    }
    const full = await buildHireTxPlan({ quote: { ...quote, jobExpiredAt: hire.jobExpiredAt || quote.jobExpiredAt }, buyer: hire.buyer, allowanceSufficient, jobId: hire.jobId });
    plan = { ...full, steps: full.steps.filter((step) => !done.has(step.kind)) };
  }
  return {
    hireId: hire.hireId,
    quoteId: hire.quoteId,
    state: hireLifecyclePublic(hire),
    agent: { identity: hire.agentIdentity, name: hire.agentName },
    buyer: hire.buyer,
    provider: hire.provider,
    network: "bsc-testnet",
    chainId: HIRE_CHAIN_ID,
    token: hire.token,
    tokenSymbol: hire.tokenSymbol,
    amount: hire.amountRaw,
    amountHuman: hire.amountHuman,
    maximumSpend: hire.amountRaw,
    jobId: hire.jobId,
    chainStatus: hire.chainStatus,
    jobExpiredAt: hire.jobExpiredAt || null,
    transactions: hire.transactions || {},
    notifyState: hire.notifyState,
    notifyDetail: hire.notifyDetail,
    deliverableAvailable: Boolean(hire.deliverableUrl),
    failure: hire.failure,
    availableActions: hire.jobId && hire.chainStatus ? await availableHireActions({ job: { id: hire.jobId, status: hire.chainStatus }, quote }).catch(() => []) : [],
    review: quote
      ? {
          task: { description: quote.taskDescription },
          permissions: quote.permissions,
          executionModel: quote.executionModel || null,
          estimatedCompletionSeconds: quote.estimatedCompletionSeconds,
          quoteExpiresAt: quote.expiresAt,
        }
      : null,
    ...(plan ? { status: "READY_TO_CONFIRM", plan, idempotencyKey: hire.idempotencyKey } : {}),
    createdAt: hire.createdAt,
    updatedAt: hire.updatedAt,
  };
}

function hireLifecyclePublic(hire) {
  if (hire.failure?.step === "result" && !hire.result) return "DELIVERY_INVALID";
  if (hire.state === "FUNDED" || hire.jobId) {
    try {
      return hireLifecycleFrom({ chainStatus: hire.chainStatus || "FUNDED", notifyState: hire.notifyState, deliverableValid: Boolean(hire.deliverableUrl), refundable: true });
    } catch { return hire.state; }
  }
  return hire.state;
}

/**
 * POST /api/hire/submit — verify wallet transactions step by step.
 *
 * Accepts any subset of steps in canonical order; each accepted tx hash is
 * reconciled against server-owned quote state and live chain reads. Replays
 * (same hash, same key) return the existing hire instead of duplicating it.
 */
/** Serialize reconciliation retries so duplicate requests cannot race a step. */
export async function handleHireSubmit(args) {
  return withHireLock(`submit:${String(args?.body?.quoteId || "")}`, () => handleHireSubmitUnlocked(args));
}

async function handleHireSubmitUnlocked({ store, candidates = [], runs = [], body }) {
  const quoteId = String(body?.quoteId || "").trim();
  const idempotencyKey = String(body?.idempotencyKey || "").trim();
  const steps = Array.isArray(body?.steps) ? body.steps : [];
  if (!quoteId || !isIdempotencyKey(idempotencyKey)) return fail(400, "quote_and_key_required", { reason: "Quote id and idempotency key are required." });
  if (!steps.length || steps.length > STEP_ORDER.length) return fail(400, "steps_required", { reason: "Provide the wallet transaction hashes to reconcile." });
  for (const step of steps) {
    if (!STEP_ORDER.includes(step?.kind) || !isTxHash(step?.txHash)) {
      return fail(400, "steps_invalid", { reason: "Each step needs a known kind and a 0x transaction hash." });
    }
  }

  const quote = await getQuote(store, quoteId);
  if (!quote) return fail(404, "unknown_quote", { reason: "This quote does not exist." });
  let hire = (await findHireByIdempotency(store, idempotencyKey)) || (await findHireByQuote(store, quoteId));
  if (!hire) return fail(404, "unknown_hire", { reason: "Prepare this hire before submitting transactions." });
  if (hire.idempotencyKey !== idempotencyKey || hire.quoteId !== quoteId) {
    return fail(409, "hire_mismatch", { reason: "Quote, hire, and idempotency key do not belong together." });
  }
  if (hire.state === "FUNDED" || hire.state === "COMPLETED") return ok(await hireView({ store, hire }));

  // A hash Canned already accepted belongs to exactly one hire.
  for (const step of steps) {
    const other = await findHireByTx(store, step.txHash);
    if (other && other.hireId !== hire.hireId) {
      return fail(409, "transaction_reused", { reason: "This transaction was already accepted for another hire.", hireId: other.hireId });
    }
  }

  const addresses = await hireAddresses();
  const buyer = hire.buyer;
  const ordered = [...steps].sort((a, b) => STEP_ORDER.indexOf(a.kind) - STEP_ORDER.indexOf(b.kind));
  for (const { kind, txHash } of ordered) {
    if (hire.transactions?.[kind]?.txHash?.toLowerCase() === String(txHash).toLowerCase()) continue; // replay: skip, stay idempotent
    if (hire.transactions?.[kind]) {
      return fail(409, "step_conflict", { reason: `Step ${kind} already reconciled a different transaction.`, hireId: hire.hireId });
    }
    try {
      await reconcileStep({ store, quote, hire, kind, txHash, addresses, buyer, candidates, runs });
    } catch (error) {
      hire.failure = { step: kind, reason: error.message, at: nowIso() };
      hire.updatedAt = nowIso();
      await putHire(store, hire);
      return fail(422, "transaction_rejected", { reason: error.message, step: kind, hireId: hire.hireId });
    }
  }

  hire = (await getHire(store, hire.hireId)) || hire;
  return ok(await hireView({ store, hire, includePlan: hire.state !== "FUNDED" }));
}

async function reconcileStep({ store, quote, hire, kind, txHash, addresses, buyer, candidates = [], runs = [] }) {
  const { receipt, tx } = await verifiedReceipt(txHash);
  if (String(tx.from).toLowerCase() !== buyer) throw new Error("Transaction sender is not the quoted buyer.");
  const amount = BigInt(quote.amountRaw);

  if (kind === "approve") {
    if (String(tx.to).toLowerCase() !== quote.token.toLowerCase()) throw new Error("Approval targets the wrong contract.");
    const call = decodeHireCall(tx.input);
    if (call.functionName !== "approve" || String(call.args[0]).toLowerCase() !== addresses.commerceAddress.toLowerCase() || BigInt(call.args[1]) < amount) {
      throw new Error("Approval does not cover the exact quoted amount for the Commerce spender.");
    }
    decodeApproval(receipt, { token: quote.token, buyer, spender: addresses.commerceAddress, required: amount });
    hire.transactions.approve = { txHash, at: nowIso() };
  } else if (kind === "create") {
    if (String(tx.to).toLowerCase() !== addresses.commerceAddress.toLowerCase()) throw new Error("Create targets the wrong contract.");
    const call = decodeHireCall(tx.input);
    if (call.functionName !== "createJob") throw new Error("Transaction is not a job creation.");
    const [callProvider, callEvaluator, callExpiry, callDescription, callHook] = call.args;
    if (String(callProvider).toLowerCase() !== quote.provider) throw new Error("Created job names the wrong provider.");
    if (String(callEvaluator).toLowerCase() !== addresses.routerAddress.toLowerCase()) throw new Error("Created job names the wrong evaluator.");
    if (String(callHook).toLowerCase() !== addresses.routerAddress.toLowerCase()) throw new Error("Created job names the wrong hook.");
    if (BigInt(callExpiry) !== BigInt(hire.jobExpiredAt)) throw new Error("Created job carries the wrong expiry.");
    if (contentHashes(callDescription).keccak256 !== quote.descriptionHash) throw new Error("Created job description does not match the verified quote.");
    const created = decodeJobCreated(receipt, { commerce: addresses.commerceAddress, buyer, provider: quote.provider });
    const onchain = await readHireJob(created.jobId);
    if (onchain.client !== buyer) throw new Error("On-chain job client is not the buyer.");
    if (onchain.descriptionHash !== quote.descriptionHash) throw new Error("On-chain job description drifted from the quote.");
    hire.jobId = created.jobId;
    hire.chainStatus = onchain.status;
    hire.state = "CREATED";
    hire.transactions.create = { txHash, jobId: created.jobId, at: nowIso() };
  } else if (kind === "register") {
    if (!hire.jobId) throw new Error("Create must reconcile before registering.");
    if (String(tx.to).toLowerCase() !== addresses.routerAddress.toLowerCase()) throw new Error("Register targets the wrong contract.");
    const call = decodeHireCall(tx.input);
    if (call.functionName !== "registerJob" || String(call.args[0]) !== String(hire.jobId) || String(call.args[1]).toLowerCase() !== addresses.policyAddress.toLowerCase()) {
      throw new Error("Register call does not bind this job to the official policy.");
    }
    const publicClient = await hirePublicClient();
    const { HIRE_ABIS } = await import("../protocol/hire-tx.mjs");
    const bound = String(await publicClient.readContract({ address: addresses.routerAddress, abi: HIRE_ABIS.ROUTER_ABI, functionName: "jobPolicy", args: [BigInt(hire.jobId)] })).toLowerCase();
    if (bound !== addresses.policyAddress.toLowerCase()) throw new Error("Policy binding not visible on chain.");
    hire.transactions.register = { txHash, at: nowIso() };
    hire.state = "REGISTERED";
  } else if (kind === "budget") {
    if (!hire.jobId) throw new Error("Create must reconcile before setting the budget.");
    if (String(tx.to).toLowerCase() !== addresses.commerceAddress.toLowerCase()) throw new Error("Budget targets the wrong contract.");
    const call = decodeHireCall(tx.input);
    if (call.functionName !== "setBudget" || String(call.args[0]) !== String(hire.jobId) || BigInt(call.args[1]) !== amount) {
      throw new Error("Budget call does not set the exact quoted amount on this job.");
    }
    hire.transactions.budget = { txHash, at: nowIso() };
    hire.state = "BUDGETED";
  } else if (kind === "fund") {
    if (!hire.jobId) throw new Error("Create must reconcile before funding.");
    if (String(tx.to).toLowerCase() !== addresses.commerceAddress.toLowerCase()) throw new Error("Fund targets the wrong contract.");
    const call = decodeHireCall(tx.input);
    if (call.functionName !== "fund" || String(call.args[0]) !== String(hire.jobId) || BigInt(call.args[1]) !== amount) {
      throw new Error("Fund call does not fund the exact quoted amount on this job.");
    }
    const onchain = await readHireJob(hire.jobId);
    if (onchain.status !== "FUNDED") throw new Error(`Job is ${onchain.status} on chain, not FUNDED.`);
    if (onchain.client !== buyer) throw new Error("Funded job client is not the buyer.");
    if (onchain.provider !== quote.provider) throw new Error("Funded job provider is not the quoted provider.");
    if (BigInt(onchain.budget) !== amount) throw new Error("Funded budget differs from the quote.");
    if (onchain.descriptionHash !== quote.descriptionHash) throw new Error("Funded job description drifted from the quote.");
    hire.chainStatus = onchain.status;
    hire.state = "FUNDED";
    hire.transactions.fund = { txHash, at: nowIso() };
    await transitionQuote(store, quote.quoteId, ["PREPARED", "ISSUED"], "CONSUMED");
    await notifyProvider({ store, hire, quote, candidates, runs });
  }
  hire.updatedAt = nowIso();
  await putHire(store, hire);
}

/** Provider notification: the chain is the message for watcher providers. */
async function notifyProvider({ store, hire, quote, candidates = [], runs = [] }) {
  const candidate = candidates.find((item) => item.identity === hire.agentIdentity) || null;
  if (candidate?.reference === true) {
    hire.notifyState = "notified";
    hire.notifyDetail = "Reference provider watcher detects funded jobs on chain; no off-chain message is required (proven by historical funded jobs).";
    await putHire(store, hire);
    return;
  }
  const notifyUrl = notifyUrlFor(candidate);
  if (!notifyUrl) {
    hire.notifyState = "pending";
    hire.notifyDetail = "No verified provider notification route; the funded job is visible on chain.";
    await putHire(store, hire);
    return;
  }
  try {
    const response = await safeRequestJson(notifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { job_id: hire.jobId, buyer: hire.buyer, provider: hire.provider, taskHash: hire.taskHash, descriptionHash: quote.descriptionHash },
      timeoutMs: 15_000,
    });
    hire.notifyState = response.ok ? "notified" : "failed";
    hire.notifyDetail = response.ok ? `Provider acknowledged job ${hire.jobId}.` : `Notification failed (${response.error || response.status}); safe to retry, never re-funds.`;
  } catch (error) {
    hire.notifyState = "failed";
    hire.notifyDetail = `Notification error (${safeError(error)}); safe to retry, never re-funds.`;
  }
  await putHire(store, hire);
}

function notifyUrlFor(candidate) {
  if (!candidate) return null;
  const endpoint = candidate?.services?.[0]?.endpoint || null;
  if (typeof endpoint === "string" && /^https:\/\//.test(endpoint) && !/localhost|127\.0\.0\.1/.test(endpoint)) {
    const text = JSON.stringify(candidate?.probes || []).toLowerCase();
    if (/notify_funded/.test(text)) return `${endpoint.replace(/\/+$/, "")}/notify_funded`;
  }
  return null;
}

/** GET /api/hire/job/:hireId — lifecycle. Private fields need the buyer. */
export async function handleHireJob({ store, hireId, buyer = null }) {
  const hire = await getHire(store, hireId);
  if (!hire) return fail(404, "unknown_hire", { reason: "No hire with this id." });
  const authorized = buyer && String(buyer).toLowerCase() === hire.buyer;

  // Refresh authoritative state; fail soft (report stored state as stale).
  let stale = false;
  if (hire.jobId) {
    try {
      const onchain = await readHireJob(hire.jobId);
      hire.chainStatus = onchain.status;
      hire.updatedAt = nowIso();
      if (onchain.deliverable && !/^0x0+$/.test(onchain.deliverable) && !hire.deliverableUrl) {
        try {
          const readClient = await hireReadClient();
          hire.deliverableUrl = await readClient.getDeliverableUrl(BigInt(hire.jobId));
        } catch { /* deliverable URL resolves when the provider store answers */ }
      }
      await putHire(store, hire);
    } catch { stale = true; }
  }
  const view = await hireView({ store, hire, includePlan: authorized && hire.state !== "FUNDED" && hire.state !== "COMPLETED" });
  if (!authorized) {
    delete view.review;
    delete view.plan;
    delete view.transactions;
  }
  return ok({ ...view, stale });
}

/** GET /api/hire/job/:hireId/result — validated delivery only, buyer-gated. */
export async function handleHireResult({ store, hireId, buyer = null }) {
  const hire = await getHire(store, hireId);
  if (!hire) return fail(404, "unknown_hire", { reason: "No hire with this id." });
  if (!buyer || String(buyer).toLowerCase() !== hire.buyer) {
    return fail(403, "buyer_required", { reason: "Connect the buyer wallet to read this result." });
  }
  if (!hire.jobId) return fail(409, "not_funded", { reason: "No on-chain job exists for this hire yet." });
  let onchain = null;
  try {
    onchain = await readHireJob(hire.jobId);
    hire.chainStatus = onchain.status;
  } catch (error) {
    return fail(502, "chain_read_failed", { reason: `Authoritative job state unreadable: ${error.message}` });
  }
  if (!["SUBMITTED", "COMPLETED"].includes(onchain.status)) {
    return fail(409, "no_delivery", { reason: `Job is ${onchain.status}; no provider delivery exists yet.` });
  }
  let deliverableUrl = hire.deliverableUrl;
  if (!deliverableUrl) {
    try {
      const readClient = await hireReadClient();
      deliverableUrl = await readClient.getDeliverableUrl(BigInt(hire.jobId));
      hire.deliverableUrl = deliverableUrl;
    } catch (error) {
      return fail(502, "deliverable_unresolved", { reason: `Delivery reference unresolvable: ${safeError(error)}` });
    }
  }
  const fetched = await fetchDeliverable(deliverableUrl, { timeoutMs: 20_000 });
  const fetchedBody = fetched.response?.body;
  if (!fetched.ok || fetchedBody === null || fetchedBody === undefined) {
    const detail = fetched.scheme === "unsupported" ? "unsupported deliverable scheme" : "no delivery gateway returned usable JSON";
    await putHire(store, hire);
    return fail(502, "deliverable_fetch_failed", { reason: "The provider delivery could not be retrieved. The failure is preserved; the job state is unchanged." });
  }
  const validation = validateSubmittedDeliverable({ body: fetchedBody, jobId: hire.jobId, onchainDeliverable: onchain.deliverable });
  if (!validation.valid) {
    hire.failure = { step: "result", reason: `Malformed delivery preserved: ${validation.errors.join(", ")}.`, at: nowIso() };
    await putHire(store, hire);
    return fail(502, "deliverable_invalid", { reason: "The provider submission failed validation and is preserved as a failure, not a result.", errors: validation.errors });
  }
  const quote = await getQuote(store, hire.quoteId);
  const parsedDecimals = quote?.tokenDecimals === null || quote?.tokenDecimals === undefined || quote?.tokenDecimals === "" ? null : Number(quote.tokenDecimals);
  const tokenDecimals = Number.isInteger(parsedDecimals) && parsedDecimals >= 0 && parsedDecimals <= 255 ? parsedDecimals : null;
  const amountHuman = tokenDecimals === null ? (hire.amountHuman || null) : formatUnits(hire.amountRaw, tokenDecimals);
  hire.result = {
    output: validation.output,
    manifestHash: validation.manifestHash,
    deliverableUrl,
    jobId: hire.jobId,
    retrievedAt: nowIso(),
    cost: { amountRaw: hire.amountRaw, amountHuman, tokenDecimals, tokenSymbol: hire.tokenSymbol, token: hire.token },
  };
  hire.failure = null;
  hire.updatedAt = nowIso();
  await putHire(store, hire);
  return ok({
    hireId: hire.hireId,
    jobId: hire.jobId,
    chainStatus: onchain.status,
    result: hire.result.output,
    metadata: {
      manifestHash: hire.result.manifestHash,
      deliverableUrl,
      retrievedAt: hire.result.retrievedAt,
      cost: hire.result.cost,
    },
  });
}

/** GET /api/hire/job/:hireId/evidence — durable evidence binding, buyer-gated. */
export async function handleHireEvidence({ store, candidates, hireId, buyer = null }) {
  const hire = await getHire(store, hireId);
  if (!hire) return fail(404, "unknown_hire", { reason: "No hire with this id." });
  if (!buyer || String(buyer).toLowerCase() !== hire.buyer) {
    return fail(403, "buyer_required", { reason: "Connect the buyer wallet to read this evidence." });
  }
  const quote = await getQuote(store, hire.quoteId);
  const candidate = (candidates || []).find((item) => item.identity === hire.agentIdentity) || null;
  return ok({
    hireId: hire.hireId,
    agent: { identity: hire.agentIdentity, name: hire.agentName, erc8004: candidate ? { owner: candidate.ownerAddress, wallet: candidate.agentWallet } : null },
    buyer: hire.buyer,
    provider: hire.provider,
    network: "bsc-testnet",
    chainId: HIRE_CHAIN_ID,
    task: quote ? { description: quote.taskDescription, taskHash: hire.taskHash } : null,
    quote: quote
      ? { quoteId: quote.quoteId, amountRaw: quote.amountRaw, token: quote.token, negotiationHash: quote.negotiationHash, providerSignature: quote.providerSignature, descriptionHash: quote.descriptionHash, quotedAt: quote.quotedAt }
      : null,
    payment: { transactions: hire.transactions, amountRaw: hire.amountRaw, token: hire.token },
    job: { jobId: hire.jobId, chainStatus: hire.chainStatus, jobExpiredAt: hire.jobExpiredAt },
    delivery: hire.deliverableUrl ? { deliverableUrl: hire.deliverableUrl, result: hire.result } : null,
    notification: { state: hire.notifyState, detail: hire.notifyDetail },
    lifecycle: hireLifecyclePublic(hire),
    failure: hire.failure,
    createdAt: hire.createdAt,
    updatedAt: hire.updatedAt,
    note: "Read the tape: every binding above is server-verified against chain state, not client-asserted.",
  });
}

/** GET /api/hire/mine?buyer= — resume list (metadata only, no task text). */
export async function handleHireMine({ store, buyer }) {
  if (!isAddress(buyer)) return fail(400, "buyer_required", { reason: "Supply the buyer wallet address." });
  const hires = await hiresForBuyer(store, buyer);
  return ok({
    buyer: String(buyer).toLowerCase(),
    count: hires.length,
    hires: hires.map((hire) => ({
      hireId: hire.hireId,
      state: hireLifecyclePublic(hire),
      agent: { identity: hire.agentIdentity, name: hire.agentName },
      jobId: hire.jobId,
      chainStatus: hire.chainStatus,
      amountRaw: hire.amountRaw,
      tokenSymbol: hire.tokenSymbol,
      deliverableAvailable: Boolean(hire.deliverableUrl),
      createdAt: hire.createdAt,
      updatedAt: hire.updatedAt,
    })),
  });
}

export { HIRE_STATUSES, MAX_PUBLIC_PRICE_RAW };
