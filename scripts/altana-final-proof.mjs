/**
 * The final Altana proof: one bounded session, one session-key trade, revoke.
 *
 * Everything runs in one process because the session signer must not be lost
 * between steps. Directive #20's first session was granted letting the SDK
 * generate its own signer, which is not retrievable afterwards; that session
 * was real and correctly bounded but unusable. Here the signer is generated
 * explicitly, held in memory, and forgotten at the end.
 *
 * Fee design. Directive #20's execution was refused with NoSpendPermissions
 * because the relay charges its fee in the native token while the session
 * permitted only USDT. The preferred fix was to pay the fee in USDT, but the
 * relay answers `fee token not supported` for it and advertises exactly one
 * fee token for chain 97: the native one. So the session carries a second,
 * deliberately tiny native spend permission whose only purpose is the relay
 * fee. It is sized from a measured quote, not from the wallet balance.
 *
 * The call allowlist stays one contract and one method. The native permission
 * buys nothing and calls nothing.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { contentHashes, nowIso } from "../src/core.mjs";

const ACTION_WALLET = "0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f";
const USDT = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const V2_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const NATIVE = "0x0000000000000000000000000000000000000000";
const SWAP_SIGNATURE = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
const SWAP_SELECTOR = "0x38ed1739";
const GRID_IDENTITY = "97:0x8004a818bfb912233c491871b3d84c89a494bd9e:2045";

/** Directive #21 section 5. Ceilings, not targets. */
const TRADE_INPUT_RAW = 1_000_000_000_000_000_000n;  // exactly 1.0 USDT
const TRADE_HARD_MAX_RAW = 1_000_000_000_000_000_000n;
const MAX_SLIPPAGE_BPS = 100n;
const MAX_FILLS = 1;
const DURATION_SECONDS = 60 * 60;                     // one hour, not six
/** The native permission exists only to pay the relay. Cap = measured fee x3. */
const FEE_MARGIN_MULTIPLIER = 3n;
/** Refuse to grant a native permission larger than this under any measurement. */
const NATIVE_CAP_CEILING = 3_000_000_000_000_000n;    // 0.003 tBNB

const env = process.env;
const dataDir = path.resolve(env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
const stateDir = path.join(dataDir, "state");
const log = (body) => console.log(JSON.stringify(body, null, 2));
const stop = (reason, details = {}) => { log({ status: "blocked", reason, ...details }); process.exit(2); };

if (env.CANNED_ALLOW_TESTNET_WRITES !== "true") stop("CANNED_ALLOW_TESTNET_WRITES is not true.");
if (env.CANNED_ALTANA_SESSION_CONFIRM !== "true") stop("Requires CANNED_ALTANA_SESSION_CONFIRM=true.");

const A = await import("@altananetwork/sdk");
const bnb = await import("@bnbagent/sdk");
const network = A.BNB_TESTNET;
if (network.chainId !== 97) stop("Altana network is not BSC Testnet.");
const RELAY = network.relayUrl;

const rpcUrl = env.RPC_URL_BSC_TESTNET || network.publicRpcUrl;
const chain = { id: 97, name: "BSC Testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } };
const publicClient = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 40_000 }) });
if ((await publicClient.getChainId()) !== 97) stop("RPC is not chain 97.");

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const routerAbi = parseAbi([
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])",
]);

