import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import os from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, toHex } from "viem";
import { fetchDeliverable } from "../src/protocol/erc8183-buyer.mjs";
import { FileStore } from "../src/persistence/file-store.mjs";
import { validateSubmittedDeliverable } from "../src/benchmark/validation.mjs";
import { contentHashes } from "../src/core.mjs";
import {
  findHireByIdempotency,
  findHireByQuote,
  findHireByTx,
  getQuote,
  hiresForBuyer,
  newHireId,
  newQuoteId,
  putHire,
  putQuote,
  quoteExpired,
  transitionQuote,
  validateTask,
} from "../src/marketplace/hire-store.mjs";
import {
  HIRE_STATUSES,
  MAX_PUBLIC_PRICE_RAW,
  derivePublicHireability,
  negotiatePublicQuote,
  negotiateUrlFor,
  notificationPathFor,
} from "../src/marketplace/public-hire.mjs";
import { HIRE_ABIS, decodeHireCall, decodeJobCreated } from "../src/protocol/hire-tx.mjs";
import {
  handleHireMine,
  handleHirePrepare,
  handleHireQuote,
  handleHireSubmit,
} from "../src/marketplace/hire-handlers.mjs";

const BUYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const PROVIDER = "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7";
const TOKEN = "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565";
const HIRE_PAGE = readFileSync(new URL("../web/hire.html", import.meta.url), "utf8");
const HIRE_SCRIPT_START = HIRE_PAGE.indexOf("<script>");
const HIRE_SCRIPT = HIRE_PAGE.slice(HIRE_SCRIPT_START + "<script>".length, HIRE_PAGE.indexOf("</script>", HIRE_SCRIPT_START));

function pagePathHireId(pathname) {
  const match = HIRE_PAGE.match(/    function pathHireId\(\) \{[\s\S]*?\n    \}/);
  assert.ok(match, "Hire page must define its path parser");
  return runInNewContext("(() => { const location = { pathname: " + JSON.stringify(pathname) + " }; " + match[0] + "; return pathHireId(); })()");
}

const qualified = {
  identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2001",
  chainId: 97,
  network: "bsc-testnet",
  name: "Qualified Agent",
  description: "A bounded agent.",
  categoryHypotheses: [{ category: "health_factor_monitoring", label: "Health", confidence: "high", signals: [] }],
  agentWallet: PROVIDER,
  ownerAddress: PROVIDER,
  reference: true,
  services: [{ type: "HTTP task API", endpoint: "https://example.test/erc8183" }],
  probes: [{ type: "HTTP task API", endpoint: "https://example.test/erc8183", reachable: true, callable: true }],
  supports: { erc8183: true },
  selectionGate: { readiness: { ready: true, quoteVerified: true, protocolCompatibility: true } },
  hiring: { price: "1000000000000000", currency: TOKEN },
};

const deliveredRun = {
  runId: "run-1",
  runType: "BENCHMARK",
  createdAt: "2026-08-27T00:00:00Z",
  agent: { identity: qualified.identity },
  protocolJob: { funded: true, jobId: 701 },
  terminalState: "completed",
};

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "canned-hire-"));
  const store = await new FileStore(dir).init();
  return { dir, store };
}

function stubNegotiate(outcome) {
  return async () => ({
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(outcome),
  });
}

// Documentation-range address: public per the egress guard, unreachable.
function stubResolver() {
  return async () => [{ address: "203.0.113.10", family: 4 }];
}

function negotiateArgs(extra) {
  return { candidate: qualified, taskDescription: "Assess my position.", buyer: BUYER, fetchImpl: stubNegotiate(extra), resolver: stubResolver() };
}

// ---- hireability derivation ----

test("qualified reference agent derives HIREABLE with passing checks", () => {
  const derived = derivePublicHireability({ candidate: qualified, record: { currentAvailability: "reachable" }, runs: [deliveredRun] });
  assert.equal(derived.ready, true);
  assert.equal(derived.status, HIRE_STATUSES.HIREABLE);
  assert.ok(derived.checks.every((item) => item.pass));
});

test("missing provider blocks hire with a named reason", () => {
  const derived = derivePublicHireability({ candidate: { ...qualified, agentWallet: null, ownerAddress: null }, record: { currentAvailability: "reachable" }, runs: [deliveredRun] });
  assert.equal(derived.ready, false);
  assert.equal(derived.status, HIRE_STATUSES.VERIFIED_NOT_HIREABLE);
  assert.match(derived.checks.find((item) => item.name === "provider_resolved").detail, /no provider/i);
});

test("wrong chain blocks hire", () => {
  const derived = derivePublicHireability({ candidate: { ...qualified, chainId: 56, network: "bsc-mainnet" }, record: { currentAvailability: "reachable" }, runs: [deliveredRun] });
  assert.equal(derived.ready, false);
});

test("third party without notification path stays non-hireable but generic", () => {
  const third = { ...qualified, reference: false, identity: "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2002" };
  const derived = derivePublicHireability({ candidate: third, record: { currentAvailability: "reachable" }, runs: [] });
  assert.equal(derived.ready, false);
  assert.equal(notificationPathFor(third, []).verified, false);
});

