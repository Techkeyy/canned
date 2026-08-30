import { contentHashes, nowIso, safeUrl } from "../core.mjs";
import { CATEGORIES, CATEGORY_LABELS } from "../domain.mjs";

/**
 * Developer-supplied listing data.
 *
 * The hard rule: a developer describes their agent, and Canned decides what it
 * has proven. Every field below is presentation. Nothing here can move an agent
 * up the trust ladder, and the writable allowlist is enforced rather than
 * documented, so a crafted payload cannot smuggle in evidence fields.
 */
export const LISTING_WRITABLE_FIELDS = Object.freeze([
  "displayName",
  "description",
  "claimedCategory",
  "capabilityStatement",
  "documentationUrl",
  "avatarUrl",
  "developerName",
  "developerUrl",
  "contactUrl",
]);

/** Fields a developer must never be able to set. Presence is rejected outright. */
export const LISTING_FORBIDDEN_FIELDS = Object.freeze([
  "trust", "trustLevel", "status", "verified", "benchmarked", "benchmarkCount", "benchmarkScore",
  "deliveries", "deliveriesObserved", "observedDeliveries", "successRate", "wins", "losses",
  "price", "advertisedPrice", "quote", "jobs", "hireAttempts", "repeatedlyObserved",
  "lastTested", "evidence", "runHistory", "agentAdvantage", "qualityScore", "origin", "reference",
]);

export const LISTING_STATES = Object.freeze({
  DISCOVERED: "DISCOVERED",
  UNCLAIMED: "UNCLAIMED",
  CLAIMED: "CLAIMED",
});

export const MAX_LENGTHS = Object.freeze({ displayName: 60, description: 400, capabilityStatement: 400, developerName: 60 });

/**
 * Strip anything that could execute or mislead when rendered. Metadata comes
 * from strangers, so it is treated as hostile: control characters removed,
 * markup neutralised, length capped.
 */
