/**
 * BNB eligibility for the public marketplace.
 *
 * Canned is a BNB Chain agent marketplace, so an agent from an unrelated
 * network must not appear in the primary shelves. Eligibility is mechanical:
 * it reads the chain and registry an identity actually resolves to. It is never
 * inferred from a name, a description, or an owner's claim.
 */
export const BNB_CHAIN_IDS = Object.freeze({ mainnet: 56, testnet: 97 });

export const ELIGIBILITY = Object.freeze({
  ELIGIBLE: "BNB_ELIGIBLE",
  UNVERIFIED: "BNB_ELIGIBILITY_UNVERIFIED",
  INELIGIBLE: "NOT_BNB_ELIGIBLE",
});

/** The ERC-8004 registry Canned resolves identities against on BNB Chain. */
export const KNOWN_BNB_REGISTRIES = Object.freeze([
  "0x8004a818bfb912233c491871b3d84c89a494bd9e",
]);

/**
 * Historical marker retained so old evidence can be interpreted. ADR-065
 * resolved the final-judging ambiguity from BNB Chain Support, so new
 * eligibility assessments do not emit this marker.
 */
export const TESTNET_CONFIRMATION_FLAG = "FINAL_BNB_ELIGIBILITY_CONFIRMATION_REQUIRED";

function parseCanonicalIdentity(identity) {
  const parts = String(identity || "").split(":");
  if (parts.length !== 3) return null;
  const chainId = Number(parts[0]);
  if (!Number.isInteger(chainId)) return null;
  return { chainId, registry: String(parts[1]).toLowerCase(), tokenId: parts[2] };
}

/**
 * Decide eligibility from what the record actually proves.
 *
 * A missing chain is unverified, not ineligible: Canned has not looked, which
 * is a different statement from having looked and found the wrong chain.
 */
export function assessBnbEligibility(candidate = {}) {
  const parsed = parseCanonicalIdentity(candidate.identity);
  const chainId = Number.isInteger(Number(candidate.chainId)) ? Number(candidate.chainId) : parsed?.chainId ?? null;
  const registry = (parsed?.registry || String(candidate.erc8004?.registry || "").toLowerCase() || null);
  const reasons = [];

  if (chainId === null) {
    return { status: ELIGIBILITY.UNVERIFIED, chainId: null, network: null, registry, reasons: ["chain_not_resolved"], confirmationRequired: null, eligibleForPublicShelf: false };
  }
  const isBnb = chainId === BNB_CHAIN_IDS.mainnet || chainId === BNB_CHAIN_IDS.testnet;
  if (!isBnb) {
    return { status: ELIGIBILITY.INELIGIBLE, chainId, network: candidate.network || null, registry, reasons: [`chain_${chainId}_is_not_bnb`], confirmationRequired: null, eligibleForPublicShelf: false };
  }
  if (registry && !KNOWN_BNB_REGISTRIES.includes(registry)) reasons.push("registry_not_recognised");

  const network = chainId === BNB_CHAIN_IDS.mainnet ? "bsc-mainnet" : "bsc-testnet";
  const status = reasons.length ? ELIGIBILITY.UNVERIFIED : ELIGIBILITY.ELIGIBLE;
  return {
    status,
    chainId,
    network,
    registry,
    reasons,
    // Testnet is eligible for the shelf. The former final-judging ambiguity
    // is resolved by ADR-065; keep the field for schema compatibility, but do
    // not carry the historical confirmation flag into new evidence.
    confirmationRequired: null,
    eligibleForPublicShelf: status === ELIGIBILITY.ELIGIBLE,
  };
}

export function isPubliclyListable(candidate) {
  return assessBnbEligibility(candidate).eligibleForPublicShelf === true;
}

/** Split a candidate set into what the public shelf may show and what it may not. */
export function partitionByEligibility(candidates = []) {
  const eligible = [];
  const unverified = [];
  const ineligible = [];
  for (const candidate of candidates) {
    const assessment = assessBnbEligibility(candidate);
    const entry = { candidate, eligibility: assessment };
    if (assessment.status === ELIGIBILITY.ELIGIBLE) eligible.push(entry);
    else if (assessment.status === ELIGIBILITY.UNVERIFIED) unverified.push(entry);
    else ineligible.push(entry);
  }
  return { eligible, unverified, ineligible, counts: { eligible: eligible.length, unverified: unverified.length, ineligible: ineligible.length } };
}
