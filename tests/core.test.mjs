import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, contentHashes } from "../src/core.mjs";

test("canonical JSON sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ b: 2, a: 1, nested: { z: true, y: false } }), '{"a":1,"b":2,"nested":{"y":false,"z":true}}');
});

test("canonical hashes are stable", () => {
  assert.deepEqual(contentHashes({ b: 2, a: 1 }), contentHashes({ a: 1, b: 2 }));
});
