import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { keccak256, stringToHex } from "viem";
import { assertPublicUrl } from "./net/egress-guard.mjs";

const localEnvPath = path.resolve(process.cwd(), ".env.local");
if (existsSync(localEnvPath)) {
  try { loadEnvFile(localEnvPath); } catch { /* malformed local secrets are reported by the caller */ }
}

export function canonicalize(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain a non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => {
          const child = value[key];
          return [key, canonicalize(child)];
        }),
    );
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function contentHashes(valueOrText) {
  const text = typeof valueOrText === "string" ? valueOrText : canonicalJson(valueOrText);
  return {
    canonicalJson: text,
    sha256: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
    keccak256: keccak256(stringToHex(text)),
  };
}

export function nowIso() {
  return new Date().toISOString();
}

export function id(prefix = "id") {
  return `${prefix}_${randomUUID()}`;
}

export function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return url;
  } catch {
    return false;
  }
}

/**
 * Whether a URL is safe to hand to the network.
 *
 * The rule lives in the egress guard so there is exactly one blocklist. The
 * earlier local copy missed link-local addresses, which is where cloud
 * instance metadata answers, and it is not repeated here.
 *
 * This is the literal-form check only. Anything actually fetched from a
 * stranger-supplied URL must go through `safeFetch`, which also resolves the
 * name and pins the connection.
 */
export function isPublicHttpUrl(value) {
  return assertPublicUrl(value).ok;
}

export async function requestJson(url, { method = "GET", body, headers = {}, timeoutMs = 12_000, fetchImpl = globalThis.fetch } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: { Accept: "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text.length ? JSON.parse(text) : null; } catch { /* keep raw text for evidence */ }
    return {
      ok: response.ok,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: json,
      rawText: text,
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      headers: {},
      body: null,
      rawText: "",
      elapsedMs: Date.now() - started,
      error: error?.name === "AbortError" ? "timeout" : error?.message || String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function short(value, keep = 10) {
  if (typeof value !== "string" || value.length <= keep * 2 + 3) return value;
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

export function asNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

export function safeError(error) {
  return error?.message ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500) : String(error).slice(0, 500);
}
