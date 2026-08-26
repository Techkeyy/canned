import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FileStore } from "./persistence/file-store.mjs";
import { publicMetrics } from "./domain.mjs";

const store = await new FileStore().init();
const html = await readFile(path.resolve(process.cwd(), "web/inspection.html"), "utf8");
const port = Number(process.env.PORT || 8787);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === "/" || request.url === "/inspection") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.url === "/api/health") { json(response, 200, { ok: true, network: process.env.CANNED_NETWORK || "bsc-testnet", mode: process.env.CANNED_MODE || "live" }); return; }
    if (request.url === "/api/inventory") { json(response, 200, await store.loadJson("inventory/verified-candidates.json", { candidates: [], categorySummary: {} })); return; }
    if (request.url === "/api/runs") { const runs = await store.loadRuns(); json(response, 200, { runs, publicMetrics: publicMetrics(runs) }); return; }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    json(response, 500, { error: "The inspection data could not be loaded.", detail: error.message });
  }
});

server.listen(port, () => console.log(`Canned inspection server listening on http://localhost:${port}`));
