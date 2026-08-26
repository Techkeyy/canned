import { id, requestJson, safeError, contentHashes } from "../core.mjs";

function endpointBase(endpoint, card) {
  if (card?.url) return card.url;
  const url = new URL(endpoint);
  if (url.pathname.endsWith("/agent-card.json")) url.pathname = url.pathname.replace(/\/\.well-known\/agent-card\.json$/, "");
  return url.toString().replace(/\/$/, "");
}

export async function negotiateA2A({ endpoint, card, taskDescription, deliverables, qualityStandards, timeoutMs = 20_000, fetchImpl = globalThis.fetch }) {
  const base = endpointBase(endpoint, card);
  const requestId = id("a2a");
  const payload = {
    jsonrpc: "2.0",
    id: requestId,
    method: "message/send",
    params: {
      message: {
        messageId: requestId,
        role: "user",
        parts: [{ kind: "data", data: { skill: "negotiate", task_description: taskDescription, terms: { deliverables, quality_standards: qualityStandards } } }],
      },
    },
  };
  const response = await requestJson(base, {
    method: "POST",
    body: payload,
    headers: { "Content-Type": "application/json" },
    timeoutMs,
    fetchImpl,
  });
  if (!response.ok || !response.body) {
    return { ok: false, endpoint: base, requestId, error: response.error || `HTTP ${response.status}`, response, requestHash: contentHashes(payload).keccak256 };
  }
  const dataPart = response.body?.result?.parts?.find((part) => part.kind === "data")?.data || null;
  const quote = dataPart?.response || null;
  return {
    ok: Boolean(quote),
    endpoint: base,
    requestId,
    accepted: quote?.accepted === true,
    quote,
    negotiationHash: dataPart?.negotiation_hash || null,
    providerSignature: dataPart?.provider_sig || null,
    requestHash: dataPart?.request_hash || contentHashes(payload).keccak256,
    responseHash: dataPart?.response_hash || contentHashes(response.rawText).keccak256,
    rawResponse: response.body,
    elapsedMs: response.elapsedMs,
    error: quote ? null : "A2A response did not contain a quote data part",
  };
}

export async function notifyFundedA2A({ endpoint, card, jobId, timeoutMs = 20_000, fetchImpl = globalThis.fetch }) {
  const base = endpointBase(endpoint, card);
  const requestId = id("a2a");
  const payload = {
    jsonrpc: "2.0",
    id: requestId,
    method: "message/send",
    params: {
      message: {
        messageId: requestId,
        role: "user",
        parts: [{ kind: "data", data: { skill: "notify_funded", job_id: Number(jobId) } }],
      },
    },
  };
  const response = await requestJson(base, { method: "POST", body: payload, headers: { "Content-Type": "application/json" }, timeoutMs, fetchImpl });
  return { ok: response.ok, endpoint: base, jobId: Number(jobId), response: response.body, rawResponse: response.rawText, error: response.ok ? null : response.error || `HTTP ${response.status}` };
}
