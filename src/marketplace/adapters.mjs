import { RUN_TYPES } from "../domain.mjs";

export const PROTOCOLS = Object.freeze({
  ERC8183: "ERC-8183",
  X402: "x402",
  B402: "B402",
  A2A: "A2A",
  HTTP_TASK_API: "HTTP task API",
  MCP: "MCP",
});

export const ADAPTER_CATALOG = Object.freeze({
  [PROTOCOLS.ERC8183]: { kind: "payment_and_job", implemented: true, writeCapable: true, network: "bsc-testnet" },
  [PROTOCOLS.X402]: { kind: "per_request_payment", implemented: false, writeCapable: false, network: "bsc-testnet" },
  [PROTOCOLS.B402]: { kind: "per_request_payment", implemented: false, writeCapable: false, network: "bsc-testnet" },
  [PROTOCOLS.A2A]: { kind: "invocation", implemented: true, writeCapable: false, network: "bsc-testnet" },
  [PROTOCOLS.HTTP_TASK_API]: { kind: "invocation", implemented: false, writeCapable: false, network: "bsc-testnet" },
  [PROTOCOLS.MCP]: { kind: "invocation", implemented: false, writeCapable: false, network: "bsc-testnet" },
});

const advertised = (candidate, protocol) => {
  const supports = candidate?.supports || {};
  if (protocol === PROTOCOLS.ERC8183) return supports.erc8183 === true;
  if (protocol === PROTOCOLS.X402) return supports.x402 === true;
  if (protocol === PROTOCOLS.B402) return supports.b402 === true;
  if (protocol === PROTOCOLS.A2A) return supports.a2a === true || candidate?.services?.some((item) => /a2a/i.test(item.type || ""));
  if (protocol === PROTOCOLS.HTTP_TASK_API) return supports.httpTaskApi === true || candidate?.services?.some((item) => /http|rest|api|task/i.test(`${item.type || ""} ${item.description || ""}`));
  if (protocol === PROTOCOLS.MCP) return supports.mcp === true || candidate?.services?.some((item) => /mcp/i.test(item.type || ""));
  return false;
};

function hasRunForAgent(run, identity) {
  return run?.agent?.identity === identity && run?.runType !== RUN_TYPES.FIXTURE && run?.runType !== RUN_TYPES.INFRASTRUCTURE_PROTOCOL_CONTROL;
}

function wasSuccessfullyUsed(run, protocol) {
  if (protocol === PROTOCOLS.ERC8183) return Boolean(run?.protocolJob?.jobId !== undefined && run?.protocolJob?.jobId !== null && run?.protocolJob?.funded === true);
  return false;
}

function verifiedForCandidate(candidate, protocol) {
  if (protocol === PROTOCOLS.ERC8183) return candidate?.selectionGate?.readiness?.protocolCompatibility === true;
  if (protocol === PROTOCOLS.A2A) return candidate?.probes?.some((probe) => probe.callable === true && /a2a/i.test(probe.type || "")) === true;
  return false;
}

export function protocolCapabilities(candidate, runs = []) {
  return Object.entries(PROTOCOLS).map(([, protocol]) => {
    const candidateRuns = runs.filter((run) => hasRunForAgent(run, candidate?.identity));
    const used = candidateRuns.some((run) => wasSuccessfullyUsed(run, protocol));
    const entry = ADAPTER_CATALOG[protocol];
    const lastProbeAt = candidate?.probes?.filter((probe) => {
      if (protocol === PROTOCOLS.A2A) return /a2a/i.test(probe.type || "");
      if (protocol === PROTOCOLS.MCP) return /mcp/i.test(probe.type || "");
      if (protocol === PROTOCOLS.X402) return /x402/i.test(probe.type || "");
      if (protocol === PROTOCOLS.B402) return /b402/i.test(probe.type || "");
      return false;
    }).sort((left, right) => Date.parse(right.observedAt || "") - Date.parse(left.observedAt || ""))[0]?.observedAt || null;
    return {
      protocol,
      advertised: advertised(candidate, protocol),
      cannedVerified: verifiedForCandidate(candidate, protocol),
      successfullyUsed: used,
      lastProbeAt,
      implemented: entry.implemented,
      writeCapable: entry.writeCapable,
      activationStatus: used ? "successfully_used" : verifiedForCandidate(candidate, protocol) ? "canned_verified" : advertised(candidate, protocol) ? "advertised_only" : "not_observed",
      note: protocol === PROTOCOLS.ERC8183 && candidate?.selectionGate?.readiness?.ready !== true && advertised(candidate, protocol)
        ? "ERC-8183 metadata or compatibility was observed, but a fresh quote and all hire guards are not currently passing."
        : null,
    };
  }).filter((item) => item.advertised || item.cannedVerified || item.successfullyUsed);
}

export function isWeighFamily(identity) {
  return new Set(["1923", "1925", "1926"].map((tokenId) => `97:0x8004a818bfb912233c491871b3d84c89a494bd9e:${tokenId}`)).has(String(identity));
}

export function selectHiringAdapter(candidate, { chainId = 97, allowQuarantined = false } = {}) {
  if (!candidate) return { status: "blocked", reason: "Agent was not found." };
  if (chainId !== 97 || candidate.chainId !== 97 || candidate.network !== "bsc-testnet") {
    return { status: "blocked", reason: "Canned hiring is restricted to BSC testnet (chain ID 97)." };
  }
  if (isWeighFamily(candidate.identity) && !allowQuarantined) {
    return { status: "blocked", reason: "This implementation family is quarantined from new paid attempts while delivery evidence is unresolved." };
  }
  const readyErc8183 = candidate.selectionGate?.readiness?.ready === true && candidate.selectionGate?.readiness?.quoteVerified === true && candidate.selectionGate?.readiness?.protocolCompatibility === true;
  if (candidate.supports?.erc8183 === true && readyErc8183) {
    return { status: "ready", protocol: PROTOCOLS.ERC8183, adapter: "erc8183-buyer", price: candidate.hiring?.price || null, currency: candidate.hiring?.currency || null, network: "bsc-testnet", semantics: "fresh signed quote, bounded ERC-20 escrow, provider delivery deadline" };
  }
  if (candidate.supports?.x402 === true) return { status: "blocked", protocol: PROTOCOLS.X402, reason: "x402 is advertised, but a Canned-verified x402 payment adapter is not implemented for this candidate." };
  if (candidate.supports?.b402 === true) return { status: "blocked", protocol: PROTOCOLS.B402, reason: "B402 is advertised, but a Canned-verified B402 payment adapter is not implemented for this candidate." };
  return { status: "blocked", reason: "No verified safe activation path is available for this agent." };
}

export function activationReview(candidate, { runs = [], chainId = 97 } = {}) {
  const capabilities = protocolCapabilities(candidate, runs);
  const selection = selectHiringAdapter(candidate, { chainId });
  return {
    chainId,
    network: "bsc-testnet",
    capabilities,
    selection,
    userConfirmationRequired: true,
    privateKeyInBrowser: false,
    aggregateExternalBudget: "1.0 U maximum for this directive",
  };
}
