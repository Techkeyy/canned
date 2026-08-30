/**
 * Outbound request guard.
 *
 * Canned fetches URLs that strangers control: agent card endpoints written
 * into the ERC-8004 registry, and deliverable URLs returned by providers. A
 * hostname check alone does not make that safe, because the name a host
 * resolves to can differ from the address a socket actually connects to. This
 * module closes that gap in three steps:
 *
 *   1. reject the URL on its literal form (scheme, obvious private host)
 *   2. resolve every A/AAAA record and reject if any is private
 *   3. connect to a resolved address that was checked, not to the name
 *
 * Step 3 is what defeats DNS rebinding. Checking and then handing the name
 * back to the network stack lets the second lookup return something else.
 *
 * There is one source of truth for "private" here. Anything that needs the
 * rule imports it rather than writing its own, because two copies of a
 * blocklist drift and the weaker one becomes the vulnerability.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export const EGRESS_ERRORS = Object.freeze({
  BAD_URL: "url_not_parseable",
  BAD_SCHEME: "scheme_not_http_or_https",
  PRIVATE_HOST: "host_is_private_or_internal",
  PRIVATE_ADDRESS: "host_resolves_to_a_private_address",
  UNRESOLVABLE: "host_did_not_resolve",
  TOO_MANY_REDIRECTS: "too_many_redirects",
  REDIRECT_BLOCKED: "redirect_target_is_private",
});

/** Redirects are followed by hand so each hop can be revalidated. */
export const MAX_REDIRECTS = 3;

function ipv4Parts(host) {
  if (isIP(host) !== 4) return null;
  const parts = host.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null;
}

/**
 * Whether a literal IP address must never be connected to.
 *
 * Covers the ranges that reach something other than the public internet:
 * loopback, the RFC1918 private space, link-local (which is where cloud
 * instance metadata lives at 169.254.169.254), carrier-grade NAT, and the
 * IPv6 equivalents including addresses that embed an IPv4 one.
 */
export function isPrivateAddress(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;

  const version = isIP(host);
  if (version === 4) {
    const [a, b] = ipv4Parts(host);
    if (a === 0) return true;                      // "this network", and 0.0.0.0
    if (a === 10 || a === 127) return true;        // private, loopback
    if (a === 169 && b === 254) return true;       // link local, includes cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
    if (a >= 224) return true;                     // multicast and reserved
    return false;
  }

  if (version === 6) {
    if (host === "::" || host === "::1") return true;
    // An IPv6 address can carry an IPv4 one: ::ffff:169.254.169.254 reaches
    // the metadata service just as well as the bare form.
    const embedded = host.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (embedded) return isPrivateAddress(embedded[1]);
    if (/^f[cd]/.test(host)) return true;          // unique local fc00::/7
    if (/^fe[89ab]/.test(host)) return true;       // link local fe80::/10
    if (/^ff/.test(host)) return true;             // multicast
    return false;
  }

  return true; // not an IP literal: the caller should have used the host rule
}

/**
 * Whether a hostname must be refused before any lookup happens.
 *
 * This is the cheap first pass. It cannot see what a name resolves to, so it
 * is never the only check for something that will actually be fetched.
 */
export function isPrivateHostname(value) {
  const host = String(value || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (isIP(host)) return isPrivateAddress(host);
  if (host === "localhost") return true;
  if (/\.(localhost|local|internal|home|lan|corp|intranet)$/.test(host)) return true;
  // No dot means a name that only resolves inside someone's own network.
  if (!host.includes(".")) return true;
  return false;
}

/** Parse and reject a URL on its literal form alone. */
export function assertPublicUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { return { ok: false, error: EGRESS_ERRORS.BAD_URL }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: EGRESS_ERRORS.BAD_SCHEME };
  if (isPrivateHostname(url.hostname)) return { ok: false, error: EGRESS_ERRORS.PRIVATE_HOST };
  return { ok: true, url };
}

/**
 * Resolve a hostname and return its addresses only if every one of them is
 * public. One private answer rejects the whole name: a host that returns both
 * a public and a private address is exactly the rebinding case.
 */
export async function resolvePublicAddresses(hostname, { resolver = dnsLookup } = {}) {
  if (isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? { ok: false, error: EGRESS_ERRORS.PRIVATE_ADDRESS, addresses: [] }
      : { ok: true, addresses: [{ address: hostname, family: isIP(hostname) }] };
  }
  let answers;
  try {
    answers = await resolver(hostname, { all: true });
  } catch {
    return { ok: false, error: EGRESS_ERRORS.UNRESOLVABLE, addresses: [] };
  }
  const list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean);
  if (!list.length) return { ok: false, error: EGRESS_ERRORS.UNRESOLVABLE, addresses: [] };
  for (const entry of list) {
    if (isPrivateAddress(entry.address)) {
      return { ok: false, error: EGRESS_ERRORS.PRIVATE_ADDRESS, addresses: [], offending: entry.address };
    }
  }
  return { ok: true, addresses: list };
}

/**
 * Full check for one URL: literal form, then resolution.
 *
 * Returns the addresses that passed so the caller can connect to one of them
 * rather than resolving the name a second time.
 */
