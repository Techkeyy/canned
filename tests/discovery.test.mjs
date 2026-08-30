import test from "node:test";
import assert from "node:assert/strict";
import { classifyCategories, extractServices } from "../src/discovery/8004scan.mjs";

test("classification uses description and service metadata, not only name", () => {
  const result = classifyCategories({ name: "Unrelated", description: "stablecoin yield optimisation routing agent", tags: [], categories: [], services: [{ name: "A2A", description: "ERC-8183 seller negotiation" }] });
  assert.equal(result[0].category, "yield_optimisation");
});

test("modern and legacy service fields are normalized", () => {
  const services = extractServices({ services: { a2a: { endpoint: "https://a.example/card", version: "0.3.0" } }, endpoints: [{ type: "mcp", url: "https://m.example/mcp" }] });
  assert.deepEqual(services.map(service => service.endpoint), ["https://a.example/card", "https://m.example/mcp"]);
});

test("local services are represented but never treated as live", async () => {
  const { Eight004ScanAdapter } = await import("../src/discovery/8004scan.mjs");
  const probe = await new Eight004ScanAdapter().probeService({ type: "A2A", endpoint: "http://localhost:3000/agent-card.json" });
  assert.equal(probe.status, "blocked_private_or_local");
  assert.equal(probe.reachable, false);
});

test("HTTP failure and timeout remain explicit discovery failures", async () => {
  const { Eight004ScanAdapter } = await import("../src/discovery/8004scan.mjs");
  // The probe now resolves the host before connecting, so a fake endpoint
  // needs fake DNS. The resolver answers with a public address; what is under
  // test is still what happens after the connection is allowed.
  const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
  const failed = await new Eight004ScanAdapter({ resolver, fetchImpl: async () => new Response("upstream unavailable", { status: 503 }) }).probeService({ type: "A2A", endpoint: "https://agent.example/card" });
  assert.equal(failed.status, "unreachable");
  assert.equal(failed.httpStatus, 503);

  const timedOut = await new Eight004ScanAdapter({ resolver, timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))) }).probeService({ type: "A2A", endpoint: "https://agent.example/card" });
  assert.equal(timedOut.status, "unreachable");
  assert.equal(timedOut.reason, "timeout");
});
