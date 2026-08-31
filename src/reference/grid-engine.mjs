/**
 * Grid strategy arithmetic and state machine.
 *
 * A grid strategy divides a price range into levels and buys lower / sells
 * higher as price crosses them. Everything here is pure: given a strategy, a
 * price observation and the fills so far, it decides what may happen next. It
 * holds no keys, signs nothing, and reaches no network. That separation is
 * what makes the decision auditable and the tests free.
 *
 * The engine's job is to say no. Almost every function here exists to refuse
 * an action: a level already filled, a session expired, a cap exhausted, a
 * price too stale to trust. An execution path that only knew how to say yes
 * would be a much shorter file and a much worse product.
 *
 * Money is integer minor units throughout. A grid that computed capital in
 * floating point would drift, and drift in a spending cap is a bug that costs
 * real funds.
 */
import { contentHashes } from "../core.mjs";

export const GRID_ENGINE_VERSION = "grid-engine-v1";

/**
 * Strategy lifecycle. A strategy moves forward only; there is no path back to
 * ACTIVE from a terminal state, because re-arming a revoked or expired
 * strategy is precisely the escalation this design exists to prevent.
 */
export const STRATEGY_STATES = Object.freeze({
  CREATED: "CREATED",
  ARMED: "ARMED",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
});

export const TERMINAL_STRATEGY_STATES = Object.freeze([
  STRATEGY_STATES.EXPIRED,
  STRATEGY_STATES.REVOKED,
  STRATEGY_STATES.COMPLETED,
  STRATEGY_STATES.FAILED,
]);

/** Per-level lifecycle. A level is the unit that can be filled exactly once. */
export const LEVEL_STATES = Object.freeze({
  ARMED: "ARMED",
  TRIGGERED: "LEVEL_TRIGGERED",
  PENDING: "EXECUTION_PENDING",
  FILLED: "FILLED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
});

export const SIDES = Object.freeze({ BUY: "BUY", SELL: "SELL" });

export const GRID_REFUSALS = Object.freeze({
  NOT_ACTIVE: "strategy_is_not_active",
  EXPIRED: "strategy_expired",
  REVOKED: "authority_revoked",
  LEVEL_UNKNOWN: "level_not_in_strategy",
  LEVEL_NOT_ARMED: "level_is_not_armed",
  ALREADY_FILLED: "level_already_filled",
  NOT_TRIGGERED: "price_has_not_reached_this_level",
  TOTAL_CAP: "total_capital_cap_would_be_exceeded",
  PER_LEVEL_CAP: "per_level_cap_would_be_exceeded",
  MAX_FILLS: "maximum_fill_count_reached",
  COOLDOWN: "cooldown_has_not_elapsed",
  STALE_PRICE: "price_observation_is_too_old",
  NO_PRICE: "no_price_observation",
  SLIPPAGE: "quoted_output_is_below_the_minimum",
  WRONG_PAIR: "pair_does_not_match_the_strategy",
  WRONG_CHAIN: "chain_does_not_match_the_strategy",
  WRONG_CONTRACT: "target_contract_is_not_allowed",
  WRONG_METHOD: "method_is_not_allowed",
  WRONG_DIRECTION: "side_does_not_match_the_level",
  INSUFFICIENT_INVENTORY: "not_enough_inventory_to_sell",
});

/* ------------------------------------------------------------------ config */

export const GRID_LIMITS = Object.freeze({
  minLevels: 2,
  maxLevels: 50,
  minPriceMinorUnits: 1n,
  maxSlippageBps: 1000,     // 10%. Above this a "grid" is just a market order.
  maxPriceAgeMsCeiling: 15 * 60 * 1000,
});

function asBigInt(value, field) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`${field} must be an integer amount in minor units.`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw new Error(`${field} must be an integer amount in minor units.`);
}

/* -------------------------------------------------------------- arithmetic */

/**
 * Build the price levels of a grid.
 *
 * `arithmetic` spaces levels by equal price difference; `geometric` spaces
 * them by equal ratio, which is what most grid traders actually want because
 * a fixed percentage step means each level risks a comparable amount.
 *
 * Levels are returned lowest first, and each carries an immutable id derived
 * from the strategy and its own index. The id is what makes a fill
 * non-repeatable: two runs of this function over the same strategy produce
 * the same ids, so a fill recorded earlier is still recognised later.
 */