export async function checkEgressTarget(value, { resolver = dnsLookup } = {}) {
  const parsed = assertPublicUrl(value);
  if (!parsed.ok) return parsed;
  const resolved = await resolvePublicAddresses(parsed.url.hostname, { resolver });
  if (!resolved.ok) return { ok: false, error: resolved.error, url: parsed.url, offending: resolved.offending };
  return { ok: true, url: parsed.url, addresses: resolved.addresses };
}

/**
 * Fetch a stranger-supplied URL with the socket pinned to a checked address.
 *
 * Pinning is done with Node's own `lookup` hook rather than a third-party
 * dispatcher: the request connects to the address the guard approved, while
 * `servername` keeps TLS validation against the real hostname. That is what
 * makes this safe against rebinding, because nothing looks the name up a
 * second time between the check and the connection.
 *
 * Redirects are followed by hand. An automatic redirect is a second request
 * to an address nobody validated.
 */
async function pinnedRequest(url, { pinnedAddress, family, method = "GET", headers = {}, body, timeoutMs = 12_000, maxBytes = 2 * 1024 * 1024 }) {
  const transport = url.protocol === "https:" ? await import("node:https") : await import("node:http");
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        servername: url.protocol === "https:" ? url.hostname : undefined,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: { Host: url.host, Accept: "application/json", ...headers },
        // The address the guard approved. Node connects here instead of
        // resolving the name again. Node asks for either a single address or
        // the full list depending on the caller, so both shapes are answered.
        lookup: (_hostname, options, callback) => {
          const version = family === 6 ? 6 : 4;
          if (options && options.all) callback(null, [{ address: pinnedAddress, family: version }]);
          else callback(null, pinnedAddress, version);
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { request.destroy(new Error("response_too_large")); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: { get: (name) => response.headers[String(name).toLowerCase()] ?? null },
          text: async () => Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    if (body !== undefined) request.write(typeof body === "string" ? body : JSON.stringify(body));
    request.end();
  });
}

export async function safeFetch(value, { resolver = dnsLookup, requestImpl = pinnedRequest, maxRedirects = MAX_REDIRECTS, ...init } = {}) {
  let target = value;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const check = await checkEgressTarget(target, { resolver });
    if (!check.ok) {
      return { ok: false, error: hop === 0 ? check.error : EGRESS_ERRORS.REDIRECT_BLOCKED, url: String(target), offending: check.offending ?? null, hop };
    }

    let response;
    try {
      response = await requestImpl(check.url, { ...init, pinnedAddress: check.addresses[0].address, family: check.addresses[0].family });
    } catch (error) {
      return { ok: false, error: "request_failed", reason: error.message, url: check.url.toString(), hop };
    }

    const status = response?.status ?? 0;
    if (status >= 300 && status < 400) {
      const location = response.headers?.get?.("location");
      if (!location) return { ok: true, response, url: check.url.toString(), hops: hop };
      // A relative Location resolves against the hop it came from, and the
      // next pass revalidates it exactly like the first.
      target = new URL(location, check.url).toString();
      continue;
    }
    return { ok: true, response, url: check.url.toString(), hops: hop };
  }
  return { ok: false, error: EGRESS_ERRORS.TOO_MANY_REDIRECTS, url: String(value) };
}

/**
 * Adapt a fetch-like function into the requestImpl shape.
 *
 * Named for what it costs: a fetch-like cannot pin a socket, so this loses the
 * rebinding protection and exists for test doubles. Production paths pass no
 * requestImpl and get the pinned one.
 */
export function unpinnedRequestImplForTesting(fetchImpl) {
  return async (url, { method = "GET", headers = {}, body, timeoutMs = 12_000 } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        method,
        headers: { Accept: "application/json", ...headers },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, headers: { get: (name) => response.headers?.get?.(name) ?? null }, text: async () => text };
    } catch (error) {
      // An abort here is the timeout firing, and it is reported by that name so
      // callers see the same reason the pinned path gives them.
      throw error?.name === "AbortError" ? new Error("timeout") : error;
    } finally { clearTimeout(timer); }
  };
}

/**
 * Fetch JSON from a stranger-supplied URL, guarded and pinned.
 *
 * Returns the same shape as `requestJson` so a caller can be switched over
 * without reshaping everything downstream. A blocked URL comes back as a
 * normal not-ok result rather than an exception, because being refused is an
 * expected outcome for an address a stranger chose.
 */
export async function safeRequestJson(url, { resolver, requestImpl, timeoutMs = 12_000, ...init } = {}) {
  const started = Date.now();
  const result = await safeFetch(url, { resolver, requestImpl, timeoutMs, ...init });
  if (!result.ok) {
    // Refused by policy and failed in transit are different outcomes. Only the
    // first is the guard saying no; the second is an endpoint that is simply
    // down, which callers report as unreachable rather than as blocked.
    const blocked = result.error !== "request_failed";
    return {
      ok: false, status: 0, body: null, rawText: "",
      elapsedMs: Date.now() - started,
      error: blocked ? result.error : result.reason || result.error,
      blocked, offending: result.offending ?? null,
    };
  }
  const rawText = await result.response.text();
  let body = null;
  try { body = JSON.parse(rawText); } catch { body = null; }
  const status = result.response.status;
  return { ok: status >= 200 && status < 300, status, body, rawText, elapsedMs: Date.now() - started, error: null, blocked: false };
}