test("negotiate URL derives only from verified public bases", () => {
  assert.equal(negotiateUrlFor(qualified), "https://example.test/erc8183/negotiate");
  assert.equal(negotiateUrlFor({ ...qualified, services: [{ endpoint: "http://127.0.0.1:8787/x" }] }), null);
  assert.equal(negotiateUrlFor({ ...qualified, services: [] }), null);
});

// ---- task validation ----

test("task must be a bounded object with a real description", () => {
  assert.equal(validateTask(null).ok, false);
  assert.equal(validateTask({ description: "   " }).ok, false);
  assert.equal(validateTask({ description: "x".repeat(2001) }).ok, false);
  assert.equal(validateTask({ description: "Assess my Venus position." }).ok, true);
});

// ---- quote handler validation (zero chain contact on bad input) ----

test("quote requires buyer wallet before any provider contact", async () => {
  const { dir, store } = await tempStore();
  try {
    const result = await handleHireQuote({ store, candidates: [qualified], runs: [deliveredRun], listings: {}, body: { identity: qualified.identity, buyer: "not-an-address", task: { description: "Assess." } } });
    assert.equal(result.http, 400);
    assert.equal(result.body.error, "buyer_required");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("quote refuses unknown identity", async () => {
  const { dir, store } = await tempStore();
  try {
    const result = await handleHireQuote({ store, candidates: [], runs: [], listings: {}, body: { identity: "97:0x0:1", buyer: BUYER, task: { description: "Assess." } } });
    assert.equal(result.http, 404);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("quote refuses non-hireable agent without contacting provider", async () => {
  const { dir, store } = await tempStore();
  try {
    const blocked = { ...qualified, agentWallet: null, ownerAddress: null };
    const result = await handleHireQuote({ store, candidates: [blocked], runs: [], listings: {}, body: { identity: blocked.identity, buyer: BUYER, task: { description: "Assess." } } });
    assert.equal(result.http, 409);
    assert.equal(result.body.error, "not_hireable");
    assert.ok(Array.isArray(result.body.checks));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("declined provider quote surfaces truthfully", async () => {
  const declined = { request: {}, response: { accepted: false, reason: "busy" } };
  const result = await negotiatePublicQuote({ ...negotiateArgs(declined), taskDescription: "Assess my position." });
  assert.equal(result.ok, false);
  assert.match(result.reason, /declined|did not return/i);
});

test("non-numeric or excessive price is refused before verification", async () => {
  const badPrice = { request: { task_description: "Assess." }, response: { accepted: true, terms: { price: "not-a-number", currency: TOKEN } }, provider_sig: "0x00", negotiation_hash: "0x00", chain_id: 97 };
  const result = await negotiatePublicQuote({ ...negotiateArgs(badPrice), taskDescription: "Assess." });
  assert.equal(result.ok, false);
  const huge = { request: { task_description: "Assess." }, response: { accepted: true, terms: { price: (MAX_PUBLIC_PRICE_RAW + 1n).toString(), currency: TOKEN }, quote_expires_at: Math.floor(Date.now() / 1000) + 600 }, provider_sig: "0x00", negotiation_hash: "0x00", chain_id: 97 };
  const result2 = await negotiatePublicQuote({ ...negotiateArgs(huge), taskDescription: "Assess." });
  assert.equal(result2.ok, false);
  assert.match(result2.reason, /ceiling/i);
});

// ---- quote store state machine ----

function sampleQuote(overrides = {}) {
  return {
    quoteId: newQuoteId(),
    status: "ISSUED",
    agentIdentity: qualified.identity,
    agentName: qualified.name,
    buyer: BUYER.toLowerCase(),
    provider: PROVIDER.toLowerCase(),
    token: TOKEN.toLowerCase(),
    tokenSymbol: "U",
    tokenDecimals: 18,
    amountRaw: "1000000000000000",
    amountHuman: "0.001",
    quoteExpiresAt: Math.floor(Date.now() / 1000) + 900,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    estimatedCompletionSeconds: 120,
    negotiationHash: "0xabc",
    providerSignature: "0xdef",
    description: "job description",
    descriptionHash: keccak256(toHex("job description")),
    taskDescription: "Assess my position.",
    taskHash: keccak256(toHex("Assess my position.")),
    permissions: {},
    executionModel: null,
    jobExpiredAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test("quote transitions are atomic and single-use", async () => {
  const { dir, store } = await tempStore();
  try {
    const quote = sampleQuote();
    await putQuote(store, quote);
    assert.deepEqual(await getQuote(store, quote.quoteId), quote);
    const moved = await transitionQuote(store, quote.quoteId, "ISSUED", "PREPARED", { jobExpiredAt: 123 });
    assert.equal(moved.status, "PREPARED");
    assert.equal(moved.jobExpiredAt, 123);
    assert.equal(await transitionQuote(store, quote.quoteId, "ISSUED", "CONSUMED"), null);
    assert.equal(quoteExpired({ ...moved, expiresAt: Math.floor(Date.now() / 1000) - 1 }), true);
    assert.equal(quoteExpired(moved), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- prepare validation (no chain reads on bad input) ----

test("prepare requires quote, buyer match, and idempotency key", async () => {
  const { dir, store } = await tempStore();
  try {
    const quote = sampleQuote();
    await putQuote(store, quote);
    const noKey = await handleHirePrepare({ store, candidates: [qualified], runs: [deliveredRun], listings: {}, body: { quoteId: quote.quoteId, buyer: BUYER, idempotencyKey: "short" } });
    assert.equal(noKey.http, 400);
    const wrongBuyer = await handleHirePrepare({ store, candidates: [qualified], runs: [deliveredRun], listings: {}, body: { quoteId: quote.quoteId, buyer: OTHER, idempotencyKey: "valid-key-123" } });
    assert.equal(wrongBuyer.http, 403);
    const unknown = await handleHirePrepare({ store, candidates: [qualified], runs: [deliveredRun], listings: {}, body: { quoteId: "quote_missing", buyer: BUYER, idempotencyKey: "valid-key-123" } });
    assert.equal(unknown.http, 404);
    const expired = sampleQuote({ expiresAt: Math.floor(Date.now() / 1000) - 5 });
    await putQuote(store, expired);
    const gone = await handleHirePrepare({ store, candidates: [qualified], runs: [deliveredRun], listings: {}, body: { quoteId: expired.quoteId, buyer: BUYER, idempotencyKey: "valid-key-456" } });
    assert.equal(gone.http, 410);
    assert.equal((await getQuote(store, expired.quoteId)).status, "EXPIRED");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- submit validation (no chain reads on bad input) ----

test("submit validates shape and hire binding before any receipt check", async () => {
  const { dir, store } = await tempStore();
  try {
    const quote = sampleQuote();
    await putQuote(store, quote);
    await putHire(store, { hireId: newHireId(), quoteId: quote.quoteId, idempotencyKey: "key-abc-123", buyer: BUYER.toLowerCase(), agentIdentity: quote.agentIdentity, agentName: quote.agentName, provider: quote.provider, token: quote.token, tokenSymbol: "U", amountRaw: quote.amountRaw, amountHuman: "0.001", taskHash: quote.taskHash, jobId: null, jobExpiredAt: 999, state: "PREPARED", chainStatus: null, transactions: {}, notifyState: "pending", notifyDetail: null, deliverableUrl: null, result: null, failure: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const badHash = await handleHireSubmit({ store, candidates: [qualified], runs: [], body: { quoteId: quote.quoteId, idempotencyKey: "key-abc-123", steps: [{ kind: "create", txHash: "0xshort" }] } });
    assert.equal(badHash.http, 400);
    const badKind = await handleHireSubmit({ store, candidates: [qualified], runs: [], body: { quoteId: quote.quoteId, idempotencyKey: "key-abc-123", steps: [{ kind: "drain", txHash: "0x" + "ab".repeat(32) }] } });
    assert.equal(badKind.http, 400);
    const unknownHire = await handleHireSubmit({ store, candidates: [qualified], runs: [], body: { quoteId: quote.quoteId, idempotencyKey: "other-key-999", steps: [{ kind: "create", txHash: "0x" + "ab".repeat(32) }] } });
    assert.equal(unknownHire.http, 409);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---- idempotency + persistence ----

test("idempotency keys and tx hashes resolve to the existing hire", async () => {
  const { dir, store } = await tempStore();
  try {
    const quote = sampleQuote();
    await putQuote(store, quote);
    const hire = { hireId: newHireId(), quoteId: quote.quoteId, idempotencyKey: "key-reuse-1", buyer: BUYER.toLowerCase(), agentIdentity: quote.agentIdentity, agentName: quote.agentName, provider: quote.provider, token: quote.token, tokenSymbol: "U", amountRaw: quote.amountRaw, amountHuman: "0.001", taskHash: quote.taskHash, jobId: "700", jobExpiredAt: 999, state: "CREATED", chainStatus: "OPEN", transactions: { create: { txHash: "0x" + "cd".repeat(32), jobId: "700" } }, notifyState: "pending", notifyDetail: null, deliverableUrl: null, result: null, failure: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await putHire(store, hire);
    assert.equal((await findHireByIdempotency(store, "key-reuse-1")).hireId, hire.hireId);
    assert.equal((await findHireByQuote(store, quote.quoteId)).hireId, hire.hireId);
    assert.equal((await findHireByTx(store, "0x" + "CD".repeat(32))).hireId, hire.hireId);
    assert.equal(await findHireByTx(store, "0x" + "ff".repeat(32)), null);
    // Restart durability: a fresh store over the same directory sees it.
    const reopened = await new FileStore(dir).init();
    assert.equal((await findHireByIdempotency(reopened, "key-reuse-1")).hireId, hire.hireId);
    assert.equal((await getQuote(reopened, quote.quoteId)).quoteId, quote.quoteId);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("mine lists buyer hires without task text", async () => {
  const { dir, store } = await tempStore();
  try {
    const quote = sampleQuote();
    await putQuote(store, quote);
    await putHire(store, { hireId: newHireId(), quoteId: quote.quoteId, idempotencyKey: "key-mine-1", buyer: BUYER.toLowerCase(), agentIdentity: quote.agentIdentity, agentName: quote.agentName, provider: quote.provider, token: quote.token, tokenSymbol: "U", amountRaw: quote.amountRaw, amountHuman: "0.001", taskHash: quote.taskHash, jobId: null, jobExpiredAt: null, state: "PREPARED", chainStatus: null, transactions: {}, notifyState: "pending", notifyDetail: null, deliverableUrl: null, result: null, failure: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const mine = await handleHireMine({ store, buyer: BUYER });
    assert.equal(mine.http, 200);
    assert.equal(mine.body.count, 1);
    assert.equal(mine.body.hires[0].buyer, undefined);
    assert.ok(!JSON.stringify(mine.body).includes("Assess my position"));
    const bad = await handleHireMine({ store, buyer: "nope" });
    assert.equal(bad.http, 400);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Hire page separates new-hire mode from existing-hire recovery mode", () => {
  assert.equal(pagePathHireId("/hire/new"), null);
  assert.equal(pagePathHireId("/hire/hire_abc123"), "hire_abc123");
  assert.match(HIRE_PAGE, /state\.identity = params\(\)\.get\("identity"\)/);
  assert.match(HIRE_PAGE, /if \(!state\.identity\) \{ location\.replace\("\/marketplace"\); return; \}/);
});

test("Hire page handles missing or malformed new-hire identity safely and preserves My Hires recovery links", () => {
  assert.match(HIRE_PAGE, /api\("\/api\/agent\/" \+ encodeURIComponent\(state\.identity\)\)/);
  assert.match(HIRE_PAGE, /<strong>Agent not found<\/strong>/);
  const myHires = readFileSync(new URL("../web/hires.html", import.meta.url), "utf8");
  assert.match(myHires, /href="\/hire\/' \+ encodeURIComponent\(e\.hireId\)/);
  assert.match(myHires, /href="\/hire\/' \+ encodeURIComponent\(h\.hireId\)/);
});
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

test("valid /hire/new identity boots the new-hire experience", async () => {
  const h = createHirePageHarness({
    pathname: "/hire/new",
    search: `?identity=${encodeURIComponent(qualified.identity)}`,
    fetchImpl: async () => jsonResponse({ hire: { publicReady: true }, name: qualified.name, purpose: qualified.description }),
  });
  await h.hire.boot();
  assert.match(h.elements.get("flow").html, /<h2>Hire Qualified Agent<\/h2>/);
  assert.doesNotMatch(h.elements.get("flow").html, /Agent not found|Could not load this hire/);
  assert.equal(h.fetchCalls, 1);
});

test("existing hire URL boots existing-hire recovery mode", async () => {
  const h = createHirePageHarness({
    pathname: "/hire/hire_abc123",
    search: `?buyer=${BUYER}`,
    fetchImpl: async () => jsonResponse({ hireId: "hire_abc123", state: "DELIVERY_PENDING", jobId: "969", chainStatus: "SUBMITTED", deliverableAvailable: false, agent: { identity: qualified.identity, name: qualified.name } }),
  });
  await h.hire.boot();
  assert.match(h.elements.get("flow").html, /Provider submitted; validating delivery/);
  assert.match(h.elements.get("flow").html, /job[\s\S]*969/);
  assert.match(h.elements.get("flow").html, /SUBMITTED/);
  assert.equal(h.fetchCalls, 1);
});

test("/hire/new without identity redirects to safe agent selection", async () => {
  const h = createHirePageHarness({ pathname: "/hire/new", search: "" });
  await h.hire.boot();
  assert.deepEqual(h.historyCalls, [{ type: "replace", url: "/marketplace" }]);
  assert.equal(h.fetchCalls, 0);
});

test("malformed new-hire identity shows a clear safe error", async () => {
  const h = createHirePageHarness({
    pathname: "/hire/new",
    search: "?identity=malformed",
    fetchImpl: async () => jsonResponse({ error: "invalid_identity" }, { ok: false, status: 400 }),
  });
  await h.hire.boot();
  assert.match(h.elements.get("flow").html, /Agent not found/);
  assert.match(h.elements.get("flow").html, /invalid_identity/);
});

test("stalled existing-hire read exits Loading with a recoverable error", async () => {
  const h = createHirePageHarness({
    pathname: "/hire/hire_abc123",
    search: `?buyer=${BUYER}`,
    fetchImpl: () => new Promise(() => {}),
    triggerTimeout: true,
  });
  await h.hire.boot();
  assert.match(h.elements.get("flow").html, /Could not load this hire/);
  assert.match(h.elements.get("flow").html, /timed out while reading this hire/);
  assert.doesNotMatch(h.elements.get("flow").html, /Reading the agent and your hire/);
  assert.equal(h.fetchCalls, 1);
  assert.equal(walletWriteRequests(h).length, 0);
});
test("IPFS deliverable references resolve through the existing bounded gateway helper", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ job_id: "969", valid: true }),
    };
  };
  try {
    const result = await fetchDeliverable("ipfs://QmXQZBCcm3MagX548wCA2pVfyUph2U2BKX5v7uzp3vCkJF");
    assert.equal(result.ok, true);
    assert.equal(result.scheme, "ipfs");
    assert.match(seen[0], /^https:\/\//);
    assert.deepEqual(result.response.body, { job_id: "969", valid: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("provider snake_case job_id manifests remain hash-valid", () => {
  const manifest = { version: 1, job_id: 969, response: { content: "{\"ok\":true}", contentType: "text/plain" } };
  const validation = validateSubmittedDeliverable({ body: manifest, jobId: "969", onchainDeliverable: contentHashes(manifest).keccak256 });
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.manifestHash, contentHashes(manifest).keccak256);
});


test("completed Hire result renders token decimals while retaining the raw amount", async () => {
  const raw = "1000000000000000";
  const responseCost = { amountRaw: raw, tokenDecimals: 18, tokenSymbol: "U" };
  const h = createHirePageHarness({
    pathname: "/hire/hire_b52f758ed8354c4ea78f",
    search: `?buyer=${BUYER}`,
    fetchImpl: async (url) => {
      assert.ok(String(url).includes("/result?buyer="));
      return jsonResponse({ result: { status: "COMPLETED" }, metadata: { retrievedAt: "2026-09-04T00:00:00Z", cost: responseCost } });
    },
  });
  h.hire.state.buyer = BUYER;
  h.hire.state.hireId = "hire_b52f758ed8354c4ea78f";
  h.hire.state.hire = { state: "COMPLETED", hireId: h.hire.state.hireId, jobId: "969", chainStatus: "COMPLETED", deliverableAvailable: false, failure: null };
  await h.hire.renderStatus();
  await h.hire.loadResult();
  const html = h.elements.get("resultbox").html;
  assert.match(html, /cost 0\.001 U/);
  assert.doesNotMatch(html, /1000000000000000 U/);
  assert.equal(responseCost.amountRaw, raw);
  assert.equal(h.hire.formatTokenAmount(raw, responseCost.tokenDecimals), "0.001");
  assert.equal(h.hire.formatTokenAmount(raw, null), null);
});

class HireTestElement {
  constructor(id, owner) {
    this.id = id;
    this.owner = owner;
    this.value = "";
    this.disabled = false;
    this.html = "";
    this.listeners = new Map();
  }

  set innerHTML(value) {
    this.html = String(value);
    if (this.id === "flow") this.owner.registerMarkup(this.html);
  }

  get innerHTML() { return this.html; }

  addEventListener(type, handler) { this.listeners.set(type, handler); }

  async click() {
    const handler = this.listeners.get("click");
    assert.ok(handler, `${this.id} has a click handler`);
    return handler({ preventDefault() {} });
  }
}

function createHirePageHarness({ accounts = [], chainId = "0x1", switchError = null, addError = null, pathname = "/hire/new", search = `?identity=${encodeURIComponent(qualified.identity)}`, fetchImpl = null, triggerTimeout = false } = {}) {
  const elements = new Map();
  const requests = [];
  const events = new Map();
  const storageValues = new Map();
  let currentAccounts = [...accounts];
  let currentChainId = chainId;
  let switchErrorUsed = false;
  let fetchCalls = 0;
  const historyCalls = [];
  const document = {
    registerMarkup(markup) {
      for (const match of markup.matchAll(/\bid="([^"]+)"/g)) {
        const id = match[1];
        if (!elements.has(id)) elements.set(id, new HireTestElement(id, document));
      }
      const task = elements.get("task");
      const taskMarkup = markup.match(/<textarea[^>]*id="task"[^>]*>([\s\S]*?)<\/textarea>/);
      if (task && taskMarkup) task.value = taskMarkup[1];
      const quote = elements.get("quote");
      if (quote) quote.disabled = /<button[^>]*id="quote"[^>]*disabled/.test(markup);
    },
    querySelector(selector) {
      return selector.startsWith("#") ? elements.get(selector.slice(1)) || null : null;
    },
  };
  elements.set("flow", new HireTestElement("flow", document));
  const storage = {
    getItem(key) { return storageValues.has(key) ? storageValues.get(key) : null; },
    setItem(key, value) { storageValues.set(key, String(value)); },
    removeItem(key) { storageValues.delete(key); },
  };
  const ethereum = {
    async request({ method, params }) {
      requests.push({ method, params });
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [...currentAccounts];
      if (method === "eth_chainId") return currentChainId;
      if (method === "wallet_switchEthereumChain") {
        if (switchError && !switchErrorUsed) {
          switchErrorUsed = true;
          throw switchError;
        }
        currentChainId = params[0].chainId;
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        if (addError) throw addError;
        return null;
      }
      if (method === "eth_sendTransaction" || method.includes("sign")) throw new Error(`unexpected wallet write: ${method}`);
      throw new Error(`unexpected wallet request: ${method}`);
    },
    on(event, handler) { events.set(event, handler); },
  };
  const location = { pathname, search, replace(url) { historyCalls.push({ type: "replace", url }); } };
  const sandbox = {
    window: { ethereum },
    document,
    location,
    history: { replaceState(...args) { historyCalls.push({ type: "replaceState", args }); } },
    localStorage: storage,
    sessionStorage: storage,
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
    fetch: async (...args) => { fetchCalls += 1; return fetchImpl ? fetchImpl(...args) : { ok: false, status: 500, json: async () => ({}) }; },
    URLSearchParams,
    Uint8Array,
    setTimeout: triggerTimeout ? (fn, ms) => { if (ms === 20000) fn(); return 1; } : () => 0,
    clearTimeout: () => {},
    console,
  };
  const script = HIRE_SCRIPT.replace(/\n\s*boot\(\);\s*$/, "\n") + `
globalThis.__hireTest = { state, renderNew, connectWallet, switchToTestnet, requestQuote, syncWalletState, handleWalletEvent, api, boot, renderStatus, loadResult, formatTokenAmount };
`;
  runInNewContext(script, sandbox);
  const hire = sandbox.__hireTest;
  hire.state.identity = qualified.identity;
  hire.state.agent = { name: qualified.name, purpose: qualified.description };
  hire.renderNew();
  return {
    hire,
    elements,
    requests,
    events,
    historyCalls,
    get fetchCalls() { return fetchCalls; },
    get chainId() { return currentChainId; },
    setAccounts(next) { currentAccounts = [...next]; },
    async flush() { await new Promise((resolve) => setImmediate(resolve)); },
  };
}

function walletWriteRequests(harness) {
  return harness.requests.filter(({ method }) => method === "eth_sendTransaction" || method.includes("sign"));
}

test("new Hire starts disconnected and blocks quote until BSC Testnet is ready", () => {
  const h = createHirePageHarness();
  assert.match(h.elements.get("flow").html, /Connect your wallet to continue\./);
  assert.equal(h.elements.get("quote").disabled, true);
  assert.equal(h.elements.has("switch"), false);
});

test("connecting on the wrong chain shows the connected-wallet switch state and preserves task text", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1" });
  const task = "Assess this arbitrary owner task without changing it.";
  h.elements.get("task").value = task;
  await h.elements.get("connect").click();
  const html = h.elements.get("flow").html;
  assert.equal(h.hire.state.buyer, BUYER);
  assert.equal(h.hire.state.chainId, "0x1");
  assert.match(html, /Wallet connected\. Switch to BSC Testnet \(chain 97\) to continue\./);
  assert.match(html, new RegExp(BUYER));
  assert.equal(h.elements.get("task").value, task);
  assert.equal(h.elements.get("quote").disabled, true);
  assert.equal(h.requests.some(({ method }) => method === "wallet_switchEthereumChain"), false);
  assert.equal(walletWriteRequests(h).length, 0);
});

test("connecting on chain 97 shows ready state and preserves task text", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x61" });
  const task = "Keep this task while the wallet becomes ready.";
  h.elements.get("task").value = task;
  await h.elements.get("connect").click();
  assert.match(h.elements.get("flow").html, /Connected to BSC Testnet\./);
  assert.equal(h.elements.get("quote").disabled, false);
  assert.equal(h.elements.get("task").value, task);
  assert.equal(walletWriteRequests(h).length, 0);
});

test("Switch to BSC Testnet explicitly requests chain 0x61 and does not spend", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1" });
  await h.elements.get("connect").click();
  const task = "Preserve this task across an explicit network switch.";
  h.elements.get("task").value = task;
  await h.elements.get("switch").click();
  const switchRequests = h.requests.filter(({ method }) => method === "wallet_switchEthereumChain");
  assert.equal(JSON.stringify(switchRequests.map(({ params }) => params)), JSON.stringify([[{ chainId: "0x61" }]]));
  assert.equal(h.hire.state.chainId, "0x61");
  assert.match(h.elements.get("flow").html, /Connected to BSC Testnet\./);
  assert.equal(h.elements.get("task").value, task);
  assert.equal(h.elements.get("quote").disabled, false);
  assert.equal(walletWriteRequests(h).length, 0);
});

test("unknown BSC Testnet falls back to add-chain then switch with canonical chain details", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1", switchError: { code: 4902, message: "Unknown chain" } });
  await h.elements.get("connect").click();
  await h.elements.get("switch").click();
  const add = h.requests.find(({ method }) => method === "wallet_addEthereumChain");
  assert.ok(add);
  assert.equal(add.params[0].chainId, "0x61");
  assert.equal(add.params[0].chainName, "BSC Testnet");
  assert.equal(add.params[0].nativeCurrency.symbol, "tBNB");
  assert.equal(add.params[0].blockExplorerUrls[0], "https://testnet.bscscan.com");
  assert.equal(h.hire.state.chainId, "0x61");
  assert.equal(walletWriteRequests(h).length, 0);
});

test("rejected network switch remains truthful and preserves task text", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1", switchError: { code: 4001, message: "User rejected the request" } });
  await h.elements.get("connect").click();
  const task = "Do not lose this task when the owner cancels switching.";
  h.elements.get("task").value = task;
  await h.elements.get("switch").click();
  const html = h.elements.get("flow").html;
  assert.equal(h.hire.state.chainId, "0x1");
  assert.match(html, /Network switch cancelled\. Switch to BSC Testnet to continue\./)
  assert.doesNotMatch(html, /Wallet not connected\./);
  assert.equal(h.elements.get("task").value, task);
  assert.equal(walletWriteRequests(h).length, 0);
});

test("already on BSC Testnet is treated as success without a switch request", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x61" });
  await h.elements.get("connect").click();
  h.requests.length = 0;
  await h.hire.switchToTestnet();
  assert.equal(h.hire.state.chainId, "0x61");
  assert.equal(h.requests.some(({ method }) => method === "wallet_switchEthereumChain"), false);
  assert.equal(h.requests.some(({ method }) => method === "wallet_addEthereumChain"), false);
  assert.equal(walletWriteRequests(h).length, 0);
});

test("unknown-chain message falls back to canonical add-chain then switch", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1", switchError: { code: -32603, message: "Unrecognized chain ID" } });
  await h.elements.get("connect").click();
  await h.elements.get("switch").click();
  assert.equal(h.requests.filter(({ method }) => method === "wallet_addEthereumChain").length, 1);
  assert.equal(h.hire.state.chainId, "0x61");
  assert.equal(walletWriteRequests(h).length, 0);
});

test("rejected add-chain remains connected and preserves task text", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1", switchError: { code: 4902, message: "Unknown chain" }, addError: { code: 4001, message: "User rejected adding the network" } });
  await h.elements.get("connect").click();
  const task = "Keep this task if adding BSC Testnet is cancelled.";
  h.elements.get("task").value = task;
  await h.elements.get("switch").click();
  const html = h.elements.get("flow").html;
  assert.equal(h.hire.state.buyer, BUYER);
  assert.equal(h.hire.state.chainId, "0x1");
  assert.match(html, /Adding BSC Testnet was cancelled\. Switch to BSC Testnet to continue\./);
  assert.equal(h.elements.get("task").value, task);
  assert.equal(h.hire.state.walletErrorDetail.code, 4001);
  assert.equal(h.hire.state.walletErrorDetail.phase, "add");
  assert.equal(walletWriteRequests(h).length, 0);
});

test("unsupported switch method reports a wallet-specific fallback without adding a chain", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1", switchError: { code: -32601, message: "wallet_switchEthereumChain is not supported" } });
  await h.elements.get("connect").click();
  const task = "Keep this task when the wallet cannot switch programmatically.";
  h.elements.get("task").value = task;
  await h.elements.get("switch").click();
  const html = h.elements.get("flow").html;
  assert.match(html, /does not support programmatic network switching/);
  assert.doesNotMatch(html, /Wallet not connected\./);
  assert.equal(h.requests.some(({ method }) => method === "wallet_addEthereumChain"), false);
  assert.equal(h.hire.state.buyer, BUYER);
  assert.equal(h.hire.state.chainId, "0x1");
  assert.equal(h.elements.get("task").value, task);
  assert.equal(h.hire.state.walletErrorDetail.code, -32601);
  assert.equal(h.hire.state.walletErrorDetail.message, "wallet_switchEthereumChain is not supported");
  assert.equal(h.hire.state.walletErrorDetail.provider, "browser wallet");
  assert.equal(h.hire.state.walletErrorDetail.currentChainId, "0x1");
  assert.equal(h.hire.state.walletErrorDetail.requestedChainId, "0x61");
  assert.equal(h.hire.state.walletErrorDetail.phase, "switch");
  assert.equal(walletWriteRequests(h).length, 0);
});

test("provider switch error stays connected and records exact diagnostics", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x1", switchError: { code: -32000, message: "RPC endpoint rejected chain 97" } });
  await h.elements.get("connect").click();
  const task = "Keep this task when the provider rejects the configured chain.";
  h.elements.get("task").value = task;
  await h.elements.get("switch").click();
  const html = h.elements.get("flow").html;
  assert.match(html, /Check your wallet network configuration and try again/);
  assert.equal(h.hire.state.buyer, BUYER);
  assert.equal(h.hire.state.chainId, "0x1");
  assert.equal(h.elements.get("task").value, task);
  assert.equal(h.hire.state.walletErrorDetail.code, -32000);
  assert.equal(h.hire.state.walletErrorDetail.message, "RPC endpoint rejected chain 97");
  assert.equal(h.hire.state.walletErrorDetail.currentChainId, "0x1");
  assert.equal(h.hire.state.walletErrorDetail.requestedChainId, "0x61");
  assert.equal(h.hire.state.walletErrorDetail.phase, "switch");
  assert.equal(walletWriteRequests(h).length, 0);
});
test("chain changes update network truth, preserve task text, and block quote on the wrong chain", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x61" });
  await h.elements.get("connect").click();
  const task = "Preserve this task while chain truth changes.";
  h.elements.get("task").value = task;
  await h.events.get("chainChanged")("0x1");
  await h.flush();
  assert.equal(h.hire.state.chainId, "0x1");
  assert.match(h.elements.get("flow").html, /Wallet connected\. Switch to BSC Testnet \(chain 97\) to continue\./);
  assert.equal(h.elements.get("task").value, task);
  assert.equal(h.elements.get("quote").disabled, true);
  await h.hire.requestQuote();
  assert.equal(h.fetchCalls, 0);
  assert.match(h.elements.get("out").html, /Switch to BSC Testnet first\./);
  await h.events.get("chainChanged")("0x61");
  await h.flush();
  assert.match(h.elements.get("flow").html, /Connected to BSC Testnet\./);
  assert.equal(h.elements.get("task").value, task);
});

test("account changes replace the buyer and invalidate stale quote state without wallet writes", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x61" });
  await h.elements.get("connect").click();
  const task = "Keep the task but discard buyer-bound prepared state.";
  h.elements.get("task").value = task;
  h.hire.state.quote = { quoteId: "stale" };
  h.hire.state.idempotencyKey = "stale-key";
  h.setAccounts([OTHER]);
  await h.events.get("accountsChanged")([OTHER]);
  await h.flush();
  assert.equal(h.hire.state.buyer, OTHER);
  assert.equal(h.hire.state.quote, null);
  assert.equal(h.hire.state.idempotencyKey, null);
  assert.equal(h.elements.get("task").value, task);
  assert.equal(walletWriteRequests(h).length, 0);
});

test("disconnect returns to the safe disconnected state without losing task text", async () => {
  const h = createHirePageHarness({ accounts: [BUYER], chainId: "0x61" });
  await h.elements.get("connect").click();
  const task = "Keep this task if the wallet disconnects.";
  h.elements.get("task").value = task;
  await h.events.get("disconnect")();
  assert.equal(h.hire.state.buyer, null);
  assert.equal(h.hire.state.chainId, null);
  assert.match(h.elements.get("flow").html, /Connect your wallet to continue\./);
  assert.match(h.elements.get("flow").html, /Wallet disconnected\. Nothing was spent\./);
  assert.equal(h.elements.get("task").value, task);
  assert.equal(walletWriteRequests(h).length, 0);
});

// ---- transaction plan determinism + bounded approval ----

test("hire calldata uses the official function shapes", () => {
  const create = encodeFunctionData({ abi: HIRE_ABIS.COMMERCE_ABI, functionName: "createJob", args: [PROVIDER, OTHER, 123n, "desc", OTHER] });
  const decoded = decodeHireCall(create);
  assert.equal(decoded.functionName, "createJob");
  assert.equal(decoded.args[0].toLowerCase(), PROVIDER.toLowerCase());
  const approve = encodeFunctionData({ abi: HIRE_ABIS.ERC20_ABI, functionName: "approve", args: [OTHER, 1000n] });
  assert.equal(decodeHireCall(approve).functionName, "approve");
  assert.throws(() => decodeHireCall("0xdeadbeef"), /not a recognized hire action/);
  const selectors = new Map();
  for (const [abiName, abi] of Object.entries(HIRE_ABIS)) {
    for (const item of abi) {
      if (item.type !== "function") continue;
      const selector = keccak256(toHex(`${item.name}(${item.inputs.map((i) => i.type).join(",")})`)).slice(0, 10);
      const seen = selectors.get(selector);
      assert.ok(!seen || seen === `${abiName}.${item.name}`, `selector collision: ${seen} vs ${abiName}.${item.name}`);
      selectors.set(selector, `${abiName}.${item.name}`);
    }
  }
  // Pinned official shapes (computed, then cross-checked against the SDK
  // bundle ABI): any drift here breaks browser transactions.
  assert.equal(keccak256(toHex("createJob(address,address,uint256,string,address)")).slice(0, 10), "0x41528812");
  assert.equal(keccak256(toHex("fund(uint256,uint256,bytes)")).slice(0, 10), "0xd2e13f50");
  assert.equal(keccak256(toHex("registerJob(uint256,address)")).slice(0, 10), "0x51d5456d");
  assert.equal(keccak256(toHex("setBudget(uint256,uint256,bytes)")).slice(0, 10), "0xdd4ae9d4");
});

test("accepted quote must bind the exact requested task", async () => {
  const mismatched = { request: { task_description: "A different task." }, response: { accepted: true, terms: { price: "1000000000000000", currency: TOKEN } }, provider_sig: "0x00", negotiation_hash: "0x00", chain_id: 97 };
  const result = await negotiatePublicQuote({ ...negotiateArgs(mismatched), taskDescription: "Assess my position." });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not bound/i);
});

test("JobCreated decoder matches the official indexed event layout", () => {
  const commerce = "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de";
  const expiry = 123456n;
  const hook = OTHER;
  const signature = keccak256(toHex("JobCreated(uint256,address,address,address,uint256,address)"));
  const topic = (value) => toHex(BigInt(value), { size: 32 });
  const receipt = { logs: [{ address: commerce, topics: [signature, topic(701n), topic(BUYER), topic(PROVIDER)], data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [OTHER, expiry, hook]) }] };
  const decoded = decodeJobCreated(receipt, { commerce, buyer: BUYER, provider: PROVIDER });
  assert.deepEqual(decoded, { jobId: "701", client: BUYER.toLowerCase(), provider: PROVIDER.toLowerCase() });
});
