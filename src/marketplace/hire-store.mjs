import { randomUUID } from "node:crypto";
import { nowIso } from "../core.mjs";

export const QUOTE_TTL_SECONDS = 600;
export const MAX_TASK_CHARS = 2000;

const QUOTES_PATH = "state/hire-quotes.json";
const HIRES_PATH = "state/hire-jobs.json";
const LOCKS = new Map();

/**
 * Durable public-hire state.
 *
 * Payment-critical quote state lives in the FileStore, not in process
 * memory, so a restart cannot orphan a submitted transaction: every receipt
 * the server ever accepted is reconciled against these records.
 */

async function loadDoc(store, relativePath) {
  return (await store.loadJson(relativePath, { version: 1, records: {} })).records || {};
}

async function saveDoc(store, relativePath, records) {
  await store.saveJson(relativePath, { version: 1, kind: relativePath.includes("quote") ? "canned_hire_quotes" : "canned_hire_jobs", updatedAt: nowIso(), records });
}

export function newQuoteId() {
  return `quote_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function newHireId() {
  return `hire_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function quoteExpired(record, nowSeconds = Math.floor(Date.now() / 1000)) {
  return Number(record?.expiresAt || 0) <= nowSeconds;
}

export async function loadQuotes(store) {
  return loadDoc(store, QUOTES_PATH);
}

export async function saveQuotes(store, records) {
  return saveDoc(store, QUOTES_PATH, records);
}

export async function loadHires(store) {
  return loadDoc(store, HIRES_PATH);
}

export async function saveHires(store, hires) {
  return saveDoc(store, HIRES_PATH, hires);
}

export async function getQuote(store, quoteId) {
  const quotes = await loadQuotes(store);
  return quotes[quoteId] || null;
}

export async function putQuote(store, record) {
  const quotes = await loadQuotes(store);
  quotes[record.quoteId] = record;
  await saveQuotes(store, quotes);
  return record;
}

/** Atomic compare-and-set on quote status. Returns the updated record or null. */
export async function transitionQuote(store, quoteId, from, to, extra = {}) {
  const quotes = await loadQuotes(store);
  const current = quotes[quoteId];
  if (!current) return null;
  const allowed = Array.isArray(from) ? from : [from];
  if (!allowed.includes(current.status)) return null;
  quotes[quoteId] = { ...current, ...extra, status: to, updatedAt: nowIso() };
  await saveQuotes(store, quotes);
  return quotes[quoteId];
}

export async function getHire(store, hireId) {
  const hires = await loadHires(store);
  return hires[hireId] || null;
}

export async function putHire(store, record) {
  const hires = await loadHires(store);
  hires[record.hireId] = record;
  await saveHires(store, hires);
  return record;
}

export async function findHireByIdempotency(store, idempotencyKey) {
  const hires = await loadHires(store);
  return Object.values(hires).find((hire) => hire.idempotencyKey === idempotencyKey) || null;
}

export async function findHireByQuote(store, quoteId) {
  const hires = await loadHires(store);
  return Object.values(hires).find((hire) => hire.quoteId === quoteId) || null;
}

export async function findHireByTx(store, txHash) {
  const needle = String(txHash).toLowerCase();
  const hires = await loadHires(store);
  return (
    Object.values(hires).find((hire) =>
      Object.values(hire.transactions || {}).some((entry) => String(entry?.txHash || "").toLowerCase() === needle),
    ) || null
  );
}

/** Serialize payment-critical operations within this server process. */
export async function withHireLock(key, fn) {
  const lockKey = String(key);
  const previous = LOCKS.get(lockKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  LOCKS.set(lockKey, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (LOCKS.get(lockKey) === current) LOCKS.delete(lockKey);
  }
}

export async function hiresForBuyer(store, buyer) {
  const hires = await loadHires(store);
  const needle = String(buyer).toLowerCase();
  return Object.values(hires)
    .filter((hire) => String(hire.buyer || "").toLowerCase() === needle)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return { ok: false, reason: "Task must be a JSON object." };
  const description = String(task.description || "").trim().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  if (!description) return { ok: false, reason: "Describe the task you want the agent to perform." };
  if (description.length > MAX_TASK_CHARS) return { ok: false, reason: `Task description must fit within ${MAX_TASK_CHARS} characters.` };
  return { ok: true, description };
}