export function buildGridLevels({ strategyId, lowerPriceMinor, upperPriceMinor, levelCount, spacing = "arithmetic", referencePriceMinor = null }) {
  const lower = asBigInt(lowerPriceMinor, "lowerPriceMinor");
  const upper = asBigInt(upperPriceMinor, "upperPriceMinor");
  if (lower < GRID_LIMITS.minPriceMinorUnits) throw new Error("lowerPriceMinor must be positive.");
  if (upper <= lower) throw new Error("upperPriceMinor must be above lowerPriceMinor.");
  if (!Number.isInteger(levelCount) || levelCount < GRID_LIMITS.minLevels || levelCount > GRID_LIMITS.maxLevels) {
    throw new Error(`levelCount must be an integer between ${GRID_LIMITS.minLevels} and ${GRID_LIMITS.maxLevels}.`);
  }
  if (spacing !== "arithmetic" && spacing !== "geometric") throw new Error("spacing must be arithmetic or geometric.");

  const prices = [];
  if (spacing === "arithmetic") {
    const span = upper - lower;
    const steps = BigInt(levelCount - 1);
    for (let index = 0; index < levelCount; index += 1) {
      prices.push(lower + (span * BigInt(index)) / steps);
    }
  } else {
    // Ratio spacing in integer arithmetic: price_i = lower * (upper/lower)^(i/n).
    // Computed in floating point then rounded, because an exact integer nth
    // root is not worth the complexity here; the rounding is recorded rather
    // than hidden, and levels are asserted strictly increasing below.
    const ratio = Number(upper) / Number(lower);
    for (let index = 0; index < levelCount; index += 1) {
      const factor = Math.pow(ratio, index / (levelCount - 1));
      prices.push(BigInt(Math.round(Number(lower) * factor)));
    }
    prices[0] = lower;
    prices[prices.length - 1] = upper;
  }

  for (let index = 1; index < prices.length; index += 1) {
    if (prices[index] <= prices[index - 1]) {
      throw new Error("Grid levels collapsed: widen the range or reduce levelCount.");
    }
  }

  // A level below the reference price is where the strategy buys; above, it
  // sells. With no reference, the midpoint splits the grid.
  const reference = referencePriceMinor === null ? (lower + upper) / 2n : asBigInt(referencePriceMinor, "referencePriceMinor");

  return prices.map((priceMinor, index) => ({
    levelId: `${strategyId}:L${String(index).padStart(2, "0")}`,
    index,
    priceMinor,
    side: priceMinor < reference ? SIDES.BUY : SIDES.SELL,
    state: LEVEL_STATES.ARMED,
  }));
}

/**
 * Allocate capital across levels.
 *
 * The remainder from integer division is dropped rather than spread, so the
 * sum of per-level allocations is never more than the total cap. Being a few
 * minor units under the cap is harmless; being over it is a broken promise.
 */
export function allocateCapital({ levels, totalCapitalMinor, maxPerLevelMinor = null }) {
  const total = asBigInt(totalCapitalMinor, "totalCapitalMinor");
  if (total <= 0n) throw new Error("totalCapitalMinor must be positive.");
  const buyLevels = levels.filter((level) => level.side === SIDES.BUY);
  const share = buyLevels.length ? total / BigInt(buyLevels.length) : 0n;
  const cap = maxPerLevelMinor === null ? share : asBigInt(maxPerLevelMinor, "maxPerLevelMinor");
  const perLevel = share < cap ? share : cap;
  if (buyLevels.length && perLevel <= 0n) throw new Error("Capital per level rounds to zero: raise the cap or reduce levelCount.");
  return levels.map((level) => ({ ...level, allocationMinor: level.side === SIDES.BUY ? perLevel : 0n }));
}

/* ---------------------------------------------------------------- strategy */

/**
 * Freeze a strategy.
 *
 * Everything an execution will later be checked against is fixed here and
 * hashed, so a strategy cannot be widened after the fact. The hash is the
 * thing a user is really approving when they approve The Leash.
 */
