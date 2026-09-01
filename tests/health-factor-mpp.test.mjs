import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HEALTH_FACTOR_MPP_CHAIN_ID,
  HEALTH_FACTOR_MPP_CREDENTIAL_TYPES,
  HEALTH_FACTOR_MPP_MAX_PRICE_RAW,
  HEALTH_FACTOR_MPP_NETWORK,
  HEALTH_FACTOR_MPP_PRICE_RAW,
  HEALTH_FACTOR_MPP_TOKEN,
  mppTokenMetadata,
  publicMppEvidence,
} from "../src/reference/health-factor-mpp.mjs";
import { FileMppReplayStore } from "../src/reference/mpp-replay-store.mjs";

test("MPP Health Guard is pinned to the official BSC Testnet TEST_USDT preset", () => {
  assert.equal(HEALTH_FACTOR_MPP_NETWORK, "bsc-testnet");
  assert.equal(HEALTH_FACTOR_MPP_CHAIN_ID, 97);
  assert.equal(HEALTH_FACTOR_MPP_TOKEN, "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd");
  assert.equal(HEALTH_FACTOR_MPP_PRICE_RAW, "10000000000000000");
  assert.equal(HEALTH_FACTOR_MPP_MAX_PRICE_RAW, "20000000000000000");
  assert.deepEqual(HEALTH_FACTOR_MPP_CREDENTIAL_TYPES, ["transaction", "hash"]);
  assert.deepEqual(mppTokenMetadata(), {
    address: HEALTH_FACTOR_MPP_TOKEN,
    symbol: "USDT",
    name: "USDT Token",
    decimals: 18,
    network: "bsc-testnet",
    chainId: 97,
  });
});

test("FileMppReplayStore atomically admits only one concurrent update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canned-mpp-replay-"));
  try {
    const store = await new FileMppReplayStore(root).init();
    const results = await Promise.all(Array.from({ length: 24 }, () => store.update("tx:0xabc", (current) => current
      ? { op: "noop", result: false }
      : { op: "set", value: { state: "reserved" }, result: true })));
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(await store.get("tx:0xabc"), { state: "reserved" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public MPP evidence omits payer and raw credential material", () => {
  const evidence = publicMppEvidence({
    protocol: "MPP",
    notX402: true,
    notB402: true,
    payer: "0xprivate-public-but-unneeded",
    transactionHash: "0xabc",
    token: { address: HEALTH_FACTOR_MPP_TOKEN, symbol: "USDT", decimals: 18, privateField: "omit" },
    independentReceipt: { status: "success", exactTransferEvents: 1, rpc: "https://example.invalid", rawReceipt: "omit" },
    paymentReceipt: { originalHeaderRetained: false, reason: "not retained", rawHeader: "omit" },
  });
  assert.equal(evidence.transactionHash, "0xabc");
  assert.equal("payer" in evidence, false);
  assert.equal("rawHeader" in evidence.paymentReceipt, false);
  assert.equal("privateField" in evidence.token, false);
  assert.equal("rawReceipt" in evidence.independentReceipt, false);
});

test("FileMppReplayStore persists committed values with restrictive file permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canned-mpp-replay-"));
  try {
    const store = await new FileMppReplayStore(root).init();
    await store.put("payment-receipt", { status: "settled", amount: HEALTH_FACTOR_MPP_PRICE_RAW });
    const persisted = await readFile(store.fileFor("payment-receipt"), "utf8");
    assert.deepEqual(JSON.parse(persisted), { status: "settled", amount: HEALTH_FACTOR_MPP_PRICE_RAW });
    if (process.platform !== "win32") {
      const { mode } = await stat(store.fileFor("payment-receipt"));
      assert.equal(mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
