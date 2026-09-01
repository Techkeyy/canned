import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { charge, preflightCharge } from "@bnb-chain/mpp/server";
import { Mppx } from "mppx/server";
import { buildHealthFactorDeliverable, validateHealthFactorTask } from "./health-factor.mjs";
import { FileMppReplayStore } from "./mpp-replay-store.mjs";

export const HEALTH_FACTOR_MPP_PATH = "/mpp";
export const HEALTH_FACTOR_MPP_STATUS_PATH = "/api/reference/health-factor/mpp";
export const HEALTH_FACTOR_MPP_EVIDENCE_PATH = "/api/reference/health-factor/mpp/evidence";
export const HEALTH_FACTOR_MPP_NETWORK = "bsc-testnet";
export const HEALTH_FACTOR_MPP_CHAIN_ID = 97;
export const HEALTH_FACTOR_MPP_TOKEN = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
export const HEALTH_FACTOR_MPP_TOKEN_SYMBOL = "USDT";
export const HEALTH_FACTOR_MPP_TOKEN_NAME = "USDT Token";
export const HEALTH_FACTOR_MPP_TOKEN_DECIMALS = 18;
export const HEALTH_FACTOR_MPP_PRICE_RAW = "10000000000000000";
export const HEALTH_FACTOR_MPP_PRICE_DECIMAL = "0.01";
export const HEALTH_FACTOR_MPP_MAX_PRICE_RAW = "20000000000000000";
export const HEALTH_FACTOR_MPP_CREDENTIAL_TYPES = Object.freeze(["transaction", "hash"]);
export const HEALTH_FACTOR_MPP_EXTERNAL_ID = "canned-health-guard-mpp-v1";
export const HEALTH_FACTOR_MPP_SCOPE = "canned-health-guard:/mpp";
export const HEALTH_FACTOR_MPP_BODY_LIMIT = 64 * 1024;

const ERC20_METADATA_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeChmod(file, mode) {
  return chmod(file, mode).catch((error) => {
    if (!["EPERM", "ENOSYS", "EROFS"].includes(error?.code)) throw error;
  });
}

