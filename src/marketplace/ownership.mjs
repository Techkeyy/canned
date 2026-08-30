import { randomBytes } from "node:crypto";
import { nowIso } from "../core.mjs";

/**
 * Wallet ownership verification for listing and claiming an agent.
 *
 * Canned never accepts "I own agent 2419". The owner proves control of the
 * address the registry reports by signing a Canned-issued challenge. Canned
 * never sees a private key, a seed phrase, or a wallet password, and never
 * asks for one.
 */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_BYTES = 32;
export const SESSION_TTL_MS = 15 * 60 * 1000;

export const OWNERSHIP_ERRORS = Object.freeze({
  UNKNOWN_CHALLENGE: "unknown_challenge",
  EXPIRED: "challenge_expired",
  ALREADY_USED: "challenge_already_used",
  ADDRESS_MISMATCH: "signer_is_not_the_challenged_address",
  NOT_OWNER: "signer_is_not_the_onchain_owner",
  BAD_SIGNATURE: "signature_did_not_verify",
  IDENTITY_MISMATCH: "challenge_was_issued_for_a_different_identity",
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value) {
  return ADDRESS.test(String(value || ""));
}

/**
 * The exact text the wallet signs. It names the product, the identity, the
 * address, and an expiry, so a signature captured here cannot be replayed
 * against a different agent or a different site.
 */
export function challengeMessage({ identity, address, nonce, issuedAt, expiresAt }) {
  return [
    "Canned agent ownership verification",
    "",
    "Sign this message to prove you control this wallet.",
    "This does not move funds and does not approve any spending.",
    "",
    `Agent: ${identity}`,
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
    `Expires: ${expiresAt}`,
  ].join("\n");
}

export function createChallenge({ identity, address, now = Date.now(), nonce = randomBytes(CHALLENGE_BYTES).toString("hex") } = {}) {
  if (!identity) throw new Error("A challenge requires an agent identity.");
  if (!isAddress(address)) throw new Error("A challenge requires a valid wallet address.");
  const issuedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + CHALLENGE_TTL_MS).toISOString();
  const normalizedAddress = String(address).toLowerCase();
  return {
    nonce,
    identity,
    address: normalizedAddress,
    issuedAt,
    expiresAt,
    consumed: false,
    message: challengeMessage({ identity, address: normalizedAddress, nonce, issuedAt, expiresAt }),
  };
}

export function challengeState(challenge, { now = Date.now() } = {}) {
  if (!challenge) return { valid: false, error: OWNERSHIP_ERRORS.UNKNOWN_CHALLENGE };
  if (challenge.consumed === true) return { valid: false, error: OWNERSHIP_ERRORS.ALREADY_USED };
  if (Date.parse(challenge.expiresAt) <= now) return { valid: false, error: OWNERSHIP_ERRORS.EXPIRED };
  return { valid: true, error: null };
}

/**
 * Verify a signature against a stored challenge and the owner the registry
 * reports. `recoverAddress` is injected so the check is testable without a
 * chain, and `onchainOwner` must come from a registry read, never from input.
 */
export async function verifyOwnership({ challenge, signature, identity, onchainOwner, recoverAddress, now = Date.now() } = {}) {
  const state = challengeState(challenge, { now });
  if (!state.valid) return { verified: false, error: state.error };
  if (identity && challenge.identity !== identity) return { verified: false, error: OWNERSHIP_ERRORS.IDENTITY_MISMATCH };
  if (typeof recoverAddress !== "function") throw new Error("Ownership verification requires an address recovery function.");

  let signer = null;
  try {
    signer = await recoverAddress({ message: challenge.message, signature });
  } catch {
    return { verified: false, error: OWNERSHIP_ERRORS.BAD_SIGNATURE };
  }
  if (!isAddress(signer)) return { verified: false, error: OWNERSHIP_ERRORS.BAD_SIGNATURE };
  const recovered = String(signer).toLowerCase();
  if (recovered !== challenge.address) return { verified: false, error: OWNERSHIP_ERRORS.ADDRESS_MISMATCH, signer: recovered };
  if (!isAddress(onchainOwner)) return { verified: false, error: OWNERSHIP_ERRORS.NOT_OWNER, signer: recovered };
  if (recovered !== String(onchainOwner).toLowerCase()) return { verified: false, error: OWNERSHIP_ERRORS.NOT_OWNER, signer: recovered, onchainOwner: String(onchainOwner).toLowerCase() };

  return {
    verified: true,
    error: null,
    signer: recovered,
    identity: challenge.identity,
    onchainOwner: String(onchainOwner).toLowerCase(),
    verifiedAt: new Date(now).toISOString(),
    sessionExpiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    method: "wallet_signature_matched_onchain_owner",
  };
}

/** A challenge is single use. Consuming it is what prevents replay. */
export function consumeChallenge(challenge, { now = Date.now() } = {}) {
  return { ...challenge, consumed: true, consumedAt: new Date(now).toISOString() };
}

export function pruneChallenges(challenges = {}, { now = Date.now() } = {}) {
  return Object.fromEntries(Object.entries(challenges).filter(([, challenge]) => Date.parse(challenge.expiresAt) > now && challenge.consumed !== true));
}

export function verifiedSessionActive(session, { now = Date.now() } = {}) {
  return Boolean(session?.verified === true && session.sessionExpiresAt && Date.parse(session.sessionExpiresAt) > now);
}

export function ownershipRecord({ verification, identity }) {
  if (!verification?.verified) return null;
  return {
    entity: "AgentOwnershipProof",
    identity: identity || verification.identity,
    owner: verification.onchainOwner,
    signer: verification.signer,
    method: verification.method,
    verifiedAt: verification.verifiedAt || nowIso(),
  };
}
