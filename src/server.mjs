import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { nowIso } from "./core.mjs";
import { FileStore } from "./persistence/file-store.mjs";
import { publicMetrics } from "./domain.mjs";
import { buildMarketplaceSnapshot, compareAgents } from "./marketplace/model.mjs";
import { deriveMarketplaceMetrics } from "./marketplace/metrics.mjs";
import { schedulerStatus } from "./scheduler/policy.mjs";
import { buildHealthFactorDeliverable, manualHealthFactorBaselinePacket } from "./reference/health-factor.mjs";
import { ReferenceAgentRuntime } from "./reference/foundation.mjs";
import { implementedReferenceAgentCandidates, REFERENCE_PAYMENT_TOKEN, referenceFleetCatalog, referenceSpec } from "./reference/constants.mjs";
import { altanaAvailability, buildAltanaSessionPolicy, officialErc8183Addresses } from "./reference/altana.mjs";
import { completeHumanBaseline, createHumanBaselineAttempt, publicHealthBenchPacket, publicHealthBenchSource } from "./reference/health-benchmark.mjs";

const store = await new FileStore().init();
const html = await readFile(path.resolve(process.cwd(), "web/inspection.html"), "utf8");
const baselineHtml = await readFile(path.resolve(process.cwd(), "web/health-baseline.html"), "utf8");
const port = Number(process.env.PORT || 8787);
const healthFactorRuntime = new ReferenceAgentRuntime({
  spec: referenceSpec("health-factor"),
  taskHandler: ({ jobId, task, previousSnapshot }) => buildHealthFactorDeliverable({ jobId, task, previousSnapshot }),
});

async function referenceProviderAddress() {
  if (process.env.CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS) return process.env.CANNED_REFERENCE_HEALTH_PROVIDER_ADDRESS;
  try {
    const directory = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"), "state", "reference-provider-wallets");
    const names = (await readdir(directory)).filter((name) => /^0x[0-9a-fA-F]{40}\.json$/.test(name));
    return names.length === 1 ? names[0].slice(0, -5) : null;
  } catch { return null; }
}

async function referenceIdentityRecord() {
  return store.loadJson("state/reference-health-identity.json", null);
}

async function healthBenchDefinition() {
  return store.loadJson("state/healthbench-v1.json", null);
}

async function humanBaseline() {
  return store.loadJson("state/health-baseline.json", null);
}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body, (_key, value) => typeof value === "bigint" ? value.toString() : value));
}