export function sanitizeText(value, maxLength = 400) {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Only absolute http(s) URLs on a public host are accepted. This is the same
 * boundary the endpoint prober uses: a listing must not become a way to point
 * Canned at a private address.
 */
export function sanitizeUrl(value) {
  if (!value) return null;
  const parsed = safeUrl(String(value));
  if (!parsed) return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (isPrivateHost(parsed.hostname)) return null;
  return parsed.toString();
}

/**
 * Hostnames that must never be fetched or linked from listing metadata.
 * Blocking these is what stops "List your agent" becoming an SSRF tool.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "[::1]") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;              // link local, includes cloud metadata
  if (/^(fc|fd)[0-9a-f]{2}:/.test(host)) return true;     // unique local IPv6
  if (/^fe80:/.test(host)) return true;                   // link local IPv6
  if (!host.includes(".") && !host.includes(":")) return true; // bare hostname, not public
  return false;
}

export function validateListingSubmission(input = {}) {
  const errors = [];
  const forbidden = LISTING_FORBIDDEN_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (forbidden.length) errors.push(`fields_owned_by_canned_evidence:${forbidden.join(",")}`);

  const category = input.claimedCategory ? String(input.claimedCategory) : null;
  if (category && !Object.values(CATEGORIES).includes(category)) errors.push("unknown_category");

  const documentationUrl = input.documentationUrl ? sanitizeUrl(input.documentationUrl) : null;
  if (input.documentationUrl && !documentationUrl) errors.push("documentation_url_rejected");
  const avatarUrl = input.avatarUrl ? sanitizeUrl(input.avatarUrl) : null;
  if (input.avatarUrl && !avatarUrl) errors.push("avatar_url_rejected");
  const developerUrl = input.developerUrl ? sanitizeUrl(input.developerUrl) : null;
  if (input.developerUrl && !developerUrl) errors.push("developer_url_rejected");
  const contactUrl = input.contactUrl ? sanitizeUrl(input.contactUrl) : null;
  if (input.contactUrl && !contactUrl) errors.push("contact_url_rejected");

  const listing = {
    displayName: sanitizeText(input.displayName, MAX_LENGTHS.displayName),
    description: sanitizeText(input.description, MAX_LENGTHS.description),
    claimedCategory: category && Object.values(CATEGORIES).includes(category) ? category : null,
    capabilityStatement: sanitizeText(input.capabilityStatement, MAX_LENGTHS.capabilityStatement),
    documentationUrl,
    avatarUrl,
    developerName: sanitizeText(input.developerName, MAX_LENGTHS.developerName),
    developerUrl,
    contactUrl,
  };
  return { valid: errors.length === 0, errors, listing };
}

/**
 * Build the stored listing. Ownership must already be verified; this function
 * refuses to record a claim on an unverified proof.
 */
export function createListing({ identity, submission, ownership, discoveredAt = null, now = nowIso() }) {
  if (!identity) throw new Error("A listing requires an agent identity.");
  const validation = validateListingSubmission(submission || {});
  if (!validation.valid) throw new Error(`Listing rejected: ${validation.errors.join(", ")}`);
  if (!ownership?.owner) throw new Error("A listing requires a verified ownership proof.");

  const record = {
    entity: "AgentListing",
    schemaVersion: 1,
    identity,
    state: LISTING_STATES.CLAIMED,
    claimedBy: ownership.owner,
    ownershipProof: ownership,
    listing: validation.listing,
    discoveredAt,
    claimedAt: now,
    updatedAt: now,
    // Stated by the owner, never treated as evidence of capability.
    claimedCategoryIsUnverified: true,
    note: "Developer-supplied presentation only. Trust level, deliveries, benchmarks, prices, and track record are derived by Canned from observed evidence.",
  };
  return { ...record, hashes: contentHashes(record) };
}

export function updateListing({ existing, submission, ownership, now = nowIso() }) {
  if (!existing) throw new Error("No listing to update.");
  if (!ownership?.owner || String(ownership.owner).toLowerCase() !== String(existing.claimedBy).toLowerCase()) {
    throw new Error("Only the verified owner may update this listing.");
  }
  const validation = validateListingSubmission(submission || {});
  if (!validation.valid) throw new Error(`Listing rejected: ${validation.errors.join(", ")}`);
  const record = { ...existing, listing: { ...existing.listing, ...validation.listing }, ownershipProof: ownership, updatedAt: now };
  delete record.hashes;
  return { ...record, hashes: contentHashes(record) };
}

/**
 * Merge a listing onto a discovered candidate for presentation.
 *
 * The listing may replace how the agent describes itself. It may not touch
 * anything Canned observed, so the merge deliberately copies only the
 * presentation fields and records the claim as a claim.
 */
export function applyListing(candidate, listing) {
  if (!listing) {
    return { ...candidate, listingState: candidate?.probes?.length ? LISTING_STATES.DISCOVERED : LISTING_STATES.DISCOVERED, claimed: false, claimedBy: null, ownerListing: null };
  }
  const supplied = listing.listing || {};
  return {
    ...candidate,
    name: supplied.displayName || candidate.name,
    description: supplied.description || candidate.description,
    listingState: listing.state,
    claimed: listing.state === LISTING_STATES.CLAIMED,
    claimedBy: listing.claimedBy || null,
    claimedAt: listing.claimedAt || null,
    ownerListing: {
      displayName: supplied.displayName || null,
      description: supplied.description || null,
      capabilityStatement: supplied.capabilityStatement || null,
      documentationUrl: supplied.documentationUrl || null,
      avatarUrl: supplied.avatarUrl || null,
      developerName: supplied.developerName || null,
      developerUrl: supplied.developerUrl || null,
      contactUrl: supplied.contactUrl || null,
      claimedCategory: supplied.claimedCategory || null,
      claimedCategoryLabel: supplied.claimedCategory ? CATEGORY_LABELS[supplied.claimedCategory] : null,
      claimedCategoryIsUnverified: true,
    },
  };
}

export function listingStateFor(candidate, listing) {
  if (listing?.state === LISTING_STATES.CLAIMED) return LISTING_STATES.CLAIMED;
  if (candidate?.origin === "CANNED_REFERENCE") return LISTING_STATES.CLAIMED;
  return LISTING_STATES.UNCLAIMED;
}
