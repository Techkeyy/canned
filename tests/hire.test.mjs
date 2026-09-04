import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeFunctionData, keccak256, toHex } from "viem";
import { FileStore } from "../src/persistence/file-store.mjs";
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
