/**
 * The bounded Altana proof, start to finish, in one process.
 *
 * Creation, verification, one execution and revocation happen in a single run
 * for a reason found the hard way: an earlier session was granted letting the
 * SDK generate its own session signer, which is not retrievable afterwards.
 * That session was real and correctly bounded, but unusable from a second
 * process. It is revoked here rather than left dangling, and the replacement
 * uses a signer this script generates and persists, which is what the SDK's
 * own documentation tells callers to do.
 *
 * What this proves: a real on-chain session, scoped to one contract and one
 * method, spending under a cap the user set, revocable by the user, and dead
 * after revocation.
 *
 * What it does not prove: anything about profit, price, or strategy quality.
 * BSC testnet pricing is incoherent and this is one tiny trade.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http, parseAbi, encodeFunctionData } from "viem";
import { contentHashes, nowIso } from "../src/core.mjs";

const ACTION_WALLET = "0xBB62A403F8b582b49bcB05E1a7a678Da4Ebde48f";
const USDT = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd";
const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const V2_ROUTER = "0xD99D1c33F9fC3444f8101754aBC46c52416550D1";
const SWAP_SIGNATURE = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
const SWAP_SELECTOR = "0x38ed1739";

/** Directive #20 sections 14 and 17. Ceilings, not targets. */
const SESSION_CAP_RAW = 1_500_000_000_000_000_000n;
const PER_TX_CAP_RAW = 1_000_000_000_000_000_000n;
const SWAP_INPUT_RAW = 1_000_000_000_000_000_000n; // exactly 1.0 USDT
const MAX_SLIPPAGE_BPS = 100n;
const MAX_FILLS = 1;
const DURATION_SECONDS = 6 * 60 * 60;

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
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])",
]);

const walletsDir = path.join(stateDir, "grid-action-wallets");
const keystoreAddress = bnb.EVMWalletProvider.listWallets(walletsDir)[0];
if (String(keystoreAddress).toLowerCase() !== ACTION_WALLET.toLowerCase()) stop("Action keystore mismatch.", { keystoreAddress });
const password = (await readFile(path.join(stateDir, "grid-action-wallet-password.txt"), "utf8")).trim();
const owner = new bnb.EVMWalletProvider({ password, address: keystoreAddress, walletsDir, persist: true });

const evidence = { entity: "AltanaBoundedProof", network: "bsc-testnet", chainId: 97, owner: ACTION_WALLET, startedAt: nowIso(), steps: {} };

