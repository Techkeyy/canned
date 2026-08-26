const DEFAULT_WEIGH_IDS = Object.freeze(["1923", "1925", "1926"]);

function firstCard(candidate) {
  return candidate?.probes?.find((probe) => probe?.card)?.card || null;
}

function endpoints(candidate) {
  return [
    ...(candidate?.services || []).map((service) => service?.endpoint),
    ...(candidate?.probes || []).map((probe) => probe?.endpoint),
  ].filter(Boolean);
}

function hostOf(endpoint) {
  try { return new URL(endpoint).hostname.toLowerCase(); } catch { return null; }
}

function cardFingerprint(card) {
  if (!card) return null;
  return {
    protocolVersion: card.protocolVersion || null,
    skills: Array.isArray(card.skills) ? card.skills.map((skill) => ({ id: skill?.id || null, inputModes: skill?.inputModes || null, outputModes: skill?.outputModes || null })).sort((a, b) => String(a.id).localeCompare(String(b.id))) : [],
    capabilityKeys: card.capabilities && typeof card.capabilities === "object" ? Object.keys(card.capabilities).sort() : [],
    topLevelKeys: Object.keys(card).sort(),
  };
}

function quoteFingerprint(candidate) {
  const quote = candidate?.hiring?.negotiationProbe?.quote || null;
  if (!quote) return null;
  return {
    price: quote.price ?? null,
    currency: quote.currency ?? null,
    estimatedCompletionSeconds: quote.estimatedCompletionSeconds ?? null,
    keys: Object.keys(quote).sort(),
  };
}

function identityParts(identity) {
  const match = String(identity || "").match(/^([^:]+):(.+):(\d+)$/);
  return match ? { namespace: match[1], registry: match[2], tokenId: match[3] } : { namespace: null, registry: null, tokenId: null };
}

export function correlateAgentFamily(candidates = [], { ids = DEFAULT_WEIGH_IDS } = {}) {
  const selected = ids.map((id) => candidates.find((candidate) => String(candidate?.tokenId) === String(id) || String(candidate?.identity || "").endsWith(`:${id}`))).filter(Boolean);
  const records = selected.map((candidate) => {
    const card = firstCard(candidate);
    const identity = identityParts(candidate.identity);
    const candidateEndpoints = endpoints(candidate);
    return {
      tokenId: String(candidate.tokenId || identity.tokenId),
      name: candidate.name || null,
      identity: candidate.identity || null,
      provider: candidate.agentWallet || candidate.ownerAddress || null,
      endpointHosts: [...new Set(candidateEndpoints.map(hostOf).filter(Boolean))].sort(),
      endpoints: candidateEndpoints,
      card: cardFingerprint(card),
      quote: quoteFingerprint(candidate),
      categoryHypotheses: (candidate.categoryHypotheses || []).map((item) => item.category).filter(Boolean),
      registry: identity.registry,
      registrationTokenId: identity.tokenId,
      sourceReferences: [candidate.source?.detailUrl, candidate.source?.offchainUri].filter(Boolean),
      probeStatuses: (candidate.probes || []).map((probe) => probe.status).filter(Boolean),
    };
  });
  const hosts = [...new Set(records.flatMap((record) => record.endpointHosts))];
  const protocolVersions = [...new Set(records.map((record) => record.card?.protocolVersion).filter(Boolean))];
  const skillSets = records.map((record) => (record.card?.skills || []).map((skill) => skill.id).sort());
  const sameSkillSet = skillSets.length > 1 && skillSets.every((skills) => JSON.stringify(skills) === JSON.stringify(skillSets[0]));
  const registries = [...new Set(records.map((record) => record.registry).filter(Boolean))];
  const tokenIds = records.map((record) => Number(record.registrationTokenId)).filter(Number.isFinite).sort((a, b) => a - b);
  const sameRenderInfrastructure = hosts.length > 0 && hosts.every((host) => host.endsWith(".onrender.com"));
  const nearbyRegistrations = tokenIds.length > 1 && tokenIds[tokenIds.length - 1] - tokenIds[0] <= 3;
  const sameQuoteShape = records.length > 1 && records.every((record) => JSON.stringify(record.quote ? Object.keys(record.quote).sort() : null) === JSON.stringify(records[0].quote ? Object.keys(records[0].quote).sort() : null));
  const evidence = {
    sameRenderInfrastructure,
    endpointHosts: hosts,
    sharedProtocolVersions: protocolVersions,
    sameCardSkillSet: sameSkillSet,
    cardSkillSets: skillSets,
    sharedIdentityRegistries: registries,
    nearbyRegistrationIds: tokenIds,
    nearbyRegistrations,
    sameQuoteFieldShape: sameQuoteShape,
    commonSourceRepository: false,
    providerAddressesDiffer: new Set(records.map((record) => String(record.provider || "").toLowerCase()).filter(Boolean)).size === records.length,
  };
  let classification = "UNKNOWN";
  if (records.length === ids.length && sameRenderInfrastructure && sameSkillSet && protocolVersions.length === 1 && registries.length === 1 && nearbyRegistrations) {
    classification = "SAME_IMPLEMENTATION_FAMILY_LIKELY";
  } else if (records.length === ids.length && evidence.providerAddressesDiffer && (!sameRenderInfrastructure || !sameSkillSet)) {
    classification = "INDEPENDENT_IMPLEMENTATIONS";
  }
  return {
    schemaVersion: 1,
    kind: "weigh_family_correlation",
    observedAt: new Date().toISOString(),
    classification,
    scope: ids,
    records,
    evidence,
    conclusion: classification === "SAME_IMPLEMENTATION_FAMILY_LIKELY"
      ? "The evidence supports one shared deployment/code family, but does not prove a common operator or source repository. Treat Weigh-family failures as non-independent until a separately implemented control succeeds."
      : "The available metadata does not support a stronger architectural correlation conclusion.",
    limitations: ["No operator attribution or private infrastructure access was attempted.", "Shared hosting and schema are architectural signals, not proof of identical source code.", "No public source/repository reference was observed in the inspected metadata."],
  };
}
