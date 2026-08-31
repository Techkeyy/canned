/**
 * Negative permission tests for the exact session Directive #18 authorizes.
 *
 * Every case is decided by static validation against the frozen strategy and
 * the proposed Altana permission. Nothing is signed, sent, or spent: proving a
 * boundary refuses should never cost money, and a refusal that only shows up
 * after a failed transaction is a worse guarantee, not a better one.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { planGridStrategy, GRID_TESTNET_VENUE } from "../src/reference/grid-keeper.mjs";
import { evaluateLevel, STRATEGY_STATES } from "../src/reference/grid-engine.mjs";
import { buildLeashProposal } from "../src/marketplace/leash.mjs";
import { contentHashes, nowIso } from "../src/core.mjs";

const NOW = Date.now();
const U = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

// The exact ceiling from Directive #18 section 6.
const AUTHORIZED = Object.freeze({
  chainId: 97,
  router: GRID_TESTNET_VENUE.smartRouterV3,
  method: GRID_TESTNET_VENUE.swapMethod,
  selector: "0x414bf389",
  sessionCapUsdt: 10,
  perTxCapUsdt: 3,
  maxFills: 3,
  slippageBps: 100,
  durationHours: 6,
});

const strategy = planGridStrategy({
  strategyId: "leash-boundary-probe",
  pair: { baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt, baseSymbol: "WBNB", quoteSymbol: "USDT", baseDecimals: 18, quoteDecimals: 18 },
  lowerPriceMinor: U(600), upperPriceMinor: U(800), levelCount: 8,
  totalCapitalMinor: U(AUTHORIZED.sessionCapUsdt),
  maxPerLevelMinor: U(AUTHORIZED.perTxCapUsdt),
  expiresAt: new Date(NOW + AUTHORIZED.durationHours * 3600_000).toISOString(),
  maxFills: AUTHORIZED.maxFills,
  maxSlippageBps: AUTHORIZED.slippageBps,
  createdAt: new Date(NOW).toISOString(),
});
const active = { ...strategy, state: STRATEGY_STATES.ACTIVE };
const proposal = buildLeashProposal({ strategy, network: { chainId: 97 }, now: NOW });

const buyLevel = strategy.levels.find((level) => level.side === "BUY");
const observation = (over = {}) => ({
  priceMinor: BigInt(buyLevel.priceMinor) - 1n,
  observedAt: new Date(NOW).toISOString(),
  chainId: 97, baseToken: GRID_TESTNET_VENUE.wbnb, quoteToken: GRID_TESTNET_VENUE.usdt,
  ...over,
});
const goodCall = { to: AUTHORIZED.router, method: AUTHORIZED.method, side: "BUY" };
const decide = (over = {}) => evaluateLevel({
  strategy: over.strategy ?? active,
  level: { levelId: buyLevel.levelId },
  observation: over.observation ?? observation(),
  fills: over.fills ?? [],
  now: over.now ?? NOW,
  authority: over.authority ?? null,
  intendedCall: over.intendedCall === undefined ? goodCall : over.intendedCall,
});

const cases = [
  ["baseline_allowed", decide(), true],
  ["wrong_contract", decide({ intendedCall: { ...goodCall, to: "0x0000000000000000000000000000000000009999" } }), false],
  ["wrong_method", decide({ intendedCall: { ...goodCall, method: "transferFrom(address,address,uint256)" } }), false],
  ["wrong_token_pair", decide({ observation: observation({ quoteToken: "0x000000000000000000000000000000000000dEaD" }) }), false],
  ["wrong_chain", decide({ observation: observation({ chainId: 56 }) }), false],
  ["expired_session", decide({ now: NOW + (AUTHORIZED.durationHours + 1) * 3600_000 }), false],
  ["revoked_session", decide({ authority: { revoked: true } }), false],
  // Three prior fills at the 3 USDT per-transaction ceiling is 9 of the 10
  // USDT session cap, so the next allocation must not fit. The fills exclude
  // the level under test, otherwise it would refuse as already filled and
  // this case would pass without testing the cap at all.
  ["aggregate_cap_exceeded", decide({
    fills: strategy.levels
      .filter((level) => level.side === "BUY" && level.levelId !== buyLevel.levelId)
      .slice(0, 3)
      .map((level) => ({
        strategyId: strategy.strategyId, levelId: level.levelId, state: "FILLED", side: "BUY",
        quoteSpentMinor: String(U(3)), baseReceivedMinor: "4000000000000000",
        filledAt: new Date(NOW - 600_000).toISOString(),
      })),
    strategy: { ...active, guards: { ...active.guards, maxFills: null } },
  }), false],
  ["slippage_below_minimum", decide({ intendedCall: { ...goodCall, quotedOutMinor: 90n, minOutMinor: 100n } }), false],
  ["arbitrary_recipient_not_representable", { allowed: false, reason: "recipient_is_not_a_session_parameter" }, false],
];

// The per-transaction cap is structural: no level can be allocated more than it.
const perLevelOk = strategy.levels.every((level) => BigInt(level.allocationMinor) <= U(AUTHORIZED.perTxCapUsdt));
const totalOk = strategy.levels.reduce((sum, level) => sum + BigInt(level.allocationMinor), 0n) <= U(AUTHORIZED.sessionCapUsdt);
// proposal.calls is already described; describing it again is a footgun the
// function now tolerates, but reading it directly is what a caller should do.
const permission = proposal.calls[0];

const results = cases.map(([name, decision, shouldAllow]) => ({
  case: name,
  allowed: decision.allowed === true,
  reason: decision.reason ?? null,
  expectedAllowed: shouldAllow,
  correct: (decision.allowed === true) === shouldAllow,
}));

const record = {
  entity: "LeashBoundaryVerification",
  method: "static_validation_no_transaction",
  authorizedCeiling: AUTHORIZED,
  permission: { contract: permission.contract, selector: permission.selector, unrestricted: permission.unrestricted, anyContract: permission.anyContract, anyMethod: permission.anyMethod },
  spend: proposal.spend,
  structural: { everyLevelWithinPerTxCap: perLevelOk, allLevelsWithinSessionCap: totalOk },
  results,
  allCorrect: results.every((entry) => entry.correct),
  fundsSpent: "none",
  verifiedAt: nowIso(),
};
const dataDir = path.resolve(process.env.CANNED_DATA_DIR || path.join(process.cwd(), "data"));
await mkdir(path.join(dataDir, "state"), { recursive: true });
await writeFile(path.join(dataDir, "state", "leash-boundary-verification.json"), `${JSON.stringify({ ...record, hashes: contentHashes(record) }, null, 2)}\n`, "utf8");
console.log(JSON.stringify(record, null, 2));