const relayRpc = async (method, params) => {
  const response = await fetch(RELAY, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
};

const walletsDir = path.join(stateDir, "grid-action-wallets");
const keystoreAddress = bnb.EVMWalletProvider.listWallets(walletsDir)[0];
if (String(keystoreAddress).toLowerCase() !== ACTION_WALLET.toLowerCase()) stop("Action keystore mismatch.");
const password = (await readFile(path.join(stateDir, "grid-action-wallet-password.txt"), "utf8")).trim();
const owner = new bnb.EVMWalletProvider({ password, address: keystoreAddress, walletsDir, persist: true });

const evidence = { entity: "AltanaFinalProof", network: "bsc-testnet", chainId: 97, owner: ACTION_WALLET, gridIdentity: GRID_IDENTITY, startedAt: nowIso(), steps: {} };

async function ownerSend(label, { to, data, value = 0n }) {
  const [gasPrice, nonce] = await Promise.all([publicClient.getGasPrice(), publicClient.getTransactionCount({ address: ACTION_WALLET, blockTag: "pending" })]);
  const gas = await publicClient.estimateGas({ account: ACTION_WALLET, to, data, value });
  const signed = await owner.signTransaction({ to, data, value, gas: (gas * 12n) / 10n, gasPrice, nonce, chainId: 97 });
  const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  log({ status: label, transactionHash: hash, blockNumber: String(receipt.blockNumber) });
  return { hash, blockNumber: String(receipt.blockNumber) };
}

try {
  /* -- 3. the relay's own statement of which fee tokens it accepts -- */
  const caps = await relayRpc("wallet_getCapabilities", [["0x61"]]);
  const feeTokens = caps?.result?.["0x61"]?.fees?.tokens ?? [];
  const usdtSupported = feeTokens.some((token) => String(token.address).toLowerCase() === USDT.toLowerCase() && token.feeToken === true);
  const nativeSupported = feeTokens.some((token) => String(token.address).toLowerCase() === NATIVE && token.feeToken === true);
  evidence.steps.feeModel = {
    source: "wallet_getCapabilities on the Altana testnet relay",
    advertisedFeeTokens: feeTokens.map((token) => ({ uid: token.uid, address: token.address, symbol: token.symbol, decimals: token.decimals, feeToken: token.feeToken })),
    usdtSupportedAsFeeToken: usdtSupported,
    nativeSupportedAsFeeToken: nativeSupported,
    sdkDefault: "execute() uses opts.feeToken ?? NATIVE_TOKEN (0x0), execute.js line 16",
  };
  log({ status: "fee_model_read", ...evidence.steps.feeModel });

  /* -- 4. attempt the preferred design anyway, and record the refusal -- */
  const balanceUsdt = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] });
  if (balanceUsdt < TRADE_INPUT_RAW) stop("The action wallet does not hold the trade input.", { balanceUsdt: balanceUsdt.toString() });

  const allowanceBefore = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] });
  let approvalTx = null;
  if (allowanceBefore < TRADE_INPUT_RAW) {
    approvalTx = await ownerSend("owner_approved_router_exact_amount", { to: USDT, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [V2_ROUTER, TRADE_INPUT_RAW] }) });
  }

  const quoted = await publicClient.readContract({ address: V2_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [TRADE_INPUT_RAW, [USDT, WBNB]] });
  const expectedOut = quoted[quoted.length - 1];
  const minOut = (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const swapData = encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForTokens", args: [TRADE_INPUT_RAW, minOut, [USDT, WBNB], ACTION_WALLET, deadline] });
  if (!swapData.startsWith(SWAP_SELECTOR)) stop("Encoded call is not the allowed selector.");

  const usdtFeeAttempt = await relayRpc("wallet_prepareCalls", [{ from: ACTION_WALLET, chainId: "0x61", calls: [{ to: V2_ROUTER, value: "0x0", data: swapData }], capabilities: { meta: { feeToken: USDT } } }]);
  evidence.steps.usdtFeeAttempt = { accepted: !usdtFeeAttempt.error, error: usdtFeeAttempt.error?.message ?? null };
  log({ status: "usdt_fee_token_probe", ...evidence.steps.usdtFeeAttempt });

  /* -- 5/6. measure the native fee, then size the smallest usable cap -- */
  const nativeQuote = await relayRpc("wallet_prepareCalls", [{ from: ACTION_WALLET, chainId: "0x61", calls: [{ to: V2_ROUTER, value: "0x0", data: swapData }], capabilities: { meta: { feeToken: NATIVE } } }]);
  if (nativeQuote.error) stop("The relay could not quote the swap with a native fee; refusing to grant a permission sized on a guess.", { error: String(nativeQuote.error.message).slice(0, 200) });

  // The relay states the fee it will actually charge on the signed intent:
  // paymentToken is the native address and paymentMaxAmount is the ceiling it
  // may take. That is the number the permission is sized from. `feeTotals` is
  // a display figure and is not used for sizing.
  const intent = nativeQuote.result?.context?.quote?.quotes?.[0]?.intent ?? null;
  const paymentToken = intent?.paymentToken ?? null;
  const rawFee = intent?.paymentMaxAmount ?? null;
  if (!intent || rawFee === null || rawFee === undefined) {
    stop("The relay quote did not expose intent.paymentMaxAmount; refusing to size a native permission on a guess.", { contextKeys: Object.keys(nativeQuote.result?.context ?? {}) });
  }
  if (String(paymentToken).toLowerCase() !== NATIVE) {
    stop("The relay quoted a fee in an unexpected token.", { paymentToken });
  }
  const measuredFee = BigInt(rawFee);
  if (measuredFee <= 0n) stop("The relay quoted a non-positive fee; refusing to size a permission on it.", { rawFee });

  const nativeCap = measuredFee * FEE_MARGIN_MULTIPLIER;
  if (nativeCap > NATIVE_CAP_CEILING) stop("The measured relay fee implies a native cap above the hard ceiling; refusing.", { measuredFee: measuredFee.toString(), nativeCap: nativeCap.toString(), ceiling: NATIVE_CAP_CEILING.toString() });
  const usdtCap = TRADE_INPUT_RAW + TRADE_INPUT_RAW / 100n; // trade plus 1 percent, no more

  evidence.steps.feeMeasurement = {
    source: "wallet_prepareCalls -> context.quote.quotes[0].intent.paymentMaxAmount",
    paymentToken,
    paymentRecipient: intent.paymentRecipient ?? null,
    combinedGas: intent.combinedGas ?? null,
    measuredNativeFeeWei: measuredFee.toString(),
    measuredNativeFeeTBNB: (Number(measuredFee) / 1e18).toFixed(9),
    marginMultiplier: Number(FEE_MARGIN_MULTIPLIER),
    nativeSpendCapWei: nativeCap.toString(),
    nativeSpendCapTBNB: (Number(nativeCap) / 1e18).toFixed(9),
    hardCeilingWei: NATIVE_CAP_CEILING.toString(),
    usdtSpendCapRaw: usdtCap.toString(),
    note: "The native permission pays the relay only. It is sized from this measurement, never from the wallet balance.",
  };
  log({ status: "fee_measured", ...evidence.steps.feeMeasurement });

  /* -- 8. precommit, before the session exists -- */
  const precommit = {
    entity: "AltanaExecutionPrecommit",
    chainId: 97,
    actionWallet: ACTION_WALLET,
    gridIdentity: GRID_IDENTITY,
    router: V2_ROUTER,
    method: SWAP_SIGNATURE,
    selector: SWAP_SELECTOR,
    tradeToken: USDT,
    tradeMaxRaw: TRADE_HARD_MAX_RAW.toString(),
    tradeInputRaw: TRADE_INPUT_RAW.toString(),
    feeToken: NATIVE,
    feeTokenReason: "The relay advertises only the native token as a fee token on chain 97 and refuses USDT.",
    nativeFeeCapWei: nativeCap.toString(),
    usdtSpendCapRaw: usdtCap.toString(),
    expirySeconds: DURATION_SECONDS,
    maxFills: MAX_FILLS,
    maxSlippageBps: Number(MAX_SLIPPAGE_BPS),
    proofCriteria: [
      "one on-chain session-key transaction through the PancakeSwap V2 router",
      "input at most 1.0 USDT",
      "no call outside the allowlist",
      "spend inside both caps",
      "session revoked afterwards",
      "revoked key refused",
    ],
    precommittedAt: nowIso(),
  };
  evidence.steps.precommit = { ...precommit, hashes: contentHashes(precommit) };
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "altana-execution-precommit.json"), JSON.stringify(evidence.steps.precommit, null, 2) + "\n", "utf8");
  log({ status: "precommitted", sha256: evidence.steps.precommit.hashes.sha256 });

  /* -- 7/9. explicit session signer, one session -- */
  const signer = A.signerFromPrivateKey(owner.exportPrivateKey());
  const client = A.createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer });
  if (String(wallet.address).toLowerCase() !== ACTION_WALLET.toLowerCase()) stop("Altana wallet address mismatch.");

  const sessionSigner = A.createPrivateKeySigner();
  const expiry = Math.floor(Date.now() / 1000) + DURATION_SECONDS;
  const permissions = {
    calls: [{ to: V2_ROUTER, signature: SWAP_SIGNATURE }],
    spend: [
      { limit: usdtCap, period: "day", token: USDT },
      // Fee only. Buys nothing, calls nothing.
      { limit: nativeCap, period: "day" },
    ],
  };
  const granted = await client.grantSession({ wallet, signer, permissions, expiry, sessionSigner, register: true });
  evidence.steps.granted = {
    sessionPublicKey: granted.publicKey,
    sessionKeyAddress: sessionSigner.address,
    transactionHash: granted.transactionHash ?? null,
    expiry: granted.expiry,
    expiresAt: new Date(granted.expiry * 1000).toISOString(),
    keyStore: network.keyStore,
    keyStoreController: network.keyStoreController,
    permissions: {
      calls: granted.permissions.calls.map((c) => ({ to: c.to, signature: c.signature, selector: SWAP_SELECTOR })),
      spend: granted.permissions.spend.map((s) => ({ limit: String(s.limit), period: s.period, token: s.token ?? NATIVE, purpose: s.token ? "trade capital" : "relay fee only" })),
    },
  };
  log({ status: "session_granted", ...evidence.steps.granted });

  const checks = {
    ownerMatches: String(granted.walletAddress).toLowerCase() === ACTION_WALLET.toLowerCase(),
    chainIs97: network.chainId === 97,
    exactlyOneCallRule: granted.permissions.calls.length === 1,
    exactContract: String(granted.permissions.calls[0]?.to).toLowerCase() === V2_ROUTER.toLowerCase(),
    exactMethod: granted.permissions.calls[0]?.signature === SWAP_SIGNATURE,
    noUnrestrictedCallRule: granted.permissions.calls.every((c) => Boolean(c.to) && Boolean(c.signature)),
    twoSpendRules: granted.permissions.spend.length === 2,
    usdtCapWithinBound: BigInt(granted.permissions.spend.find((s) => s.token)?.limit ?? 0n) <= usdtCap,
    nativeCapWithinCeiling: BigInt(granted.permissions.spend.find((s) => !s.token)?.limit ?? 0n) <= NATIVE_CAP_CEILING,
    nativeCapIsTiny: BigInt(granted.permissions.spend.find((s) => !s.token)?.limit ?? 0n) < TRADE_INPUT_RAW,
    expiryWithinOneHour: granted.expiry <= Math.floor(Date.now() / 1000) + DURATION_SECONDS + 60,
    notExpired: granted.expiry * 1000 > Date.now(),
    sessionKeyIsNotOwner: sessionSigner.address.toLowerCase() !== ACTION_WALLET.toLowerCase(),
  };
  const broader = Object.entries(checks).filter(([, v]) => v === false).map(([k]) => k);
  evidence.steps.verification = { checks, broaderThanIntended: broader };
  if (broader.length) {
    const emergency = await client.revokeSession({ wallet, signer, session: granted.publicKey, chainId: 97 });
    stop("The granted permission is broader than intended. Revoked; nothing executed.", { broader, revokeTx: emergency.transactionHash ?? null });
  }
  log({ status: "session_verified", checks });

  /* -- 11/12. one execution -- */
  const [usdtBefore, wbnbBefore, nativeBefore] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.readContract({ address: WBNB, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.getBalance({ address: ACTION_WALLET }),
  ]);
  if (TRADE_INPUT_RAW > TRADE_HARD_MAX_RAW) stop("Trade input exceeds the hard maximum.");
  if (granted.expiry * 1000 <= Date.now()) stop("The session expired before execution.");

  log({ status: "execution_preflight", router: V2_ROUTER, selector: swapData.slice(0, 10), path: [USDT, WBNB], recipient: ACTION_WALLET, amountInRaw: TRADE_INPUT_RAW.toString(), expectedOutRaw: expectedOut.toString(), minOutRaw: minOut.toString(), feeToken: NATIVE, signedBy: "altana_session_key" });

  let executed = null;
  let executionError = null;
  try {
    executed = await client.execute({ session: granted, chainId: 97, calls: [{ to: V2_ROUTER, value: 0n, data: swapData }], feeToken: NATIVE });
  } catch (error) {
    executionError = String(error?.message ?? error).slice(0, 400);
  }

  const [usdtAfter, wbnbAfter, nativeAfter] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.readContract({ address: WBNB, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.getBalance({ address: ACTION_WALLET }),
  ]);
  evidence.steps.execution = {
    attempted: true,
    succeeded: executionError === null,
    error: executionError,
    callsId: executed?.callsId ?? null,
    relayStatus: executed?.status ?? null,
    transactionHash: executed?.transactionHash ?? null,
    signedBy: "altana_session_key",
    sessionKeyAddress: sessionSigner.address,
    router: V2_ROUTER, selector: SWAP_SELECTOR, method: SWAP_SIGNATURE, path: [USDT, WBNB],
    feeToken: NATIVE,
    amountInRaw: TRADE_INPUT_RAW.toString(),
    expectedOutRaw: expectedOut.toString(),
    minOutRaw: minOut.toString(),
    balances: {
      usdtBeforeRaw: usdtBefore.toString(), usdtAfterRaw: usdtAfter.toString(), usdtSpentRaw: (usdtBefore - usdtAfter).toString(),
      wbnbBeforeRaw: wbnbBefore.toString(), wbnbAfterRaw: wbnbAfter.toString(), wbnbReceivedRaw: (wbnbAfter - wbnbBefore).toString(),
      nativeBeforeWei: nativeBefore.toString(), nativeAfterWei: nativeAfter.toString(), nativeSpentWei: (nativeBefore - nativeAfter).toString(),
    },
    withinTradeCap: (usdtBefore - usdtAfter) <= TRADE_HARD_MAX_RAW,
    withinNativeCap: (nativeBefore - nativeAfter) <= nativeCap,
    fillsUsed: executionError === null ? 1 : 0,
    maxFills: MAX_FILLS,
  };
  log({ status: executionError === null ? "session_key_swap_executed" : "session_key_swap_failed", ...evidence.steps.execution });

  /* -- 15. revoke, success or failure -- */
  const revoked = await client.revokeSession({ wallet, signer, session: granted.publicKey, chainId: 97 });
  evidence.steps.revocation = { transactionHash: revoked.transactionHash ?? null, sessionPublicKey: granted.publicKey, revokedAt: nowIso() };
  log({ status: "session_revoked", ...evidence.steps.revocation });

  /* -- 16. prove the key is dead, spending nothing -- */
  let refusal;
  try {
    await client.execute({ session: granted, chainId: 97, calls: [{ to: V2_ROUTER, value: 0n, data: swapData }], feeToken: NATIVE });
    refusal = { refused: false, note: "A revoked session key still executed. This is a failure of the revocation guarantee." };
  } catch (error) {
    refusal = { refused: true, verdict: "REJECTED_BECAUSE_REVOKED", error: String(error?.message ?? error).slice(0, 300) };
  }
  const usdtFinal = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] });
  evidence.steps.revokedKeyRefused = { ...refusal, usdtUnchangedAfterAttempt: usdtFinal === usdtAfter, usdtFinalRaw: usdtFinal.toString() };
  log({ status: "revoked_key_checked", ...evidence.steps.revokedKeyRefused });

  /* -- 21. leave no standing approval -- */
  const residualBefore = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] });
  let clearTx = null;
  if (residualBefore > 0n) clearTx = await ownerSend("router_allowance_zeroed", { to: USDT, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [V2_ROUTER, 0n] }) });
  const residualAfter = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] });
  evidence.steps.allowanceCleared = { approvalTx, transaction: clearTx, residualAllowanceRaw: residualAfter.toString() };

  evidence.completedAt = nowIso();
  evidence.claimBoundary = {
    proves: ["a real on-chain bounded session", "a session-key transaction through an exact allowed method", "spend inside both caps", "user revocation", "a revoked key is refused"],
    doesNotProve: ["a profitable strategy", "a realistic testnet market price", "grid performance over time", "investment returns"],
  };

  await writeFile(path.join(stateDir, "altana-final-proof.json"), JSON.stringify({ ...evidence, hashes: contentHashes(evidence) }, null, 2) + "\n", "utf8");
  await writeFile(path.join(stateDir, "grid-session.json"), JSON.stringify({
    session: {
      entity: "AltanaSession", network: "bsc-testnet", chainId: 97,
      keyStore: network.keyStore, keyStoreController: network.keyStoreController, explorer: network.explorer,
      owner: ACTION_WALLET, walletAddress: granted.walletAddress,
      sessionPublicKey: granted.publicKey, grantTransactionHash: granted.transactionHash ?? null,
      expiry: granted.expiry, expiresAt: new Date(granted.expiry * 1000).toISOString(),
      permissions: evidence.steps.granted.permissions,
      strategyCaps: { perTransactionRaw: TRADE_HARD_MAX_RAW.toString(), sessionCapRaw: usdtCap.toString(), nativeFeeCapWei: nativeCap.toString(), maxFills: MAX_FILLS, maxSlippageBps: Number(MAX_SLIPPAGE_BPS) },
      executions: executionError === null ? [evidence.steps.execution] : [],
      revocationTransactionHash: revoked.transactionHash ?? null,
    },
    revoked: true,
  }, null, 2) + "\n", "utf8");
  await writeFile(path.join(stateDir, "grid-session-key.json"), JSON.stringify({ note: "The session was revoked. No key is retained.", retained: false }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });

  log({ status: "altana_final_proof_complete", executionSucceeded: executionError === null, revoked: true, revokedKeyRefused: refusal.refused, residualAllowanceRaw: residualAfter.toString(), secretOutput: "none" });
} finally { owner.destroy(); }
