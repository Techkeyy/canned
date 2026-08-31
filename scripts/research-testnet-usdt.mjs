/**
 * Read-only research: can the exact BSC Testnet USDT that the Grid Keeper
 * execution path needs be obtained from resources Canned already controls?
 *
 * Nothing here signs, sends, or approves anything. Every call is an eth_call
 * or a balance read. The point is to answer the acquisition question with
 * evidence rather than to guess at a faucet.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { GRID_TESTNET_VENUE } from "../src/reference/grid-keeper.mjs";
import { REFERENCE_PAYMENT_TOKEN } from "../src/reference/constants.mjs";
import { contentHashes, nowIso } from "../src/core.mjs";

const RPC = process.env.RPC_URL_BSC_TESTNET || "http://127.0.0.1:8546";
const call = async (method, params) => {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json();
  if (body.error) return { __error: body.error.message };
  return body.result;
};
const pad = (address) => String(address).toLowerCase().replace("0x", "").padStart(64, "0");
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const decodeString = (raw) => {
  if (!raw || raw.__error || raw === "0x") return null;
  const hex = raw.slice(2);
  try {
    const offset = parseInt(hex.slice(0, 64), 16) * 2;
    const length = parseInt(hex.slice(offset, offset + 64), 16) * 2;
    return Buffer.from(hex.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
  } catch { return null; }
};

const USDT = GRID_TESTNET_VENUE.usdt;
const WBNB = GRID_TESTNET_VENUE.wbnb;
const U = REFERENCE_PAYMENT_TOKEN;
const BUSD = "0xeD24FC36d5Ee211Ea25A80239Fb8C4Cfd80f12Ee";
const V2_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const V3_FACTORY = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865";
const V3_QUOTER = GRID_TESTNET_VENUE.quoterV2;

/** Identify a token by what the chain says, never by its symbol alone. */
async function tokenFacts(address) {
  const [code, symbolRaw, nameRaw, decimalsRaw, supplyRaw, ownerRaw] = await Promise.all([
    call("eth_getCode", [address, "latest"]),
    call("eth_call", [{ to: address, data: "0x95d89b41" }, "latest"]),
    call("eth_call", [{ to: address, data: "0x06fdde03" }, "latest"]),
    call("eth_call", [{ to: address, data: "0x313ce567" }, "latest"]),
    call("eth_call", [{ to: address, data: "0x18160ddd" }, "latest"]),
    call("eth_call", [{ to: address, data: "0x8da5cb5b" }, "latest"]),
  ]);
  const codeBytes = code && !code.__error ? (code.length - 2) / 2 : 0;
  return {
    address,
    codeBytes,
    deployed: codeBytes > 0,
    symbol: decodeString(symbolRaw),
    name: decodeString(nameRaw),
    decimals: decimalsRaw && !decimalsRaw.__error ? parseInt(decimalsRaw, 16) : null,
    totalSupplyRaw: supplyRaw && !supplyRaw.__error ? BigInt(supplyRaw).toString() : null,
    owner: ownerRaw && !ownerRaw.__error && ownerRaw !== "0x" ? "0x" + ownerRaw.slice(26) : null,
  };
}

/** Is there any open distribution on the token itself? */
async function distributionProbe(token, from) {
  const probes = {
    "mint(address,uint256)": "0x40c10f19" + pad(from) + word(10n ** 18n),
    "faucet()": "0xde5f72fd",
    "claim()": "0x4e71d92d",
    "drip()": "0x9f678cca",
  };
  const results = {};
  for (const [signature, data] of Object.entries(probes)) {
    const outcome = await call("eth_call", [{ from, to: token, data }, "latest"]);
    results[signature] = outcome && outcome.__error ? "reverts: " + String(outcome.__error).slice(0, 60) : "SUCCEEDS";
  }
  return results;
}

async function v2Quote(amountIn, pathTokens) {
  const encodedPath = pathTokens.map(pad).join("");
  const data = "0xd06ca61f" + word(amountIn) + word(64) + word(pathTokens.length) + encodedPath;
  const raw = await call("eth_call", [{ to: V2_ROUTER, data }, "latest"]);
  if (!raw || raw.__error) return { ok: false, reason: String(raw && raw.__error ? raw.__error : "no result").slice(0, 70) };
  const words = raw.slice(2).match(/.{64}/g) || [];
  return { ok: true, amountOutRaw: BigInt("0x" + words[words.length - 1]).toString() };
}

