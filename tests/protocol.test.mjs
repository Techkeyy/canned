import test from "node:test";
import assert from "node:assert/strict";
import { writeSafety } from "../src/protocol/erc8183-buyer.mjs";
import { negotiateA2A } from "../src/protocol/a2a.mjs";

test("mainnet or ambiguous write configuration fails closed", () => {
  assert.equal(writeSafety({ CANNED_NETWORK: "bsc-mainnet", CANNED_ALLOW_TESTNET_WRITES: "true", CANNED_EXECUTION_WALLET_PASSWORD: "x", CANNED_EXECUTION_WALLET_ADDRESS: "0xabc" }).safe, false);
  assert.equal(writeSafety({ CANNED_NETWORK: "bsc-testnet", CANNED_ALLOW_TESTNET_WRITES: "true" }).safe, false);
  assert.equal(writeSafety({ CANNED_NETWORK: "bsc-testnet", CANNED_ALLOW_TESTNET_WRITES: "false" }).safe, true);
});

test("A2A negotiation parser preserves quote and hashes", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: { parts: [{ kind: "data", data: { response: { accepted: true, price: "7", currency: "U" }, negotiation_hash: "0xneg", provider_sig: "0xsig" } }] } }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await negotiateA2A({ endpoint: "https://agent.example", taskDescription: "quote only", deliverables: "quote", qualityStandards: "no execution", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.quote.price, "7");
  assert.equal(result.negotiationHash, "0xneg");
  assert.match(result.requestHash, /^0x/);
});

test("A2A inventory consumers can read nested quote terms", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ jsonrpc: "2.0", result: { parts: [{ kind: "data", data: { response: { accepted: true, terms: { price: "100", currency: "U" } } } }] } }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await negotiateA2A({ endpoint: "https://agent.example", taskDescription: "quote only", deliverables: "quote", qualityStandards: "no execution", fetchImpl });
  assert.equal(result.accepted, true);
  assert.equal(result.quote.terms.price, "100");
  assert.equal(result.quote.terms.currency, "U");
});

test("ERC-8183 buyer blocks funding without explicit wallet configuration", async () => {
  const { createFundedJob } = await import("../src/protocol/erc8183-buyer.mjs");
  const result = await createFundedJob({
    agent: { identity: "agent:test", agentWallet: "0xprovider" },
    precommit: { runId: "run:test", manifestHash: "0xhash", benchmarkId: "bench", deadlineAtUnixSeconds: 2_000_000_000 },
    quote: { quote: { terms: { price: "100", currency: "U" } }, negotiationHash: "0xneg" },
    store: { saveJson: async () => {} },
    env: { CANNED_NETWORK: "bsc-testnet", CANNED_ALLOW_TESTNET_WRITES: "false" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "blocked");
});
