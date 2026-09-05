import { contentHashes, isObject } from "../core.mjs";

function parseJsonIfPossible(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function extractProviderDeliverable(body) {
  const manifest = isObject(body) ? body : null;
  const content = manifest?.response?.content;
  const output = content !== undefined ? parseJsonIfPossible(content) : manifest?.output ?? manifest?.result ?? manifest;
  return { manifest, content, output };
}

export function validateSubmittedDeliverable({ body, jobId, onchainDeliverable = null, expectedOutputFields = [] } = {}) {
  const { manifest, content, output } = extractProviderDeliverable(body);
  const errors = [];
  if (!manifest) errors.push("deliverable_not_an_object");
  const manifestJobId = manifest?.jobId ?? manifest?.job_id;
  if (manifest && manifestJobId === undefined) errors.push("deliverable_job_id_missing");
  if (manifest && manifestJobId !== undefined && Number(manifestJobId) !== Number(jobId)) errors.push("deliverable_job_id_mismatch");
  if (typeof content !== "string" || content.length === 0) errors.push("deliverable_response_content_missing");
  if (manifest?.response?.contentType && manifest.response.contentType !== "text/plain") errors.push("deliverable_content_type_unexpected");
  if (onchainDeliverable && manifest) {
    const computed = contentHashes(manifest).keccak256;
    if (computed.toLowerCase() !== String(onchainDeliverable).toLowerCase()) errors.push("deliverable_manifest_hash_mismatch");
  }
  if (expectedOutputFields.length > 0 && !isObject(output)) {
    errors.push("deliverable_output_not_json_object");
  } else if (isObject(output)) {
    for (const field of expectedOutputFields) {
      if (output[field] === undefined || output[field] === null) errors.push(`missing_output_field:${field}`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    hasActualDeliverable: errors.length === 0 && Boolean(content),
    manifestHash: manifest ? contentHashes(manifest).keccak256 : null,
    output,
  };
}