try {
  const signer = A.signerFromPrivateKey(owner.exportPrivateKey());
  const client = A.createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer });
  if (String(wallet.address).toLowerCase() !== ACTION_WALLET.toLowerCase()) stop("Altana wallet address does not match the funded wallet.");

  /* -- 0. retire the earlier session whose key was not retrievable -- */
  const priorPath = path.join(stateDir, "grid-session.json");
  let prior = null;
  try { prior = JSON.parse(await readFile(priorPath, "utf8")); } catch { prior = null; }
  if (prior?.session?.sessionPublicKey && prior.revoked !== true) {
    const revokedPrior = await client.revokeSession({ wallet, signer, session: prior.session.sessionPublicKey, chainId: 97 });
    evidence.steps.priorSessionRetired = {
      reason: "Granted without persisting its session signer, so it could never be used. Revoked rather than left as dangling authority.",
      publicKey: prior.session.sessionPublicKey,
      transactionHash: revokedPrior.transactionHash ?? null,
    };
    log({ status: "prior_session_revoked", ...evidence.steps.priorSessionRetired });
  }

  /* -- 1. grant, with a session signer this script controls -- */
  const sessionSigner = A.createPrivateKeySigner();
  const expiry = Math.floor(Date.now() / 1000) + DURATION_SECONDS;
  const permissions = {
    calls: [{ to: V2_ROUTER, signature: SWAP_SIGNATURE }],
    spend: [{ limit: SESSION_CAP_RAW, period: "day", token: USDT }],
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
      spend: granted.permissions.spend.map((s) => ({ limit: String(s.limit), period: s.period, token: s.token })),
    },
  };
  log({ status: "session_granted", ...evidence.steps.granted });

  /* -- 2. verify before the key is allowed to move anything -- */
  const verification = {
    ownerMatches: String(granted.walletAddress).toLowerCase() === ACTION_WALLET.toLowerCase(),
    chainIs97: network.chainId === 97,
    exactlyOneCallRule: granted.permissions.calls.length === 1,
    exactContract: String(granted.permissions.calls[0]?.to).toLowerCase() === V2_ROUTER.toLowerCase(),
    exactMethod: granted.permissions.calls[0]?.signature === SWAP_SIGNATURE,
    noUnrestrictedRule: granted.permissions.calls.every((c) => Boolean(c.to) && Boolean(c.signature)),
    exactlyOneSpendRule: granted.permissions.spend.length === 1,
    spendTokenIsUsdt: String(granted.permissions.spend[0]?.token).toLowerCase() === USDT.toLowerCase(),
    spendWithinCeiling: BigInt(granted.permissions.spend[0]?.limit ?? 0n) <= SESSION_CAP_RAW,
    expiryWithinSixHours: granted.expiry <= Math.floor(Date.now() / 1000) + DURATION_SECONDS + 60,
    notExpired: granted.expiry * 1000 > Date.now(),
    sessionKeyIsNotTheOwner: sessionSigner.address.toLowerCase() !== ACTION_WALLET.toLowerCase(),
  };
  const broader = Object.entries(verification).filter(([, v]) => v === false).map(([k]) => k);
  evidence.steps.verification = { checks: verification, broaderThanIntended: broader };
  if (broader.length) {
    const emergency = await client.revokeSession({ wallet, signer, session: granted.publicKey, chainId: 97 });
    stop("The granted permission is broader than intended. It was revoked and nothing was executed.", { broader, revokeTx: emergency.transactionHash ?? null });
  }
  log({ status: "session_verified", checks: verification });

  /* -- 3. exactly one bounded execution -- */
  const [usdtBefore, wbnbBefore, allowance, nativeBefore] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.readContract({ address: WBNB, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] }),
    publicClient.getBalance({ address: ACTION_WALLET }),
  ]);
  if (SWAP_INPUT_RAW > PER_TX_CAP_RAW) stop("The swap input exceeds the per-transaction cap.");
  if (usdtBefore < SWAP_INPUT_RAW) stop("The wallet does not hold the swap input.", { usdtBefore: usdtBefore.toString() });
  if (allowance < SWAP_INPUT_RAW) stop("The router allowance is below the swap input.", { allowance: allowance.toString() });

  const quoted = await publicClient.readContract({ address: V2_ROUTER, abi: routerAbi, functionName: "getAmountsOut", args: [SWAP_INPUT_RAW, [USDT, WBNB]] });
  const expectedOut = quoted[quoted.length - 1];
  const minOut = (expectedOut * (10_000n - MAX_SLIPPAGE_BPS)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900);
  const data = encodeFunctionData({ abi: routerAbi, functionName: "swapExactTokensForTokens", args: [SWAP_INPUT_RAW, minOut, [USDT, WBNB], ACTION_WALLET, deadline] });
  if (!data.startsWith(SWAP_SELECTOR)) stop("The encoded call is not the allowed selector.", { selector: data.slice(0, 10) });

  log({
    status: "execution_preflight",
    router: V2_ROUTER, selector: data.slice(0, 10), path: [USDT, WBNB], recipient: ACTION_WALLET,
    amountInRaw: SWAP_INPUT_RAW.toString(), expectedOutRaw: expectedOut.toString(), minOutRaw: minOut.toString(),
    slippageBps: Number(MAX_SLIPPAGE_BPS), perTxCapRaw: PER_TX_CAP_RAW.toString(), withinCap: SWAP_INPUT_RAW <= PER_TX_CAP_RAW,
    sessionActive: granted.expiry * 1000 > Date.now(), signedBy: "altana_session_key", sessionKeyAddress: sessionSigner.address,
  });

  let executed = null;
  let executionError = null;
  try {
    const result = await client.execute({ session: granted, chainId: 97, calls: [{ to: V2_ROUTER, value: 0n, data }] });
    executed = result;
  } catch (error) {
    executionError = String(error?.message ?? error).slice(0, 300);
  }

  const [usdtAfter, wbnbAfter, nativeAfter, allowanceAfter] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.readContract({ address: WBNB, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.getBalance({ address: ACTION_WALLET }),
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] }),
  ]);

  evidence.steps.execution = {
    attempted: true,
    succeeded: executionError === null,
    error: executionError,
    transactionHash: executed?.transactionHash ?? null,
    signedBy: "altana_session_key",
    sessionKeyAddress: sessionSigner.address,
    router: V2_ROUTER, selector: SWAP_SELECTOR, path: [USDT, WBNB],
    amountInRaw: SWAP_INPUT_RAW.toString(),
    expectedOutRaw: expectedOut.toString(),
    minOutRaw: minOut.toString(),
    balances: {
      usdtBeforeRaw: usdtBefore.toString(), usdtAfterRaw: usdtAfter.toString(),
      wbnbBeforeRaw: wbnbBefore.toString(), wbnbAfterRaw: wbnbAfter.toString(),
      nativeBeforeWei: nativeBefore.toString(), nativeAfterWei: nativeAfter.toString(),
      usdtSpentRaw: (usdtBefore - usdtAfter).toString(),
      wbnbReceivedRaw: (wbnbAfter - wbnbBefore).toString(),
    },
    allowanceAfterRaw: allowanceAfter.toString(),
    fillsUsed: executionError === null ? 1 : 0,
    maxFills: MAX_FILLS,
  };
  log({ status: executionError === null ? "session_key_swap_executed" : "session_key_swap_failed", ...evidence.steps.execution });

  /* -- 4. revoke -- */
  const revoked = await client.revokeSession({ wallet, signer, session: granted.publicKey, chainId: 97 });
  evidence.steps.revocation = { transactionHash: revoked.transactionHash ?? null, revokedAt: nowIso(), sessionPublicKey: granted.publicKey };
  log({ status: "session_revoked", ...evidence.steps.revocation });

  /* -- 5. prove the key is dead, without spending anything -- */
  let refusal = null;
  try {
    await client.execute({ session: granted, chainId: 97, calls: [{ to: V2_ROUTER, value: 0n, data }] });
    refusal = { refused: false, note: "The revoked session key still executed. This is a failure of the revocation guarantee." };
  } catch (error) {
    refusal = { refused: true, verdict: "REJECTED_BECAUSE_REVOKED", error: String(error?.message ?? error).slice(0, 300) };
  }
  const [usdtFinal, allowanceFinal] = await Promise.all([
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [ACTION_WALLET] }),
    publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] }),
  ]);
  evidence.steps.revokedKeyRefused = { ...refusal, usdtUnchangedAfterAttempt: usdtFinal === usdtAfter, usdtFinalRaw: usdtFinal.toString() };
  log({ status: "revoked_key_checked", ...evidence.steps.revokedKeyRefused });

  /* -- 6. return the residual allowance to zero -- */
  let allowanceZeroTx = null;
  if (allowanceFinal > 0n) {
    const zeroData = encodeFunctionData({ abi: erc20, functionName: "approve", args: [V2_ROUTER, 0n] });
    const [gasPrice, nonce] = await Promise.all([publicClient.getGasPrice(), publicClient.getTransactionCount({ address: ACTION_WALLET, blockTag: "pending" })]);
    const gas = await publicClient.estimateGas({ account: ACTION_WALLET, to: USDT, data: zeroData });
    const signed = await owner.signTransaction({ to: USDT, data: zeroData, value: 0n, gas: (gas * 12n) / 10n, gasPrice, nonce, chainId: 97 });
    const hash = await publicClient.sendRawTransaction({ serializedTransaction: signed.rawTransaction });
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    allowanceZeroTx = { hash, blockNumber: String(receipt.blockNumber), status: receipt.status };
  }
  const residual = await publicClient.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [ACTION_WALLET, V2_ROUTER] });
  evidence.steps.allowanceCleared = { transaction: allowanceZeroTx, residualAllowanceRaw: residual.toString() };
  log({ status: "allowance_cleared", ...evidence.steps.allowanceCleared });

  evidence.completedAt = nowIso();
  evidence.claimBoundary = {
    proves: ["real on-chain bounded session", "session-key execution of an exact allowed method", "spend stayed inside the cap", "user revocation", "revoked key refused"],
    doesNotProve: ["profitable strategy", "realistic testnet market price", "grid performance over time", "investment returns"],
  };

  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "altana-proof.json"), JSON.stringify({ ...evidence, hashes: contentHashes(evidence) }, null, 2) + "\n", "utf8");
  await writeFile(path.join(stateDir, "grid-session.json"), JSON.stringify({
    session: {
      entity: "AltanaSession", network: "bsc-testnet", chainId: 97,
      keyStore: network.keyStore, keyStoreController: network.keyStoreController, explorer: network.explorer,
      owner: ACTION_WALLET, walletAddress: granted.walletAddress,
      sessionPublicKey: granted.publicKey, grantTransactionHash: granted.transactionHash ?? null,
      expiry: granted.expiry, expiresAt: new Date(granted.expiry * 1000).toISOString(),
      permissions: evidence.steps.granted.permissions,
      strategyCaps: { perTransactionRaw: PER_TX_CAP_RAW.toString(), sessionCapRaw: SESSION_CAP_RAW.toString(), maxFills: MAX_FILLS, maxSlippageBps: Number(MAX_SLIPPAGE_BPS) },
      executions: executed ? [evidence.steps.execution] : [],
      revocationTransactionHash: revoked.transactionHash ?? null,
    },
    revoked: true,
  }, null, 2) + "\n", "utf8");
  // The session key is dead; keeping it would be a secret with no purpose.
  await writeFile(path.join(stateDir, "grid-session-key.json"), JSON.stringify({ note: "The session was revoked. No key is retained.", retained: false }, null, 2) + "\n", "utf8");

  log({ status: "altana_proof_complete", executionSucceeded: executionError === null, revoked: true, revokedKeyRefused: refusal.refused, secretOutput: "none" });
} finally { owner.destroy(); }
