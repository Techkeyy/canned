import path from "node:path";
import { FileStore } from "../src/persistence/file-store.mjs";
import { correlateAgentFamily } from "../src/discovery/correlation.mjs";

const store = await new FileStore().init();
const inventory = await store.loadJson("inventory/verified-candidates.json", null);
if (!inventory?.candidates) throw new Error("Verified candidate inventory is missing.");
const report = correlateAgentFamily(inventory.candidates);
const saved = await store.saveJson("inventory/weigh-family-correlation.json", report);
console.log(JSON.stringify({ artifact: path.resolve(store.root, saved.relativePath), classification: report.classification, evidence: report.evidence, records: report.records.map(({ tokenId, name, identity, provider, endpointHosts, card, quote }) => ({ tokenId, name, identity, provider, endpointHosts, card, quote })) }, null, 2));
