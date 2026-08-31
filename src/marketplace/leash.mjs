/**
 * The Leash: what an execution-capable agent may do, in a user's terms.
 *
 * This module has one rule. Every statement it makes about an agent's
 * authority is derived from the permission object that is actually granted
 * on-chain, never from a description of it. If a session has not been granted,
 * The Leash says NOT_CONFIGURED rather than describing what it would say.
 *
 * The mapping to Altana's schema is exact, and the two places it does not map
 * cleanly are stated rather than smoothed over:
 *
 *   - Altana's spend permission is a cap per rolling PERIOD, not a lifetime
 *     total. A one-hour strategy under a "per day" cap really can spend the
 *     cap once; a three-day strategy under the same cap can spend it three
 *     times. `worstCaseTotalMinor` reports what the permission actually
 *     allows, which is the number a user needs before signing.
 *
 *   - An omitted `to` or `signature` in a call permission means ANY contract
 *     or ANY method. Canned never emits those, and `describeCallPermission`
 *     reports an omission as unrestricted rather than as absent.
 */
import { toFunctionSelector } from "viem";
import { contentHashes } from "../core.mjs";

export const LEASH_VERSION = "leash-v1";

export const LEASH_STATES = Object.freeze({
  NOT_CONFIGURED: "NOT_CONFIGURED",
  PROPOSED: "PROPOSED",
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  REVOKED: "REVOKED",
});

/** Altana spend periods, in milliseconds, for computing the honest total. */
const PERIOD_MS = Object.freeze({
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,   // 30 days, which is how a rolling month is counted here
  year: 31_536_000_000,
});

/** The smallest period that covers a duration, so one cap means one lifetime total. */
export function smallestCoveringPeriod(durationMs) {
  const ordered = ["minute", "hour", "day", "week", "month", "year"];
  return ordered.find((period) => PERIOD_MS[period] >= durationMs) ?? "year";
}

/**
 * What a spend permission really allows over a session's life.
 *
 * A cap of 10 per day across a 3 day session is 30, not 10. Reporting the
 * per-period figure as if it were the total would understate the risk by
 * exactly the factor a user most needs to see.
 */
export function worstCaseSpend({ limit, period }, { durationMs }) {
  const periodMs = PERIOD_MS[period];
  if (!periodMs) throw new Error(`Unknown spend period: ${period}`);
  const periods = Math.max(1, Math.ceil(durationMs / periodMs));
  return { periods, worstCaseTotalMinor: BigInt(limit) * BigInt(periods), perPeriodMinor: BigInt(limit), period };
}

/**
 * Build the Altana `SessionPermissions` for a grid strategy.
 *
 * The strategy is the source of truth: its allowed contracts and methods
 * become the call permissions, and its capital cap becomes the spend
 * permission. Nothing here can be wider than the strategy, which is what
 * makes "the agent cannot increase its own cap" a structural property rather
 * than a promise.
 */
export function proposeSessionPermissions({ strategy, expiresAt, now = Date.now() }) {
  const expiryMs = Date.parse(expiresAt ?? strategy.guards.expiresAt);
  const durationMs = Math.max(1, expiryMs - now);
  const period = smallestCoveringPeriod(durationMs);

  const calls = [];
  for (const to of strategy.authority.allowedContracts) {
    for (const signature of strategy.authority.allowedMethods) {
      // AND semantics: this contract and this method, not either.
      calls.push({ to, signature });
    }
  }

  const spend = [{
    limit: BigInt(strategy.capital.totalCapitalMinor),
    period,
    token: strategy.pair.quoteToken,
  }];

  return {
    permissions: { calls, spend },
    expiry: Math.floor(expiryMs / 1000),
    // Recorded so the UI can state the real ceiling rather than the per-period one.
    derivation: { durationMs, period, ...spendSummary(spend[0], durationMs) },
  };
}

function spendSummary(permission, durationMs) {
  const worst = worstCaseSpend(permission, { durationMs });
  return {
    perPeriodMinor: String(worst.perPeriodMinor),
    periodsCovered: worst.periods,
    worstCaseTotalMinor: String(worst.worstCaseTotalMinor),
  };
}