export function createStrategy({
  strategyId, chainId, pair, lowerPriceMinor, upperPriceMinor, levelCount,
  totalCapitalMinor, maxPerLevelMinor = null, spacing = "arithmetic",
  expiresAt, maxFills = null, cooldownMs = 0, maxSlippageBps = 100,
  maxPriceAgeMs = 120_000, allowedContracts = [], allowedMethods = [],
  referencePriceMinor = null, createdAt = new Date().toISOString(),
}) {
  if (!strategyId) throw new Error("A strategy requires an id.");
  if (!Number.isInteger(chainId)) throw new Error("A strategy requires a chainId.");
  if (!pair?.baseToken || !pair?.quoteToken) throw new Error("A strategy requires a base and quote token.");
  if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) throw new Error("A strategy requires an expiry.");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps > GRID_LIMITS.maxSlippageBps) {
    throw new Error(`maxSlippageBps must be between 0 and ${GRID_LIMITS.maxSlippageBps}.`);
  }
  if (!Number.isInteger(maxPriceAgeMs) || maxPriceAgeMs <= 0 || maxPriceAgeMs > GRID_LIMITS.maxPriceAgeMsCeiling) {
    throw new Error("maxPriceAgeMs must be positive and no more than 15 minutes.");
  }
  if (!allowedContracts.length) throw new Error("A strategy must name the contracts it may call.");
  if (!allowedMethods.length) throw new Error("A strategy must name the methods it may call.");

  const built = buildGridLevels({ strategyId, lowerPriceMinor, upperPriceMinor, levelCount, spacing, referencePriceMinor });
  const levels = allocateCapital({ levels: built, totalCapitalMinor, maxPerLevelMinor });

  const strategy = {
    entity: "GridStrategy",
    engineVersion: GRID_ENGINE_VERSION,
    strategyId,
    state: STRATEGY_STATES.CREATED,
    chainId,
    pair: {
      baseToken: String(pair.baseToken).toLowerCase(),
      quoteToken: String(pair.quoteToken).toLowerCase(),
      baseSymbol: pair.baseSymbol ?? null,
      quoteSymbol: pair.quoteSymbol ?? null,
      baseDecimals: pair.baseDecimals ?? 18,
      quoteDecimals: pair.quoteDecimals ?? 18,
    },
    range: { lowerPriceMinor: String(asBigInt(lowerPriceMinor, "lowerPriceMinor")), upperPriceMinor: String(asBigInt(upperPriceMinor, "upperPriceMinor")), levelCount, spacing },
    capital: {
      totalCapitalMinor: String(asBigInt(totalCapitalMinor, "totalCapitalMinor")),
      maxPerLevelMinor: maxPerLevelMinor === null ? null : String(asBigInt(maxPerLevelMinor, "maxPerLevelMinor")),
    },
    guards: { maxFills, cooldownMs, maxSlippageBps, maxPriceAgeMs, expiresAt },
    authority: {
      allowedContracts: allowedContracts.map((address) => String(address).toLowerCase()),
      allowedMethods: [...allowedMethods],
    },
    levels: levels.map((level) => ({ ...level, priceMinor: String(level.priceMinor), allocationMinor: String(level.allocationMinor) })),
    createdAt,
  };
  return { ...strategy, hashes: contentHashes(strategy) };
}

/* ----------------------------------------------------------------- ledger */

/** The running position, derived from fills rather than stored and trusted. */
export function deriveLedger(strategy, fills = []) {
  const applied = fills.filter((fill) => fill.strategyId === strategy.strategyId && fill.state === LEVEL_STATES.FILLED);
  let spentMinor = 0n;
  let baseInventoryMinor = 0n;
  for (const fill of applied) {
    if (fill.side === SIDES.BUY) {
      spentMinor += BigInt(fill.quoteSpentMinor ?? 0);
      baseInventoryMinor += BigInt(fill.baseReceivedMinor ?? 0);
    } else {
      spentMinor -= BigInt(fill.quoteReceivedMinor ?? 0);
      baseInventoryMinor -= BigInt(fill.baseSoldMinor ?? 0);
    }
  }
  const filledLevelIds = new Set(applied.map((fill) => fill.levelId));
  return {
    fillCount: applied.length,
    filledLevelIds,
    // Net quote deployed. It can go negative once sells exceed buys, which is
    // the strategy having returned more than it spent.
    netQuoteSpentMinor: spentMinor,
    baseInventoryMinor,
    lastFillAt: applied.length ? applied.map((fill) => Date.parse(fill.filledAt)).sort((a, b) => b - a)[0] : null,
  };
}

