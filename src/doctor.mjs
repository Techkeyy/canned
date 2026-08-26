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
  const rpcUrl = env.CANNED_RPC_URL || (network === "bsc-mainnet" ? "https://bsc-rpc.publicnode.com" : "https://bsc-testnet-rpc.publicnode.com");
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  add("environment", network === "bsc-testnet" ? "PASS" : network === "bsc-mainnet" ? "WARN" : "FAIL", `network=${network} expectedChainId=${chainIdExpected}`);
  const safety = writeSafety({ ...env, CANNED_NETWORK: network });
  if (safety.writesRequested && !safety.safe) add("write_safety", "FAIL", safety.errors.join(" "));
  else add("write_safety", "PASS", safety.writesRequested ? "explicit testnet writes with dedicated wallet configuration" : "writes disabled");

  const rpc = await requestJson(rpcUrl, { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }, headers: { "Content-Type": "application/json" }, timeoutMs: 8_000 });
  const chainIdActual = rpc.body?.result ? Number.parseInt(rpc.body.result, 16) : null;
  add("rpc", rpc.ok && chainIdActual === chainIdExpected ? "PASS" : "FAIL", rpc.ok ? `chainId=${chainIdActual}` : rpc.error || `HTTP ${rpc.status}`);

  const store = new FileStore(env.CANNED_DATA_DIR);
  try { const storage = await store.probe(); add("storage", "PASS", `${storage.kind} root=${storage.root}`); } catch (error) { add("storage", "FAIL", error.message); }
  if (env.CANNED_DATABASE_URL) add("database", "WARN", "external database configured; local persistence remains the verified path in this slice");
  else add("database", "PASS", "local persistent run index selected; PostgreSQL adapter is not yet enabled");

  const scan = await requestJson("https://api.8004scan.io/health", { timeoutMs: 8_000 });
  add("8004scan", scan.ok ? "PASS" : "WARN", scan.ok ? `HTTP ${scan.status}` : scan.error || `HTTP ${scan.status}`);
  const sdk = await sdkStatus();
  add("bnb_sdk", sdk.available ? "PASS" : "FAIL", sdk.available ? `${sdk.package}@${sdk.version}` : sdk.error);
  const bag = await commandCheck("bag", ["--version"]);
  add("bag_cli", bag.status, bag.detail);
  const agentcore = await commandCheck("agentcore", ["--version"]);
  add("agentcore_cli", agentcore.status, agentcore.detail);
  add("execution_wallet", safety.walletConfigured ? "PASS" : "WARN", safety.walletConfigured ? "configured, secret values withheld" : "not configured; protocol writes remain blocked");
  add("fixture_boundary", env.CANNED_MODE === "fixture" ? "WARN" : "PASS", env.CANNED_MODE === "fixture" ? "fixture mode is active; public metrics are excluded" : "live mode is active; fixtures remain opt-in");
  const report = { network, rpcUrl, checks, ok: checks.every((check) => check.status !== "FAIL") };
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