async function v3PoolsFor(tokenA, tokenB) {
  const found = [];
  for (const fee of [100, 500, 2500, 10000]) {
    const data = "0x1698ee82" + pad(tokenA) + pad(tokenB) + word(fee);
    const raw = await call("eth_call", [{ to: V3_FACTORY, data }, "latest"]);
    if (!raw || raw.__error) continue;
    const pool = "0x" + raw.slice(26);
    if (/^0x0+$/.test(pool)) continue;
    const liquidityRaw = await call("eth_call", [{ to: pool, data: "0x1a686502" }, "latest"]);
    found.push({ fee, pool, liquidity: liquidityRaw && !liquidityRaw.__error ? BigInt(liquidityRaw).toString() : null });
  }
  return found;
}

async function v3Quote(tokenIn, tokenOut, fee, amountIn) {
  const data = "0xc6a5026a" + pad(tokenIn) + pad(tokenOut) + word(amountIn) + word(fee) + word(0);
  const raw = await call("eth_call", [{ to: V3_QUOTER, data }, "latest"]);
  if (!raw || raw.__error) return { ok: false, reason: String(raw && raw.__error ? raw.__error : "no result").slice(0, 70) };
  return { ok: true, amountOutRaw: BigInt("0x" + raw.slice(2, 66)).toString() };
}

const WALLETS = {
  "buyer": "0x14342bE6726f1f5AaFa30b673c787D696e3F09eB",
  "health provider": "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7",
  "range provider": "0x0eAc2F4d215A416f891C43BFFa83329Ec249AD5a",
  "yield provider": "0x99E5Fee06CF247F522119314980c58B8501d5684",
  "grid provider": "0xA928DEBa3aD929A915eE26fD3394126364928460",
  "control provider": "0x62360DC103f861371390996286F4cd9251deAB56",
  "health benchmark": "0xD164600c50B4F35593Cdc24F808cDA6DcFB1D645",
  "action wallet": "0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f",
};

const report = { entity: "TestnetUsdtAcquisitionResearch", readOnly: true, transactionsSent: 0, chainId: 97, rpcHost: new URL(RPC).host, checkedAt: nowIso() };

report.expectedTestnetUsdt = await tokenFacts(USDT);
report.paymentTokenU = await tokenFacts(U);
report.wbnb = await tokenFacts(WBNB);

report.walletScan = {};
for (const [label, address] of Object.entries(WALLETS)) {
  const [native, usdtRaw, uRaw] = await Promise.all([
    call("eth_getBalance", [address, "latest"]),
    call("eth_call", [{ to: USDT, data: "0x70a08231" + pad(address) }, "latest"]),
    call("eth_call", [{ to: U, data: "0x70a08231" + pad(address) }, "latest"]),
  ]);
  report.walletScan[label] = {
    address,
    tBNB: (Number(BigInt(native)) / 1e18).toFixed(8),
    usdtRaw: usdtRaw && usdtRaw.__error ? null : BigInt(usdtRaw).toString(),
    uRaw: uRaw && uRaw.__error ? null : BigInt(uRaw).toString(),
  };
}
report.anyWalletHoldsUsdt = Object.values(report.walletScan).some((entry) => entry.usdtRaw && BigInt(entry.usdtRaw) > 0n);

report.tokenDistribution = await distributionProbe(USDT, WALLETS["action wallet"]);

report.uToUsdt = {
  v3PoolsDirect: await v3PoolsFor(U, USDT),
  v3PoolsUtoWbnb: await v3PoolsFor(U, WBNB),
  v2Direct: await v2Quote(10n ** 18n, [U, USDT]),
  v2ViaWbnb: await v2Quote(10n ** 18n, [U, WBNB, USDT]),
};

const wbnbUsdtPools = await v3PoolsFor(WBNB, USDT);
report.wbnbToUsdt = {
  v3Pools: wbnbUsdtPools,
  v3Quotes: {},
  v2Direct1e16: await v2Quote(10n ** 16n, [WBNB, USDT]),
  v2Direct1e18: await v2Quote(10n ** 18n, [WBNB, USDT]),
};
for (const pool of wbnbUsdtPools) {
  report.wbnbToUsdt.v3Quotes["fee_" + pool.fee] = await v3Quote(WBNB, USDT, pool.fee, 10n ** 16n);
}

// Two independent USD-stable references should roughly agree. If they do not,
// the venue has no coherent price and no quote from it can be trusted.
report.coherence = {
  wbnbToUsdt1e18: report.wbnbToUsdt.v2Direct1e18,
  wbnbToBusd1e18: await v2Quote(10n ** 18n, [WBNB, BUSD]),
};

const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
await mkdir(path.join(dataDir, "state"), { recursive: true });
await writeFile(path.join(dataDir, "state", "testnet-usdt-research.json"), JSON.stringify({ ...report, hashes: contentHashes(report) }, null, 2) + "\n", "utf8");
console.log(JSON.stringify(report, null, 2));