/* ----------------------------------------------------------- the decision */

/**
 * Decide whether one level may execute right now.
 *
 * Returns a decision object in every case, never throwing, because a refusal
 * is a normal and expected outcome that the agent must be able to publish
 * with its reason. Checks are ordered cheapest and most fundamental first, so
 * the reported reason is the most meaningful one rather than whichever
 * happened to be tested last.
 */
export function evaluateLevel({ strategy, level, observation, fills = [], now = Date.now(), authority = null, intendedCall = null }) {
  const refuse = (reason, detail = null) => ({ allowed: false, reason, detail, levelId: level?.levelId ?? null, strategyId: strategy.strategyId });

  if (strategy.state !== STRATEGY_STATES.ACTIVE) return refuse(GRID_REFUSALS.NOT_ACTIVE, strategy.state);
  if (Date.parse(strategy.guards.expiresAt) <= now) return refuse(GRID_REFUSALS.EXPIRED);
  if (authority && authority.revoked === true) return refuse(GRID_REFUSALS.REVOKED);
  if (authority && authority.expiresAtMs !== undefined && authority.expiresAtMs <= now) return refuse(GRID_REFUSALS.EXPIRED, "authority");

  const known = strategy.levels.find((entry) => entry.levelId === level?.levelId);
  if (!known) return refuse(GRID_REFUSALS.LEVEL_UNKNOWN);

  const ledger = deriveLedger(strategy, fills);
  if (ledger.filledLevelIds.has(known.levelId)) return refuse(GRID_REFUSALS.ALREADY_FILLED);
  if (known.state !== LEVEL_STATES.ARMED) return refuse(GRID_REFUSALS.LEVEL_NOT_ARMED, known.state);

  if (!observation) return refuse(GRID_REFUSALS.NO_PRICE);
  if (observation.chainId !== undefined && observation.chainId !== strategy.chainId) return refuse(GRID_REFUSALS.WRONG_CHAIN, observation.chainId);
  if (observation.baseToken && observation.baseToken.toLowerCase() !== strategy.pair.baseToken) return refuse(GRID_REFUSALS.WRONG_PAIR, observation.baseToken);
  if (observation.quoteToken && observation.quoteToken.toLowerCase() !== strategy.pair.quoteToken) return refuse(GRID_REFUSALS.WRONG_PAIR, observation.quoteToken);
  const age = now - Date.parse(observation.observedAt);
  if (!Number.isFinite(age) || age > strategy.guards.maxPriceAgeMs || age < 0) return refuse(GRID_REFUSALS.STALE_PRICE, age);

  // A buy level triggers when price falls to it; a sell level when price rises
  // to it. Equality counts as reached: a level at exactly the current price is
  // a level the market got to.
  const price = BigInt(observation.priceMinor);
  const levelPrice = BigInt(known.priceMinor);
  const triggered = known.side === SIDES.BUY ? price <= levelPrice : price >= levelPrice;
  if (!triggered) return refuse(GRID_REFUSALS.NOT_TRIGGERED, { priceMinor: String(price), levelPriceMinor: String(levelPrice), side: known.side });

  if (strategy.guards.maxFills !== null && ledger.fillCount >= strategy.guards.maxFills) return refuse(GRID_REFUSALS.MAX_FILLS);
  if (strategy.guards.cooldownMs > 0 && ledger.lastFillAt !== null && now - ledger.lastFillAt < strategy.guards.cooldownMs) {
    return refuse(GRID_REFUSALS.COOLDOWN, strategy.guards.cooldownMs - (now - ledger.lastFillAt));
  }

  const allocation = BigInt(known.allocationMinor);
  if (known.side === SIDES.BUY) {
    const perLevelCap = strategy.capital.maxPerLevelMinor === null ? allocation : BigInt(strategy.capital.maxPerLevelMinor);
    if (allocation > perLevelCap) return refuse(GRID_REFUSALS.PER_LEVEL_CAP, { allocationMinor: String(allocation), perLevelCap: String(perLevelCap) });
    const totalCap = BigInt(strategy.capital.totalCapitalMinor);
    const spentAfter = ledger.netQuoteSpentMinor + allocation;
    if (spentAfter > totalCap) return refuse(GRID_REFUSALS.TOTAL_CAP, { wouldSpendMinor: String(spentAfter), totalCapMinor: String(totalCap) });
  } else if (ledger.baseInventoryMinor <= 0n) {
    // Nothing was bought, so there is nothing to sell. A grid that sold here
    // would be opening a short position the user never authorised.
    return refuse(GRID_REFUSALS.INSUFFICIENT_INVENTORY, String(ledger.baseInventoryMinor));
  }

  if (intendedCall) {
    const to = String(intendedCall.to || "").toLowerCase();
    if (!strategy.authority.allowedContracts.includes(to)) return refuse(GRID_REFUSALS.WRONG_CONTRACT, to);
    if (intendedCall.method && !strategy.authority.allowedMethods.includes(intendedCall.method)) return refuse(GRID_REFUSALS.WRONG_METHOD, intendedCall.method);
    if (intendedCall.side && intendedCall.side !== known.side) return refuse(GRID_REFUSALS.WRONG_DIRECTION, intendedCall.side);
    if (intendedCall.quotedOutMinor !== undefined && intendedCall.minOutMinor !== undefined) {
      if (BigInt(intendedCall.quotedOutMinor) < BigInt(intendedCall.minOutMinor)) {
        return refuse(GRID_REFUSALS.SLIPPAGE, { quotedOutMinor: String(intendedCall.quotedOutMinor), minOutMinor: String(intendedCall.minOutMinor) });
      }
    }
  }

  return {
    allowed: true,
    reason: null,
    strategyId: strategy.strategyId,
    levelId: known.levelId,
    side: known.side,
    levelPriceMinor: String(levelPrice),
    observedPriceMinor: String(price),
    spendMinor: known.side === SIDES.BUY ? String(allocation) : null,
    sellBaseMinor: known.side === SIDES.SELL ? String(ledger.baseInventoryMinor) : null,
    ledger: { fillCount: ledger.fillCount, netQuoteSpentMinor: String(ledger.netQuoteSpentMinor), baseInventoryMinor: String(ledger.baseInventoryMinor) },
  };
}

