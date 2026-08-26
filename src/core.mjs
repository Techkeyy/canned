import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { keccak256, stringToHex } from "viem";

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

function isPrivateIpv4(hostname) {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

export function isPublicHttpUrl(value) {
  const url = safeUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || isPrivateIpv4(host)) return false;
  return true;
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
