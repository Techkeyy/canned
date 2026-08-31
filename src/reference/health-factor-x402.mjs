import { B402Seller } from "@bnbagent/studio-runtime/b402";
import { buildHealthFactorDeliverable } from "./health-factor.mjs";
import { REFERENCE_CHAIN_ID, REFERENCE_NETWORK, REFERENCE_PAYMENT_TOKEN, REFERENCE_ORIGIN } from "./constants.mjs";

export const HEALTH_FACTOR_X402_PATH = "/x402";
export const HEALTH_FACTOR_X402_DEFAULT_PRICE_USD = "0.0005";
export const HEALTH_FACTOR_X402_MAX_PRICE_USD = "0.001";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;
const PRICE_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;
const B402_CREDENTIAL_KEYS = Object.freeze([
  "B402_BASE_URL",
  "B402_CLIENT_ID",
  "B402_ACCESS_TOKEN",
]);

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safePrice(priceUsd) {
  const value = String(priceUsd ?? HEALTH_FACTOR_X402_DEFAULT_PRICE_USD).trim();
  if (!PRICE_RE.test(value)) return { value, valid: false, reason: "price_usd must be a non-negative decimal string" };
  if (Number(value) > Number(HEALTH_FACTOR_X402_MAX_PRICE_USD)) {
    return { value, valid: false, reason: `price_usd exceeds the ${HEALTH_FACTOR_X402_MAX_PRICE_USD} U directive cap` };
  }
  return { value, valid: true, reason: null };
}

export function b402CredentialStatus(env = process.env) {
  const present = Object.fromEntries(B402_CREDENTIAL_KEYS.map((key) => [key, nonEmpty(env?.[key])]));
  const privateKeyPresent = nonEmpty(env?.B402_PRIVATE_KEY) || nonEmpty(env?.B402_PRIVATE_KEY_B64);
  return {
    present: { ...present, B402_PRIVATE_KEY: privateKeyPresent },
    configured: Object.values(present).every(Boolean) && privateKeyPresent,
    names: [...B402_CREDENTIAL_KEYS, "B402_PRIVATE_KEY or B402_PRIVATE_KEY_B64"],
  };
}

export function parseHealthFactorX402Prompt(prompt) {
  if (!nonEmpty(prompt)) return { valid: false, errors: ["prompt_required"], task: null, previousSnapshot: null };
  let body;
  try {
    body = JSON.parse(prompt);
  } catch {
    return { valid: false, errors: ["prompt_must_be_json"], task: null, previousSnapshot: null };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, errors: ["prompt_must_be_object"], task: null, previousSnapshot: null };
  }
  const task = body.task && typeof body.task === "object" && !Array.isArray(body.task) ? body.task : body;
  return {
    valid: true,
    errors: [],
    task,
    previousSnapshot: body.previousSnapshot || task.previousSnapshot || null,
  };
}

/**
 * Deterministic Health Guard work hook for the official B402 seller.
 * The paid face accepts the same frozen Venus snapshot shape as the existing
 * ERC-8183 reference service; it never moves capital or lets a payer choose
 * a signing operation.
 */
export function healthFactorX402Work({ prompt }) {
  const parsed = parseHealthFactorX402Prompt(prompt);
  if (!parsed.valid) {
    return JSON.stringify({
      schemaVersion: "health-factor-x402-v1",
      origin: REFERENCE_ORIGIN,
      category: "health_factor_monitoring",
      status: "INVALID_REQUEST",
      errors: parsed.errors,
      inputSchema: "JSON object with account, protocol=venus, authoritativeSnapshot, and optional previousSnapshot",
    });
  }
  const result = buildHealthFactorDeliverable({
    jobId: null,
    task: parsed.task,
    snapshot: parsed.task.authoritativeSnapshot,
    previousSnapshot: parsed.previousSnapshot,
  });
  return result.canonicalOutput || JSON.stringify(result.output || {
    schemaVersion: "health-factor-x402-v1",
    origin: REFERENCE_ORIGIN,
    status: result.status,
  });
}

export function x402Status({ seller = null, recipient = null, priceUsd = HEALTH_FACTOR_X402_DEFAULT_PRICE_USD, resourceUrl = null, env = process.env, reason = null } = {}) {
  const credentials = b402CredentialStatus(env);
  const price = safePrice(priceUsd);
  const recipientValid = typeof recipient === "string" && ADDRESS_RE.test(recipient);
  const state = seller?.state || "disabled";
  return {
    protocol: "x402",
    settlement: "B402",
    path: HEALTH_FACTOR_X402_PATH,
    resourceUrl,
    network: REFERENCE_NETWORK,
    chainId: REFERENCE_CHAIN_ID,
    asset: "U",
    assetAddress: REFERENCE_PAYMENT_TOKEN,
    priceUsd: price.value,
    directivePriceCapUsd: HEALTH_FACTOR_X402_MAX_PRICE_USD,
    recipient: recipientValid ? recipient : null,
    state,
    available: state === "active",
    credentials: { configured: credentials.configured, present: credentials.present },
    reason: reason || (!recipientValid ? "Health Guard provider recipient is not configured." : !price.valid ? price.reason : state === "dormant" ? "B402 merchant credentials are not configured; the official seller remains dormant." : null),
  };
}

export async function createHealthFactorX402Seller({ walletAddress, expectedRecipient = null, resourceUrl, priceUsd = process.env.CANNED_X402_PRICE_USD || HEALTH_FACTOR_X402_DEFAULT_PRICE_USD, env = process.env } = {}) {
  const price = safePrice(priceUsd);
  const recipient = typeof walletAddress === "string" ? walletAddress.trim() : "";
  const recipientValid = ADDRESS_RE.test(recipient);
  const expectedRecipientValue = typeof expectedRecipient === "string" ? expectedRecipient.trim() : "";
  const expectedRecipientValid = !expectedRecipientValue || ADDRESS_RE.test(expectedRecipientValue);
  const recipientMatchesExpected = expectedRecipientValid && (!expectedRecipientValue || recipient.toLowerCase() === expectedRecipientValue.toLowerCase());
  const credentials = b402CredentialStatus(env);
  const reason = !recipientValid
    ? "Health Guard provider recipient is not configured or is not a valid EVM address."
    : !expectedRecipientValid
      ? "Health Guard expected provider recipient is not a valid EVM address."
      : !recipientMatchesExpected
        ? "Health Guard x402 recipient must match the existing Health Guard provider wallet."
    : !price.valid
      ? price.reason
      : null;
  if (!recipientValid || !expectedRecipientValid || !recipientMatchesExpected || !price.valid) {
    return { seller: null, status: x402Status({ recipient, priceUsd: price.value, resourceUrl, env, reason }) };
  }
  const cfg = {
    stack: { protocols: ["A2A", "X402"] },
    network: { default: REFERENCE_NETWORK },
    payments: {
      b402_seller: {
        enabled: true,
        price_usd: price.value,
        assets: ["U"],
        pay_to: "",
        work_timeout_seconds: 60,
      },
    },
  };
  const seller = await B402Seller.create({
    cfg,
    networkName: REFERENCE_NETWORK,
    walletAddress: recipient,
    resourceUrl,
    env,
    runWork: healthFactorX402Work,
  });
  return {
    seller,
    status: x402Status({ seller, recipient, priceUsd: price.value, resourceUrl, env, reason: credentials.configured ? null : undefined }),
  };
}
