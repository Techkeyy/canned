import test from "node:test";
import assert from "node:assert/strict";
import {
  b402CredentialStatus,
  createHealthFactorX402Seller,
  healthFactorX402Work,
  parseHealthFactorX402Prompt,
  x402Status,
} from "../src/reference/health-factor-x402.mjs";

const recipient = "0xD885bd3eEa76c3bDE6B49D7A16D5BAa35ce2F1D7";

test("Health Guard x402 seller stays dormant without B402 merchant credentials", async () => {
  const created = await createHealthFactorX402Seller({
    walletAddress: recipient,
    resourceUrl: "http://localhost:8787/x402",
    env: {},
  });
  assert.ok(created.seller);
  assert.equal(created.seller.state, "dormant");
  assert.equal(created.status.available, false);
  assert.equal(created.status.chainId, 97);
  assert.equal(created.status.asset, "U");
  assert.equal(created.status.priceUsd, "0.0005");
  assert.equal(created.status.credentials.configured, false);
  const response = await created.seller.handle({ method: "POST", path: "/x402", headers: {}, body: JSON.stringify({ prompt: "{}" }) });
  assert.equal(response.status, 503);
  assert.match(response.body, /dormant/);
});

test("x402 price cap and recipient validation fail closed", async () => {
  const overCap = await createHealthFactorX402Seller({ walletAddress: recipient, resourceUrl: "http://localhost:8787/x402", priceUsd: "0.0011", env: {} });
  assert.equal(overCap.seller, null);
  assert.equal(overCap.status.state, "disabled");
  assert.match(overCap.status.reason, /cap/);
  const badRecipient = await createHealthFactorX402Seller({ walletAddress: "not-an-address", resourceUrl: "http://localhost:8787/x402", env: {} });
  assert.equal(badRecipient.seller, null);
  assert.equal(badRecipient.status.available, false);
  const mismatchedRecipient = await createHealthFactorX402Seller({ walletAddress: recipient, expectedRecipient: "0x1111111111111111111111111111111111111111", resourceUrl: "http://localhost:8787/x402", env: {} });
  assert.equal(mismatchedRecipient.seller, null);
  assert.match(mismatchedRecipient.status.reason, /must match/);
});

test("x402 work accepts the HealthBench task shape and never exposes a signer", () => {
  assert.deepEqual(parseHealthFactorX402Prompt("not json").errors, ["prompt_must_be_json"]);
  const output = JSON.parse(healthFactorX402Work({ prompt: JSON.stringify({ account: recipient, protocol: "venus" }) }));
  assert.equal(output.status, "INSUFFICIENT_AUTHORITATIVE_DATA");
  assert.equal(output.origin, "CANNED_REFERENCE");
  assert.equal(Object.hasOwn(output, "privateKey"), false);
});

test("credential status reports presence only, never credential values", () => {
  const status = b402CredentialStatus({ B402_BASE_URL: "https://merchant.example", B402_CLIENT_ID: "client", B402_ACCESS_TOKEN: "token", B402_PRIVATE_KEY_B64: "secret" });
  assert.equal(status.configured, true);
  assert.deepEqual(status.present, { B402_BASE_URL: true, B402_CLIENT_ID: true, B402_ACCESS_TOKEN: true, B402_PRIVATE_KEY: true });
  assert.deepEqual(x402Status({ recipient, env: {} }).credentials.present, { B402_BASE_URL: false, B402_CLIENT_ID: false, B402_ACCESS_TOKEN: false, B402_PRIVATE_KEY: false });
});