/** Resolve a call permission into the selector the chain will actually enforce. */
export function describeCallPermission(permission) {
  // Accept either the raw Altana shape ({to, signature}) or one this function
  // already described ({contract, method}). Without this, describing twice
  // silently reports a restricted rule as unrestricted. That direction is at
  // least the safe one, but it is still wrong, and a page that maps over
  // permissions twice should not change what the user is told.
  const to = permission.to ?? permission.contract ?? null;
  const signature = permission.signature ?? permission.method ?? null;
  const anyContract = !to;
  const anyMethod = !signature;
  let selector = null;
  let selectorResolved = true;
  if (!anyMethod) {
    if (/^0x[0-9a-fA-F]{8}$/.test(signature)) {
      selector = signature.toLowerCase();
    } else {
      try {
        selector = toFunctionSelector(signature);
      } catch {
        // A signature that cannot be resolved to a selector cannot be shown as
        // a restriction. Failing closed here means the view reports an
        // unverifiable rule instead of crashing or implying a narrower scope
        // than the chain will actually enforce.
        selectorResolved = false;
      }
    }
  }
  return {
    contract: anyContract ? null : String(to).toLowerCase(),
    anyContract,
    method: anyMethod ? null : signature,
    selector,
    selectorResolved,
    anyMethod,
    // An unrestricted rule is the dangerous one, so it is named plainly. An
    // unresolvable selector counts, because it cannot be proved to be narrow.
    unrestricted: anyContract || anyMethod || !selectorResolved,
  };
}

/**
 * The user-facing permission view.
 *
 * `session` is the object Altana returned from grantSession, or null. Null is
 * not an error and not an empty state to be dressed up: it means no authority
 * exists, and the view says so.
 */
