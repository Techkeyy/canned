/**
 * Documentation and security cleanup regressions.
 *
 * These tests are deliberately offline. They inspect the retired helper,
 * current-facing copy, historical decision records, and already-recorded
 * evidence without contacting a chain or creating a new lifecycle.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deriveMarketplaceMetrics } from "../src/marketplace/metrics.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readText = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const readJson = (relativePath) => JSON.parse(readText(relativePath));

test("the historical session helper fails closed and has no persistence path", () => {
  const relative = "scripts/altana-create-session.mjs";
  const source = readText(relative);
  assert.doesNotMatch(source, /(?:writeFile|writeFileSync|mkdir|exportPrivateKey|grantSession|revokeSession|sendRawTransaction|grid-session-key)/i);
  assert.doesNotMatch(source, /privateKey/i);

  const result = spawnSync(process.execPath, [path.join(root, relative)], { encoding: "utf8" });
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "blocked");
  assert.equal(output.writesAttempted, false);
});

test("current Grid Keeper documentation names the V2 executable route", () => {
  const grid = readText("docs/GRID-KEEPER.md");
  const readme = readText("README.md");
  assert.match(grid, /PancakeSwap V2 router/);
  assert.match(grid, /swapExactTokensForTokens.*0x38ed1739/);
  assert.match(grid, /SmartRouter V3[\s\S]*Historical design only/);
  assert.doesNotMatch(grid, /SmartRouter V3[^\n]*\| This is what Grid Keeper uses/);
  assert.match(readme, /session-key PancakeSwap V2 trade/);
  assert.match(readme, /native allowance of approximately 0\.00012314 tBNB for the Altana relay fee only/);
});

test("historical V3 and intermediate ADR states remain preserved but labeled", () => {
  const decisions = readText("docs/DECISIONS.md");
  const requirements = readText("docs/HACKATHON-REQUIREMENTS.md");

  assert.match(decisions, /ADR-048[\s\S]*?Status: \*\*SUPERSEDED by ADR-060\.\*\*[\s\S]*?SmartRouter V3/);
  assert.match(decisions, /ADR-060[\s\S]*?PancakeSwap V2 router[\s\S]*?swapExactTokensForTokens/);
  assert.match(decisions, /ADR-055[\s\S]*?Status: \*\*SUPERSEDED by the later paid job 837 evidence/);
  assert.match(decisions, /ADR-062[\s\S]*?Status: \*\*SUPERSEDED by ADR-063, ADR-064/);
  assert.match(requirements, /Directive #18[\s\S]*?HISTORICAL STATE — SUPERSEDED/);
  assert.match(requirements, /Directive #19[\s\S]*?HISTORICAL STATE — SUPERSEDED/);
  assert.match(requirements, /Directive #20[\s\S]*?HISTORICAL STATE — SUPERSEDED/);
  assert.match(requirements, /Directive #21[\s\S]*?ALTANA_REAL_SESSION_EVIDENCE = `?true/);
});

test("the final Altana evidence still derives the bounded V2 proof", () => {
  const proof = readJson("data/state/altana-final-proof.json");
  const execution = proof.steps.execution;
  const granted = proof.steps.granted;
  assert.equal(proof.chainId, 97);
  assert.equal(String(proof.owner).toLowerCase(), "0xbb62a403f8b582b49bcb05e1a7a678da4ebde48f");
  assert.equal(execution.succeeded, true);
  assert.equal(execution.signedBy, "altana_session_key");
  assert.equal(execution.selector, "0x38ed1739");
  assert.equal(execution.fillsUsed, 1);
  assert.equal(execution.maxFills, 1);
  assert.equal(execution.balances.usdtSpentRaw, "1000000000000000000");
  assert.equal(execution.balances.wbnbReceivedRaw, "77755707711365866");
  assert.equal(granted.permissions.spend.find((entry) => entry.purpose === "relay fee only").token, "0x0000000000000000000000000000000000000000");
  assert.equal(proof.steps.feeModel.usdtSupportedAsFeeToken, false);
  assert.equal(proof.steps.revokedKeyRefused.verdict, "REJECTED_BECAUSE_REVOKED");
});

test("the persisted authority is revoked, key material is absent, and the router allowance is zero", () => {
  const session = readJson("data/state/grid-session.json");
  const key = readJson("data/state/grid-session-key.json");
  const proof = readJson("data/state/altana-final-proof.json");
  assert.equal(session.revoked, true);
  assert.equal(key.retained, false);
  assert.equal("privateKey" in key, false);
  assert.equal(proof.steps.allowanceCleared.residualAllowanceRaw, "0");
  assert.equal(proof.steps.revokedKeyRefused.onchainKeyCheck.sessionKeyStillAuthorized, false);
});

test("the Altana proof is not a paid benchmark and marketplace metrics remain unchanged", () => {
  const runs = readJson("data/state/benchmark-runs.json");
  const proof = readJson("data/state/altana-final-proof.json");
  const derived = deriveMarketplaceMetrics({ candidates: [], runs });
  const pairs = readJson("data/state/agent-advantage-pairs.json").pairs;

  assert.equal(proof.protocolJob ?? null, null);
  assert.equal(proof.runType ?? null, null);
  assert.equal(runs.some((run) => JSON.stringify(run).includes(proof.steps.execution.transactionHash)), false);
  assert.equal(derived.jobsPaidForAndGraded, 4);
  assert.equal(derived.wins, 2);
  assert.equal(derived.qualifyingBenchmarks, 4);
  assert.equal(derived.losses, 1);
  assert.equal(derived.timeouts, 3);
  assert.equal(pairs.filter((entry) => entry.termix?.termixCandidatePair === true).length, 3);
});

test("tracked files contain no raw wallet key material", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/).filter(Boolean);
  const rawKeyAssignment = /(?:privateKey|secretKey|mnemonic|seedPhrase)\s*[:=]\s*["']?0x[0-9a-f]{64}\b/i;
  for (const relativePath of tracked) {
    if (!/\.(?:js|mjs|ts|json|md|html|css|ya?ml|env|txt)$/i.test(relativePath)) continue;
    const source = readText(relativePath);
    assert.doesNotMatch(source, rawKeyAssignment, `raw wallet key material in ${relativePath}`);
  }
});

test("Vercel exposes only the exact safe commerce proxy routes", () => {
  const config = readJson("vercel.json");
  const sources = config.rewrites.map((entry) => entry.source);
  for (const source of ["/api/hire/prepare", "/api/claim/challenge", "/api/claim/verify", "/api/list/submit"]) assert.ok(sources.includes(source), `${source} must be explicitly proxied`);
  assert.equal(sources.some((source) => source.includes(":path*")), false);
  assert.equal(sources.includes("/mpp"), false);
  assert.equal(sources.includes("/x402"), false);
});
