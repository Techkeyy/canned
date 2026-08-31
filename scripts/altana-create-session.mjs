/**
 * Retired historical session-creation helper.
 *
 * This file intentionally contains no wallet, signer, relay, transaction, or
 * filesystem code. The old helper could leave session signing material in
 * data/state and did not own the complete grant-to-revoke lifecycle. Keeping
 * it as a fail-closed shim prevents an accidental rerun from creating an
 * authority that this process cannot safely finish and discard.
 *
 * The completed Directive #21 evidence remains in data/state and is not
 * regenerated here. Any future value-bearing lifecycle needs a new explicit
 * authorization and a single-process implementation that holds its signer
 * only in memory until revocation confirms.
 */
const result = {
  status: "blocked",
  reason: "retired_session_creation_helper",
  message: "No session lifecycle is created by this historical helper.",
  replacement: "scripts/altana-final-proof.mjs",
  writesAttempted: false,
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = 2;
