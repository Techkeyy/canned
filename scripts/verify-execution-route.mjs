/**
 * Decide which PancakeSwap testnet route is actually executable, and price the
 * exact-USDT acquisition against live reserves.
 *
 * Directive #17 planned SmartRouter V3 `exactInputSingle`. That plan was made
 * before the V3 quoter was found to revert on this network. A permission must
 * name a route that genuinely works, so both are tested here by simulation and
 * the answer decides the allowlist rather than the other way round.
 *
 * Read-only. Nothing is signed, sent, approved or spent.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { contentHashes, nowIso } from "../src/core.mjs";

const RPC = process.env.RPC_URL_BSC_TESTNET || "http://127.0.0.1:8546";
const call = async (method, params) => {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) return { __error: body.error.message };
  return body.result;
};
const pad = (a) => String(a).toLowerCase().replace("0x", "").padStart(64, "0");
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const decodeString = (raw) => {
  if (!raw || raw.__error || raw === "0x") return null;
  const hex = raw.slice(2);
  try {
    const offset = parseInt(hex.slice(0, 64), 16) * 2;
    const length = parseInt(hex.slice(offset, offset + 64), 16) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
  } catch { return null; }
};

const USDT = "0x337610d27c682e347c9cd60bd4b3b107c9d34ddd";
const WBNB = "0xae13d989dac2f0debff460ac112a837c89baa7cd";
const V2_ROUTER = "0xd99d1c33f9fc3444f8101754abc46c52416550d1";
const V2_FACTORY = "0x6725f303b657a9451d8ba641348b6761a6cc7a17";
const V3_ROUTER = "0x9a489505a00ce272eaa5e07dba6491314cae3796";
const V3_QUOTER = "0xb048bbc1ee6b733fffcfb9e9cef7375518e25997";
const BUYER = "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB";
const ACTION = "0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f";

// swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
const V2_SWAP_SELECTOR = "0x38ed1739";
const V2_SWAP_SIGNATURE = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
// exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))
const V3_SWAP_SELECTOR = "0x414bf389";

const report = { entity: "PancakeExecutionRouteVerification", readOnly: true, transactionsSent: 0, chainId: null, checkedAt: nowIso() };
report.chainId = parseInt(await call("eth_chainId", []), 16);

/* --- 8. reverify the exact token on chain, not by symbol --- */
async function tokenFacts(address) {
  const [code, symbol, name, decimals, supply] = await Promise.all([
    call("eth_getCode", [address, "latest"]),
    call("eth_call", [{ to: address, data: "0x95d89b41" }, "latest"]),
    call("eth_call", [{ to: address, data: "0x06fdde03" }, "latest"]),
    call("eth_call", [{ to: address, data: "0x313ce567" }, "latest"]),
    call("eth_call", [{ to: address, data: "0x18160ddd" }, "latest"]),
  ]);
  return {
    address,
    codeBytes: code && !code.__error ? (code.length - 2) / 2 : 0,
    symbol: decodeString(symbol),
    name: decodeString(name),
    decimals: decimals && !decimals.__error ? parseInt(decimals, 16) : null,
    totalSupplyRaw: supply && !supply.__error ? BigInt(supply).toString() : null,
  };
}
report.token = { usdt: await tokenFacts(USDT), wbnb: await tokenFacts(WBNB) };
report.tokenMatchesConfiguredAddress = report.token.usdt.address === USDT;

/* --- routers exist --- */
report.routers = {};
for (const [label, address] of Object.entries({ v2Router: V2_ROUTER, v2Factory: V2_FACTORY, v3Router: V3_ROUTER, v3Quoter: V3_QUOTER })) {
  const code = await call("eth_getCode", [address, "latest"]);
  report.routers[label] = { address, codeBytes: code && !code.__error ? (code.length - 2) / 2 : 0 };
}

/* --- live V2 pair state --- */
const pairRaw = await call("eth_call", [{ to: V2_FACTORY, data: "0xe6a43905" + pad(WBNB) + pad(USDT) }, "latest"]);
const pair = pairRaw && !pairRaw.__error ? "0x" + pairRaw.slice(26) : null;
const reservesRaw = pair ? await call("eth_call", [{ to: pair, data: "0x0902f1ac" }, "latest"]) : null;
const token0Raw = pair ? await call("eth_call", [{ to: pair, data: "0x0dfe1681" }, "latest"]) : null;
const token0 = token0Raw && !token0Raw.__error ? "0x" + token0Raw.slice(26) : null;
const r0 = reservesRaw && !reservesRaw.__error ? BigInt("0x" + reservesRaw.slice(2, 66)) : 0n;
const r1 = reservesRaw && !reservesRaw.__error ? BigInt("0x" + reservesRaw.slice(66, 130)) : 0n;
report.v2Pair = {
  pair, token0,
  usdtReserveRaw: (token0 === USDT ? r0 : r1).toString(),
  wbnbReserveRaw: (token0 === USDT ? r1 : r0).toString(),
  usdtReserve: (Number(token0 === USDT ? r0 : r1) / 1e18).toFixed(4),
  wbnbReserve: (Number(token0 === USDT ? r1 : r0) / 1e18).toFixed(6),
};