/**
 * Evaluate every level and return the decisions.
 *
 * Refusals are kept rather than filtered away: the agent page shows why a
 * level did not act, and "nothing happened" is only trustworthy when the
 * reason is visible.
 */
export function evaluateStrategy({ strategy, observation, fills = [], now = Date.now(), authority = null }) {
  const decisions = strategy.levels.map((level) => evaluateLevel({ strategy, level, observation, fills, now, authority }));
  const eligible = decisions.filter((decision) => decision.allowed);
  return {
    strategyId: strategy.strategyId,
    engineVersion: GRID_ENGINE_VERSION,
    evaluatedAt: new Date(now).toISOString(),
    eligible,
    refused: decisions.filter((decision) => !decision.allowed),
    // One action per evaluation. Firing several levels from a single price
    // observation is how a grid bot turns one move into a cascade of trades.
    nextAction: eligible[0] ?? null,
  };
}

/** Compute the minimum acceptable output for a quoted swap. */
export function minimumOut(quotedOutMinor, maxSlippageBps) {
  const quoted = asBigInt(quotedOutMinor, "quotedOutMinor");
  return (quoted * BigInt(10_000 - maxSlippageBps)) / 10_000n;
}

/** Advance strategy state, refusing any move out of a terminal state. */
export function transitionStrategy(strategy, nextState, { now = new Date().toISOString(), reason = null } = {}) {
  if (!Object.values(STRATEGY_STATES).includes(nextState)) throw new Error(`Unknown strategy state: ${nextState}`);
  if (TERMINAL_STRATEGY_STATES.includes(strategy.state)) {
    throw new Error(`Strategy ${strategy.strategyId} is ${strategy.state} and cannot move to ${nextState}.`);
  }
  return { ...strategy, state: nextState, stateChangedAt: now, stateReason: reason };
}
