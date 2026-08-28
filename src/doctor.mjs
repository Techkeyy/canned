import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FileStore } from "./persistence/file-store.mjs";
import { requestJson } from "./core.mjs";
import { sdkStatus, writeSafety } from "./protocol/erc8183-buyer.mjs";

function commandCheck(command, args = [], timeoutMs = 8_000) {
  return new Promise((resolve) => {
    const executable = process.platform === "win32" && !command.endsWith(".cmd") ? `${command}.cmd` : command;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      const windows = process.platform === "win32";
      child = spawn(windows ? "cmd.exe" : executable, windows ? ["/d", "/c", executable, ...args] : args, { windowsHide: true });
    } catch (error) {
      resolve({ status: "WARN", detail: `${command} unavailable: ${error.message}` });
      return;
    }
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill(); resolve({ status: "WARN", detail: `${command} timed out` }); } }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status: "WARN", detail: `${command} unavailable: ${error.message}` }); } });
    child.on("close", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status: code === 0 ? "PASS" : "WARN", detail: (stdout || stderr || `exit ${code}`).trim().replace(/[\r\n]+/g, " ").slice(0, 240) }); } });
  });
}

export async function runDoctor({ env = process.env, print = true } = {}) {
  const network = env.CANNED_NETWORK || "bsc-testnet";
  const chainIdExpected = network === "bsc-mainnet" ? 56 : 97;
  // One endpoint going down should not report the whole environment as broken.
  // The declared endpoints are tried in order and the first that answers wins.
  const rpcCandidates = (network === "bsc-mainnet"
    ? [env.CANNED_RPC_URL, env.RPC_URL_BSC_MAINNET, "https://bsc-rpc.publicnode.com", "https://bsc-dataseed1.bnbchain.org"]
    : [env.CANNED_RPC_URL, env.RPC_URL_BSC_TESTNET, "https://bsc-testnet-rpc.publicnode.com", "https://bsc-prebsc-dataseed.bnbchain.org"]
  ).filter(Boolean);
  const rpcUrl = rpcCandidates[0];
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add("environment", network === "bsc-testnet" ? "PASS" : network === "bsc-mainnet" ? "WARN" : "FAIL", `network=${network} expectedChainId=${chainIdExpected}`);
  const safety = writeSafety({ ...env, CANNED_NETWORK: network });
  if (safety.writesRequested && !safety.safe) add("write_safety", "FAIL", safety.errors.join(" "));
  else add("write_safety", "PASS", safety.writesRequested ? "explicit testnet writes with dedicated wallet configuration" : "writes disabled");

  let rpc = null;
  let chainIdActual = null;
  let answeringRpcUrl = null;
  const rpcAttempts = [];
  for (const candidate of rpcCandidates) {
    const attempt = await requestJson(candidate, { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, headers: { "Content-Type": "application/json" }, timeoutMs: 8_000 });
    const observed = attempt.body?.result ? Number.parseInt(attempt.body.result, 16) : null;
    rpcAttempts.push({ url: candidate, ok: attempt.ok === true, chainId: observed });
    if (attempt.ok && observed === chainIdExpected) { rpc = attempt; chainIdActual = observed; answeringRpcUrl = candidate; break; }
    rpc = attempt;
    chainIdActual = observed;
  }
  const rpcHealthy = Boolean(answeringRpcUrl);
  add("rpc", rpcHealthy ? "PASS" : "FAIL", rpcHealthy
    ? `chainId=${chainIdActual}${answeringRpcUrl === rpcCandidates[0] ? "" : ` via fallback ${answeringRpcUrl}`}`
    : `no declared endpoint answered on chain ${chainIdExpected}; tried ${rpcAttempts.length}`);

  const store = new FileStore(env.CANNED_DATA_DIR);
  try { const storage = await store.probe(); add("storage", "PASS", `${storage.kind} root=${storage.root}`); } catch (error) { add("storage", "FAIL", error.message); }
  if (env.CANNED_DATABASE_URL) add("database", "WARN", "external database configured; local persistence remains the verified path in this slice");
  else add("database", "PASS", "local persistent run index selected; PostgreSQL adapter is not yet enabled");

  const scan = await requestJson("https://api.8004scan.io/health", { timeoutMs: 8_000 });
  add("8004scan", scan.ok ? "PASS" : "WARN", scan.ok ? `HTTP ${scan.status}` : scan.error || `HTTP ${scan.status}`);
  const sdk = await sdkStatus();
  add("bnb_sdk", sdk.available ? "PASS" : "FAIL", sdk.available ? `${sdk.package}@${sdk.version}` : sdk.error);
  const bag = await commandCheck("bag", ["--version"]);
  add("optional_bag_cli", bag.status, `optional provider/deployment tooling; ${bag.detail}`);
  const agentcore = await commandCheck("agentcore", ["--version"]);
  add("optional_agentcore_cli", agentcore.status, `optional AWS deployment tooling; ${agentcore.detail}`);
  add("execution_wallet", safety.walletConfigured ? "PASS" : "WARN", safety.walletConfigured ? "configured, secret values withheld" : "not configured; protocol writes remain blocked");
  add("fixture_boundary", env.CANNED_MODE === "fixture" ? "WARN" : "PASS", env.CANNED_MODE === "fixture" ? "fixture mode is active; public metrics are excluded" : "live mode is active; fixtures remain opt-in");
  const report = { network, rpcUrl: answeringRpcUrl || rpcUrl, rpcAttempts, checks, ok: checks.every((check) => check.status !== "FAIL") };
  if (print) {
    for (const check of checks) console.log(`${check.status} ${check.name}: ${check.detail}`);
    console.log(`SUMMARY ${report.ok ? "PASS" : "FAIL"} checks=${checks.length}`);
  }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = await runDoctor();
  if (!report.ok) process.exitCode = 1;
}
