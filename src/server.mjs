import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileStore } from "./persistence/file-store.mjs";
import { publicMetrics } from "./domain.mjs";
import { buildMarketplaceSnapshot, compareAgents } from "./marketplace/model.mjs";
import { deriveMarketplaceMetrics } from "./marketplace/metrics.mjs";
import { schedulerStatus } from "./scheduler/policy.mjs";

const store = await new FileStore().init();
const html = await readFile(path.resolve(process.cwd(), "web/inspection.html"), "utf8");
const port = Number(process.env.PORT || 8787);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

async function snapshot() {
  const [report, runs] = await Promise.all([
    store.loadJson("inventory/verified-candidates.json", { candidates: [], categorySummary: {} }),
    store.loadRuns(),
  ]);
  const marketplace = buildMarketplaceSnapshot({ report, runs });
  return { report, runs, marketplace, metrics: deriveMarketplaceMetrics({ candidates: report.candidates || [], runs }) };
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/inspection") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
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