async function snapshot() {
  const [report, runs] = await Promise.all([
    store.loadJson("inventory/verified-candidates.json", { candidates: [], categorySummary: {} }),
    store.loadRuns(),
  ]);
  const identityRecord = await referenceIdentityRecord();
  const candidates = [...(report.candidates || []), ...implementedReferenceAgentCandidates({ endpointBase: process.env.CANNED_REFERENCE_AGENT_URL || `http://127.0.0.1:${port}`, providerAddress: await referenceProviderAddress(), identityRecord, allowLocalProbe: false, publicReadinessVerified: identityRecord?.publicReadinessVerified === true })];
  const marketplace = buildMarketplaceSnapshot({ report: { ...report, candidates }, runs });
  return { report: { ...report, candidates }, runs, marketplace, metrics: deriveMarketplaceMetrics({ candidates, runs }) };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return { body: {}, raw: "{}" };
  try { return { body: JSON.parse(raw), raw }; } catch { throw new Error("Request body must be valid JSON."); }
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/inspection") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.url === "/baseline/health-factor") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(baselineHtml);
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname === "/api/health") { json(response, 200, { ok: true, network: "bsc-testnet", chainId: 97, mode: process.env.CANNED_MODE || "live", mainnetWrites: false }); return; }
    if (url.pathname === "/api/inventory") { json(response, 200, await store.loadJson("inventory/verified-candidates.json", { candidates: [], categorySummary: {} })); return; }
    if (url.pathname === "/api/runs") { const runs = await store.loadRuns(); json(response, 200, { runs, publicMetrics: publicMetrics(runs) }); return; }
    if (url.pathname === "/api/marketplace") {
      const current = await snapshot();
      const category = url.searchParams.get("category");
      const agents = category ? current.marketplace.categories.find((item) => item.category === category)?.agents || [] : current.marketplace.agents;
      json(response, 200, { ...current.marketplace, agents, metrics: current.metrics });
      return;
    }
    if (url.pathname === "/api/metrics") { const current = await snapshot(); json(response, 200, current.metrics); return; }
    if (url.pathname === "/api/reference/fleet") { json(response, 200, { origin: "CANNED_REFERENCE", network: "bsc-testnet", chainId: 97, agents: referenceFleetCatalog() }); return; }
    if (url.pathname === "/api/reference/health-factor" && request.method === "GET") { json(response, 200, healthFactorRuntime.health()); return; }
    if (url.pathname === "/api/reference/health-factor/readiness") { json(response, 200, healthFactorRuntime.readiness()); return; }
    if (url.pathname === "/api/reference/health-factor/metrics") { json(response, 200, healthFactorRuntime.metrics()); return; }
    if (url.pathname === "/api/reference/health-factor/negotiate") {
      const body = request.method === "POST" ? await readBody(request) : Object.fromEntries(url.searchParams.entries());
      json(response, 200, healthFactorRuntime.negotiate({ request: body, providerAddress: await referenceProviderAddress(), paymentToken: REFERENCE_PAYMENT_TOKEN }));
      return;
    }
    if (url.pathname === "/api/reference/health-factor/task" && request.method === "POST") {
      const frozenDefinition = await healthBenchDefinition();
      const baseline = await humanBaseline();
      if (frozenDefinition && baseline?.status !== "submitted") {
        json(response, 403, { status: "blocked", reason: "HealthBench human baseline must be submitted before any benchmark-bound agent result is exposed." });
        return;
      }
      const body = await readBody(request);
      const result = await healthFactorRuntime.work({ jobId: body.jobId || null, task: body.task || body, previousSnapshot: body.previousSnapshot || null });
      json(response, result.ok ? 200 : 422, result);
      return;
    }
    if (url.pathname === "/api/reference/health-factor/manual-baseline") {
      json(response, 200, manualHealthFactorBaselinePacket({ task: { account: url.searchParams.get("account") || null, poolType: url.searchParams.get("poolType") || null } }));
      return;
    }
    if (url.pathname === "/api/altana/status") { json(response, 200, await altanaAvailability()); return; }
    if (url.pathname === "/api/altana/policy") {
      try {
        const official = await officialErc8183Addresses();
        const commerceAddress = process.env.CANNED_ERC8183_COMMERCE_ADDRESS || official.commerceAddress;
        const routerAddress = process.env.CANNED_ERC8183_ROUTER_ADDRESS || official.routerAddress;
        const expiry = Math.floor(Date.now() / 1000) + 900;
        json(response, 200, { status: "policy_ready", officialDeployments: official, policy: buildAltanaSessionPolicy({ commerceAddress, routerAddress, expiry, maxSpendRaw: process.env.CANNED_REFERENCE_MAX_SPEND_RAW || "1000000000000000" }) });
      } catch (error) { json(response, 422, { status: "blocked", reason: error.message }); }
      return;
    }
    if (url.pathname === "/api/compare") {
      const current = await snapshot();
      const ids = (url.searchParams.get("ids") || "").split("|").map((item) => decodeURIComponent(item)).filter(Boolean);
      json(response, 200, compareAgents(current.marketplace.agents, ids, url.searchParams.get("category") || null));
      return;
    }
    if (url.pathname === "/api/operator") {
      const current = await snapshot();
      const attempts = current.runs.filter((run) => run?.protocolJob?.funded === true).map((run) => ({ provider: run.agent?.identity, agentIdentity: run.agent?.identity, status: run.terminalState || run.protocolJob?.currentState?.toLowerCase() || "pending", costU: null, createdAt: run.createdAt }));
      json(response, 200, { network: "bsc-testnet", chainId: 97, scheduler: schedulerStatus({ attempts }), candidates: current.marketplace.agents.map((agent) => ({ identity: agent.identity, name: agent.name, status: agent.status, quarantine: agent.quarantine, trust: agent.trust })) });
      return;
    }
    if (url.pathname === "/api/hire/prepare") {
      const current = await snapshot();
      const identity = url.searchParams.get("identity");
      const agent = current.marketplace.agents.find((item) => item.identity === identity);
      if (!agent) { json(response, 404, { error: "Agent not found." }); return; }
      json(response, 200, { agent: { identity: agent.identity, name: agent.name }, review: agent.activation, status: agent.status, trust: agent.trust, note: agent.activation.selection.status === "ready" ? "This is a review step. A separate explicit confirmation is required before any testnet write." : agent.activation.selection.reason });
      return;
    }
    if (url.pathname === "/api/baseline/health-factor" && request.method === "GET") {
      const definition = await healthBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "HealthBench v1 has not been frozen." }); return; }
      const baseline = await humanBaseline();
      const packet = publicHealthBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: baseline?.status || "not_started", attemptId: baseline?.attemptId || null, sourceAvailable: baseline?.status === "started" };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/health-factor/start" && request.method === "POST") {
      const definition = await healthBenchDefinition();
      if (!definition) { json(response, 404, { status: "not_ready", reason: "HealthBench v1 has not been frozen." }); return; }
      const current = await humanBaseline();
      if (current?.status === "submitted") { json(response, 409, { status: "already_submitted", attemptId: current.attemptId }); return; }
      const attempt = current?.status === "started" ? current : createHumanBaselineAttempt({ benchmarkId: definition.benchmarkId });
      if (!current || current.status !== "started") await store.saveJson("state/health-baseline.json", attempt);
      const packet = publicHealthBenchPacket(definition);
      packet.baseline = { ...packet.baseline, status: "started", attemptId: attempt.attemptId, startedAt: attempt.startedAt, sourceAvailable: true };
      json(response, 200, packet);
      return;
    }
    if (url.pathname === "/api/baseline/health-factor/source" && request.method === "GET") {
      const definition = await healthBenchDefinition();
      const baseline = await humanBaseline();
      if (!definition || baseline?.status !== "started") { json(response, 403, { status: "blocked", reason: "Start the human baseline before requesting the frozen raw source packet." }); return; }
      json(response, 200, publicHealthBenchSource(definition));
      return;
    }
    if (url.pathname === "/api/baseline/health-factor/submit" && request.method === "POST") {
      const definition = await healthBenchDefinition();
      const baseline = await humanBaseline();
      if (!definition || baseline?.status !== "started") { json(response, 403, { status: "blocked", reason: "A started human baseline is required." }); return; }
      const incoming = await readJsonBody(request);
      const completed = completeHumanBaseline({ attempt: baseline, submission: incoming.body, submittedAt: nowIso(), elapsedMs: Math.max(0, Date.now() - Date.parse(baseline.startedAt)) });
      completed.rawSubmissionJson = incoming.raw;
      completed.groundTruth = null;
      completed.agentOutput = null;
      await store.saveJson("state/health-baseline.json", completed);
      json(response, 200, { status: "submitted", attemptId: completed.attemptId, benchmarkId: completed.benchmarkId, submittedAt: completed.submittedAt, elapsedMs: completed.elapsedMs, preserved: true, evaluated: false, agentRun: "not_started" });
      return;
    }
    if (url.pathname.startsWith("/api/agents/")) {
      const current = await snapshot();
      const identity = decodeURIComponent(url.pathname.slice("/api/agents/".length));
      const agent = current.marketplace.agents.find((item) => item.identity === identity);
      if (!agent) { json(response, 404, { error: "Agent not found." }); return; }
      json(response, 200, agent);
      return;
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: "The inspection data could not be loaded.", detail: error.message });
  }
});

server.listen(port, () => console.log(`Canned inspection server listening on http://localhost:${port}`));