async function loadOrCreateSecret({ dataDir, env }) {
  const configured = env?.MPP_SECRET_KEY;
  if (configured !== undefined) {
    if (!nonEmpty(configured) || new TextEncoder().encode(configured).byteLength < 32) {
      throw new Error("MPP_SECRET_KEY must contain at least 32 bytes.");
    }
    return { value: configured, source: "environment" };
  }
  const secretFile = path.join(dataDir, "state", "mpp-secret-key");
  await mkdir(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  try {
    const value = (await readFile(secretFile, "utf8")).trim();
    if (!nonEmpty(value) || new TextEncoder().encode(value).byteLength < 32) throw new Error("stored MPP secret is invalid");
    await safeChmod(secretFile, 0o600);
    return { value, source: "local_secure_state" };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const value = randomBytes(32).toString("base64url");
    try {
      await writeFile(secretFile, `${value}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
      const existing = (await readFile(secretFile, "utf8")).trim();
      if (!nonEmpty(existing) || new TextEncoder().encode(existing).byteLength < 32) throw new Error("stored MPP secret is invalid");
      await safeChmod(secretFile, 0o600);
      return { value: existing, source: "local_secure_state" };
    }
    await safeChmod(secretFile, 0o600);
    return { value, source: "generated_local_secure_state" };
  }
}

function requestHeaders(request) {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
  }
  return headers;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > HEALTH_FACTOR_MPP_BODY_LIMIT) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseTask(raw) {
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { return { valid: false, errors: ["body_must_be_json"] }; }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { valid: false, errors: ["body_must_be_object"] };
  const task = body.task && typeof body.task === "object" && !Array.isArray(body.task) ? body.task : body;
  const previousSnapshot = body.previousSnapshot || task.previousSnapshot || null;
  const validation = validateHealthFactorTask(task);
  return { valid: validation.valid, errors: validation.errors, task, previousSnapshot };
}

function errorReason(error) {
  return error instanceof Error ? error.message : String(error);
}

function statusBase({ state, available, recipient, realm, reason, tokenVerified = false, secretSource = null, storeReady = false } = {}) {
  return {
    protocol: "mpp",
    adapter: "generic-evm-charge",
    notX402: true,
    notB402: true,
    path: HEALTH_FACTOR_MPP_PATH,
    statusPath: HEALTH_FACTOR_MPP_STATUS_PATH,
    network: HEALTH_FACTOR_MPP_NETWORK,
    chainId: HEALTH_FACTOR_MPP_CHAIN_ID,
    token: HEALTH_FACTOR_MPP_TOKEN_SYMBOL,
    tokenName: HEALTH_FACTOR_MPP_TOKEN_NAME,
    tokenAddress: HEALTH_FACTOR_MPP_TOKEN,
    decimals: HEALTH_FACTOR_MPP_TOKEN_DECIMALS,
    amountRaw: HEALTH_FACTOR_MPP_PRICE_RAW,
    amount: HEALTH_FACTOR_MPP_PRICE_DECIMAL,
    hardMaxAmountRaw: HEALTH_FACTOR_MPP_MAX_PRICE_RAW,
    recipient: ADDRESS_RE.test(String(recipient || "")) ? recipient : null,
    credentialTypes: [...HEALTH_FACTOR_MPP_CREDENTIAL_TYPES],
    settlement: "payer-funded",
    confirmations: 1,
    replayProtection: storeReady ? "durable-file-atomic" : "not-ready",
    challengeBinding: "mppx-managed",
    realm: realm || null,
    secretSource,
    tokenVerified,
    state,
    available,
    reason: reason || null,
  };
}

function fetchRequestFromNode({ request, rawBody, protocol = "http:" }) {
  const host = request.headers.host || "localhost";
  const target = new URL(request.url || HEALTH_FACTOR_MPP_PATH, `${protocol}//${host}`);
  const init = { method: request.method || "POST", headers: requestHeaders(request) };
  if (rawBody) init.body = rawBody;
  return new Request(target, init);
}

async function sendFetchResponse(response, output) {
  const headers = {};
  for (const [name, value] of output.headers) headers[name] = value;
  response.writeHead(output.status, headers);
  if (!output.body) { response.end(); return; }
  response.end(Buffer.from(await output.arrayBuffer()));
}

export async function createHealthFactorMpp({ dataDir, recipient, publicUrl = null, env = process.env } = {}) {
  const base = path.resolve(dataDir || path.join(process.cwd(), "data"));
  const normalizedRecipient = typeof recipient === "string" ? recipient.trim() : "";
  const realm = publicUrl ? new URL(publicUrl).hostname : null;
  if (!ADDRESS_RE.test(normalizedRecipient)) {
    return { handler: null, status: statusBase({ state: "disabled", available: false, recipient: null, realm, reason: "Health Guard provider recipient is not configured." }) };
  }
  try {
    const secret = await loadOrCreateSecret({ dataDir: base, env });
    const replayStore = await new FileMppReplayStore(path.join(base, "state", "mpp-replay")).init();
    const rpcUrl = env?.RPC_URL_BSC_TESTNET || env?.CANNED_RPC_URL || undefined;
    const prepared = await preflightCharge({
      recipient: normalizedRecipient,
      amount: HEALTH_FACTOR_MPP_PRICE_RAW,
      description: "Canned Health Guard Quick Health Check",
      externalId: HEALTH_FACTOR_MPP_EXTERNAL_ID,
      chain: HEALTH_FACTOR_MPP_NETWORK,
      token: "TEST_USDT",
      ...(rpcUrl ? { rpcUrl } : {}),
      credentialTypes: HEALTH_FACTOR_MPP_CREDENTIAL_TYPES,
      confirmations: 1,
      settlementTimeoutMs: 120_000,
      inflightTtlMs: 600_000,
      hashFromPolicy: "strict_from",
      challengeBinding: { mode: "mppx-managed" },
      store: replayStore,
    });
    const resolved = prepared._resolved;
    if (resolved.chainId !== HEALTH_FACTOR_MPP_CHAIN_ID || resolved.currency.toLowerCase() !== HEALTH_FACTOR_MPP_TOKEN.toLowerCase() || resolved.decimals !== HEALTH_FACTOR_MPP_TOKEN_DECIMALS) {
      throw new Error("official MPP preflight resolved an unexpected BSC Testnet token or chain.");
    }
    const publicClient = resolved.publicClient;
    const [chainId, bytecode, decimals, symbol, name] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBytecode({ address: HEALTH_FACTOR_MPP_TOKEN }),
      publicClient.readContract({ address: HEALTH_FACTOR_MPP_TOKEN, abi: ERC20_METADATA_ABI, functionName: "decimals" }),
      publicClient.readContract({ address: HEALTH_FACTOR_MPP_TOKEN, abi: ERC20_METADATA_ABI, functionName: "symbol" }),
      publicClient.readContract({ address: HEALTH_FACTOR_MPP_TOKEN, abi: ERC20_METADATA_ABI, functionName: "name" }),
    ]);
    if (chainId !== HEALTH_FACTOR_MPP_CHAIN_ID || !bytecode || bytecode === "0x" || decimals !== HEALTH_FACTOR_MPP_TOKEN_DECIMALS || symbol !== HEALTH_FACTOR_MPP_TOKEN_SYMBOL || name !== HEALTH_FACTOR_MPP_TOKEN_NAME) {
      throw new Error("live BSC Testnet token identity did not match the official TEST_USDT preset.");
    }
    const realmValue = realm || env?.MPP_REALM || "health-guard-mpp";
    const method = charge(prepared);
    const payment = Mppx.create({ methods: [method], realm: realmValue, secretKey: secret.value });
    const handler = payment.evm.charge({ amount: HEALTH_FACTOR_MPP_PRICE_RAW, scope: HEALTH_FACTOR_MPP_SCOPE });
    const status = statusBase({ state: "active", available: true, recipient: normalizedRecipient, realm: realmValue, tokenVerified: true, secretSource: secret.source, storeReady: true });
    return {
      handler,
      payment,
      status,
      async handle({ request, response, protocol = "http:" } = {}) {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST", "Cache-Control": "no-store" });
          response.end();
          return;
        }
        let rawBody;
        try {
          rawBody = await readBody(request);
        } catch (error) {
          response.writeHead(error?.message === "Request body is too large." ? 413 : 400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: error?.message === "Request body is too large." ? "request_body_too_large" : "request_body_unreadable" }));
          return;
        }
        const parsed = parseTask(rawBody);
        if (!parsed.valid) {
          response.writeHead(422, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "invalid_health_guard_request", errors: parsed.errors }));
          return;
        }
        const input = fetchRequestFromNode({ request, rawBody, protocol });
        const result = await handler(input);
        if (result.status === 402) {
          await sendFetchResponse(response, result.challenge);
          return;
        }
        const work = buildHealthFactorDeliverable({ jobId: null, task: parsed.task, previousSnapshot: parsed.previousSnapshot });
        if (!work.ok) {
          response.writeHead(422, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ error: "health_guard_work_failed", status: work.status, errors: work.errors || [] }));
          return;
        }
        const output = new Response(work.canonicalOutput, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Canned-Payment-Protocol": "MPP" } });
        await sendFetchResponse(response, result.withReceipt(output));
      },
    };
  } catch (error) {
    return { handler: null, status: statusBase({ state: "disabled", available: false, recipient: normalizedRecipient, realm, reason: "official MPP preflight failed; seller disabled", storeReady: false, tokenVerified: false }) , initError: errorReason(error) };
  }
}