export function buildLeash({ strategy = null, session = null, network = null, revoked = false, now = Date.now() } = {}) {
  const nativeSymbol = network?.chain?.nativeCurrency?.symbol ?? "tBNB";
  if (!strategy || !session) {
    return {
      version: LEASH_VERSION,
      state: LEASH_STATES.NOT_CONFIGURED,
      summary: "This agent has no permission to act. Nothing has been granted, so it cannot trade.",
      can: [],
      cannot: [],
      pair: strategy ? pairLabel(strategy) : null,
      spend: null,
      contracts: [],
      expiresAt: null,
      revocable: false,
      onchain: null,
    };
  }

  const expiryMs = Number(session.expiry) * 1000;
  const state = revoked
    ? LEASH_STATES.REVOKED
    : expiryMs <= now ? LEASH_STATES.EXPIRED : LEASH_STATES.ACTIVE;

  const calls = (session.permissions?.calls ?? []).map(describeCallPermission);
  const durationMs = Math.max(1, expiryMs - Date.parse(strategy.createdAt ?? new Date(now).toISOString()));
  /**
   * Trading capital and the network fee are different things and must never be
   * shown as one number. A permission with no token is the chain's native
   * asset, which the relay takes as its fee; it buys nothing and calls
   * nothing, and presenting it as money the agent may trade with would
   * overstate what the user granted.
   */
  const spendPermissions = (session.permissions?.spend ?? []).map((permission) => {
    const token = permission.token ? String(permission.token).toLowerCase() : null;
    // Altana omits `token` for the native asset; a stored record may have
    // written the zero address instead. Both mean the same thing.
    const isNative = token === null || token === "0x0000000000000000000000000000000000000000";
    const isTradeCapital = !isNative && token === strategy.pair.quoteToken;
    return {
      token,
      tokenSymbol: isTradeCapital ? strategy.pair.quoteSymbol : isNative ? nativeSymbol : null,
      purpose: isTradeCapital ? "trade_capital" : isNative ? "network_fee_only" : "other_token",
      isTradeCapital,
      ...spendSummary(permission, durationMs),
    };
  });
  const tradeSpend = spendPermissions.filter((entry) => entry.isTradeCapital);
  const feeSpend = spendPermissions.filter((entry) => entry.purpose === "network_fee_only");

  // An unrestricted call rule makes every other statement here meaningless, so
  // it is surfaced rather than buried in a list.
  const unrestricted = calls.filter((call) => call.unrestricted);

  return {
    version: LEASH_VERSION,
    state,
    summary: state === LEASH_STATES.ACTIVE
      ? `This agent may trade ${pairLabel(strategy)} on the listed contracts, up to the stated cap, until it expires.`
      : state === LEASH_STATES.REVOKED
        ? "Access was revoked. The agent can no longer act, and its next attempt fails on-chain."
        : "This permission has expired. The agent can no longer act.",
    pair: pairLabel(strategy),
    walletAddress: session.walletAddress ?? null,
    can: [
      `Trade ${pairLabel(strategy)} inside the range you set`,
      `Call only ${calls.length} approved contract and method combination${calls.length === 1 ? "" : "s"}`,
      `Spend at most the trading cap below, from this wallet only`,
      ...(feeSpend.length
        ? [`Use a separate, much smaller amount of ${feeSpend[0].tokenSymbol} to pay the network fee, and nothing else`]
        : []),
    ],
    cannot: [
      "Withdraw your assets to any address",
      "Send funds to an address you did not approve",
      "Call any contract outside the list below",
      "Raise its own spending cap",
      "Extend its own expiry",
      "Act at all after you revoke",
    ],
    contracts: calls,
    unrestrictedRules: unrestricted,
    spend: spendPermissions,
    // Split out so a page cannot accidentally add them together.
    tradeCapital: tradeSpend,
    networkFeeAllowance: feeSpend,
    expiresAt: new Date(expiryMs).toISOString(),
    expiresInSeconds: Math.max(0, Math.floor((expiryMs - now) / 1000)),
    revocable: state === LEASH_STATES.ACTIVE,
    onchain: {
      // What a third party can check for themselves, which is the point of
      // registering the key rather than trusting this page.
      network: network?.chain?.name ?? null,
      chainId: network?.chainId ?? null,
      keyStore: network?.keyStore ?? null,
      sessionPublicKey: session.publicKey ?? null,
      explorer: network?.explorer ?? null,
      registered: session.publicKey ? true : false,
    },
    strategyHash: strategy.hashes?.sha256 ?? null,
  };
}

function pairLabel(strategy) {
  const base = strategy.pair.baseSymbol ?? strategy.pair.baseToken;
  const quote = strategy.pair.quoteSymbol ?? strategy.pair.quoteToken;
  return `${base} / ${quote}`;
}

/**
 * The record a user is shown before they sign.
 *
 * Hashed so what was approved can be compared with what was granted. An
 * approval that cannot be checked afterwards is not much of an approval.
 */
export function buildLeashProposal({ strategy, expiresAt, network, now = Date.now() }) {
  const proposed = proposeSessionPermissions({ strategy, expiresAt, now });
  const record = {
    entity: "LeashProposal",
    version: LEASH_VERSION,
    strategyId: strategy.strategyId,
    strategyHash: strategy.hashes?.sha256 ?? null,
    chainId: network?.chainId ?? strategy.chainId,
    pair: pairLabel(strategy),
    calls: proposed.permissions.calls.map(describeCallPermission),
    spend: {
      token: strategy.pair.quoteToken,
      tokenSymbol: strategy.pair.quoteSymbol,
      perPeriodMinor: proposed.derivation.perPeriodMinor,
      period: proposed.derivation.period,
      periodsCovered: proposed.derivation.periodsCovered,
      worstCaseTotalMinor: proposed.derivation.worstCaseTotalMinor,
    },
    expiry: proposed.expiry,
    expiresAt: new Date(proposed.expiry * 1000).toISOString(),
    proposedAt: new Date(now).toISOString(),
  };
  return { ...record, hashes: contentHashes(record), permissions: proposed.permissions };
}