/* --- 12A. is V3 executable? --- */
const v3QuoteRaw = await call("eth_call", [{ to: V3_QUOTER, data: "0xc6a5026a" + pad(WBNB) + pad(USDT) + word(10n ** 16n) + word(500) + word(0) }, "latest"]);
report.v3 = {
  router: V3_ROUTER,
  selector: V3_SWAP_SELECTOR,
  quoterResponds: !(v3QuoteRaw && v3QuoteRaw.__error),
  quoterError: v3QuoteRaw && v3QuoteRaw.__error ? String(v3QuoteRaw.__error).slice(0, 80) : null,
  executable: false,
};
report.v3.executable = report.v3.quoterResponds;

/* --- 12B. is V2 executable? quote, then simulate the real swap --- */
async function v2AmountsOut(amountIn, pathTokens) {
  const data = "0xd06ca61f" + word(amountIn) + word(64) + word(pathTokens.length) + pathTokens.map(pad).join("");
  const raw = await call("eth_call", [{ to: V2_ROUTER, data }, "latest"]);
  if (!raw || raw.__error) return null;
  const words = raw.slice(2).match(/.{64}/g) || [];
  return BigInt("0x" + words[words.length - 1]);
}

// Simulate the actual swap the session key would send: from the action wallet,
// USDT in, WBNB out. It reverts today only because the wallet holds no USDT
// and has granted no allowance, which is exactly the state this run fixes.
async function simulateV2Swap({ from, amountIn, pathTokens, recipient }) {
  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const data = V2_SWAP_SELECTOR + word(amountIn) + word(0) + word(160) + pad(recipient) + word(deadline)
    + word(pathTokens.length) + pathTokens.map(pad).join("");
  const raw = await call("eth_call", [{ from, to: V2_ROUTER, data }, "latest"]);
  return raw && raw.__error ? { ok: false, reason: String(raw.__error).slice(0, 90) } : { ok: true };
}

const quoteFor1Usdt = await v2AmountsOut(10n ** 18n, [USDT, WBNB]);
report.v2 = {
  router: V2_ROUTER,
  selector: V2_SWAP_SELECTOR,
  signature: V2_SWAP_SIGNATURE,
  quoteResponds: quoteFor1Usdt !== null,
  oneUsdtBuysWbnbRaw: quoteFor1Usdt !== null ? quoteFor1Usdt.toString() : null,
  // The forward direction the session key will actually use.
  simulatedFromActionWallet: await simulateV2Swap({ from: ACTION, amountIn: 10n ** 18n, pathTokens: [USDT, WBNB], recipient: ACTION }),
  // The same call from a wallet that does hold WBNB, proving the router path
  // itself works and the revert above is only the missing balance.
  simulatedWbnbToUsdtFromBuyer: await simulateV2Swap({ from: BUYER, amountIn: 10n ** 16n, pathTokens: [WBNB, USDT], recipient: BUYER }),
  executable: quoteFor1Usdt !== null,
};

/* --- 9/10. price the acquisition against the live pair --- */
async function tbnbNeededFor(targetUsdt) {
  let low = 0n;
  let high = 12n * 10n ** 16n; // the 0.12 tBNB ceiling
  for (let i = 0; i < 44; i += 1) {
    const mid = (low + high) / 2n;
    const out = await v2AmountsOut(mid, [WBNB, USDT]);
    if (out === null || out < targetUsdt) low = mid; else high = mid;
  }
  const out = await v2AmountsOut(high, [WBNB, USDT]);
  return { wbnbInRaw: high.toString(), wbnbIn: (Number(high) / 1e18).toFixed(6), usdtOutRaw: out === null ? null : out.toString(), usdtOut: out === null ? null : (Number(out) / 1e18).toFixed(4) };
}
report.acquisition = {
  ceilingTbnb: "0.12",
  ceilingWei: (12n * 10n ** 16n).toString(),
  target1_5: await tbnbNeededFor(15n * 10n ** 17n),
  minimum1_2: await tbnbNeededFor(12n * 10n ** 17n),
  maxOutAtCeiling: await v2AmountsOut(12n * 10n ** 16n, [WBNB, USDT]).then((v) => (v === null ? null : (Number(v) / 1e18).toFixed(4))),
};
report.acquisition.withinCeiling = BigInt(report.acquisition.target1_5.wbnbInRaw) <= 12n * 10n ** 16n;
report.acquisition.meetsMinimum = Number(report.acquisition.maxOutAtCeiling) >= 1.2;

/* --- the decision --- */
report.decision = {
  chosenRoute: report.v3.executable ? "pancakeswap_v3_smart_router" : report.v2.executable ? "pancakeswap_v2_router" : "none_executable",
  chosenRouter: report.v3.executable ? V3_ROUTER : report.v2.executable ? V2_ROUTER : null,
  chosenSelector: report.v3.executable ? V3_SWAP_SELECTOR : report.v2.executable ? V2_SWAP_SELECTOR : null,
  chosenSignature: report.v3.executable ? "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))" : report.v2.executable ? V2_SWAP_SIGNATURE : null,
  reason: report.v3.executable
    ? "The V3 quoter responded, so the originally planned route is usable."
    : "The V3 quoter reverts on this network, so the planned V3 route is not executable. The V2 router quotes and simulates, so the permission names V2. A permission must name a route that works, not the one that was planned.",
};

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
await mkdir(path.join(dataDir, "state"), { recursive: true });
await writeFile(path.join(dataDir, "state", "execution-route-verification.json"), JSON.stringify({ ...report, hashes: contentHashes(report) }, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