export function mppTokenMetadata() {
  return { address: HEALTH_FACTOR_MPP_TOKEN, symbol: HEALTH_FACTOR_MPP_TOKEN_SYMBOL, name: HEALTH_FACTOR_MPP_TOKEN_NAME, decimals: HEALTH_FACTOR_MPP_TOKEN_DECIMALS, network: HEALTH_FACTOR_MPP_NETWORK, chainId: HEALTH_FACTOR_MPP_CHAIN_ID };
}

/**
 * Whitelist the already-recorded payment proof for public inspection. Raw
 * request headers, credentials, and local runner details never cross this
 * boundary.
 */
export function publicMppEvidence(record = null) {
  if (!record || typeof record !== "object") {
    return { schemaVersion: 1, available: false, protocol: "MPP", notX402: true, notB402: true, reason: "No verified payment record is available." };
  }
  return {
    schemaVersion: 1,
    available: true,
    protocol: record.protocol || "MPP",
    notX402: record.notX402 === true,
    notB402: record.notB402 === true,
    network: record.network || HEALTH_FACTOR_MPP_NETWORK,
    chainId: record.chainId || HEALTH_FACTOR_MPP_CHAIN_ID,
    endpoint: record.endpoint || null,
    recipient: record.recipient || null,
    token: record.token && typeof record.token === "object" ? {
      address: record.token.address || null,
      symbol: record.token.symbol || null,
      decimals: record.token.decimals ?? null,
    } : null,
    amountRaw: record.amountRaw || null,
    transactionHash: record.transactionHash || null,
    blockNumber: record.blockNumber || null,
    independentReceipt: record.independentReceipt && typeof record.independentReceipt === "object" ? {
      status: record.independentReceipt.status || null,
      exactTransferEvents: record.independentReceipt.exactTransferEvents ?? null,
      rpc: record.independentReceipt.rpc || null,
    } : null,
    officialReplayVerification: record.officialReplayVerification && typeof record.officialReplayVerification === "object" ? {
      state: record.officialReplayVerification.state || null,
      replayHttpStatus: record.officialReplayVerification.replayHttpStatus ?? null,
      replayDetail: record.officialReplayVerification.replayDetail || null,
      secondBroadcast: record.officialReplayVerification.secondBroadcast === true,
    } : null,
    paymentReceipt: record.paymentReceipt && typeof record.paymentReceipt === "object" ? {
      originalHeaderRetained: record.paymentReceipt.originalHeaderRetained === true,
      reason: record.paymentReceipt.reason || null,
    } : null,
    verifiedAt: record.verifiedAt || null,
  };
}
