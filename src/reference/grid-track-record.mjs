/**
 * grid-keeper-track-record-v1.
 *
 * What a grid strategy actually did, derived from recorded sessions rather
 * than asserted. The two rules that matter:
 *
 *   1. A simulated fill is never counted as a real one. Fills carry an
 *      `execution` field and anything that is not `onchain` is excluded from
 *      every realised figure and reported separately.
 *   2. No win rate, no return, and no drawdown is published until there are
 *      enough genuine observations to mean anything. Before that the summary
 *      says what it has, which is counts.
 */
import { contentHashes } from "../core.mjs";

export const GRID_TRACK_RECORD_VERSION = "grid-keeper-track-record-v1";

/** Below this, a rate would be noise dressed as a statistic. */
export const MIN_SESSIONS_FOR_RATE = 3;

export const EXECUTION_KINDS = Object.freeze({
  ONCHAIN: "onchain",
  SIMULATED: "simulated",
});

function sum(values) {
  return values.reduce((total, value) => total + BigInt(value ?? 0), 0n);
}

/**
 * Summarise one strategy session.
 *
 * Realised figures come only from on-chain fills. A session that ran entirely
 * in simulation reports zero realised activity and a simulated count, which is
 * the honest description of a dry run.
 */
export function summarizeGridSession({ strategy, fills = [], refusals = [], revocations = [], endedAt = null, gasWeiSpent = null }) {
  const real = fills.filter((fill) => fill.execution === EXECUTION_KINDS.ONCHAIN && fill.state === "FILLED");
  const simulated = fills.filter((fill) => fill.execution !== EXECUTION_KINDS.ONCHAIN && fill.state === "FILLED");
  const buys = real.filter((fill) => fill.side === "BUY");
  const sells = real.filter((fill) => fill.side === "SELL");

  const quoteSpent = sum(buys.map((fill) => fill.quoteSpentMinor));
  const quoteReceived = sum(sells.map((fill) => fill.quoteReceivedMinor));
  const baseBought = sum(buys.map((fill) => fill.baseReceivedMinor));
  const baseSold = sum(sells.map((fill) => fill.baseSoldMinor));

  return {
    strategyId: strategy.strategyId,
    strategyHash: strategy.hashes?.sha256 ?? null,
    methodologyVersion: GRID_TRACK_RECORD_VERSION,
    pair: `${strategy.pair.baseSymbol ?? strategy.pair.baseToken} / ${strategy.pair.quoteSymbol ?? strategy.pair.quoteToken}`,
    chainId: strategy.chainId,
    range: strategy.range,
    levelCount: strategy.levels.length,
    capitalAtRiskMinor: strategy.capital.totalCapitalMinor,
    startedAt: strategy.createdAt,
    endedAt,
    durationMs: endedAt ? Date.parse(endedAt) - Date.parse(strategy.createdAt) : null,
    fills: {
      onchain: real.length,
      // Named plainly so nobody reads a dry run as trading history.
      simulated: simulated.length,
      buys: buys.length,
      sells: sells.length,
    },
    realised: {
      quoteSpentMinor: String(quoteSpent),
      quoteReceivedMinor: String(quoteReceived),
      netQuoteMinor: String(quoteReceived - quoteSpent),
      baseBoughtMinor: String(baseBought),
      baseSoldMinor: String(baseSold),
      baseInventoryMinor: String(baseBought - baseSold),
      // Gas is only known when a real transaction was mined.
      gasWeiSpent: gasWeiSpent === null ? null : String(gasWeiSpent),
    },
    refusals: refusals.reduce((counts, entry) => ({ ...counts, [entry.reason]: (counts[entry.reason] ?? 0) + 1 }), {}),
    refusalCount: refusals.length,
    revocations: revocations.length,
    revokedEarly: revocations.length > 0,
  };
}

/**
 * The published track record.
 *
 * Everything that would need a sample is null until the sample exists. A grid
 * agent with one session has a story, not a track record, and the difference
 * is the whole point of this project.
 */
export function buildGridTrackRecord({ sessions = [], now = new Date().toISOString() } = {}) {
  const onchainSessions = sessions.filter((session) => session.fills.onchain > 0);
  const totalOnchainFills = onchainSessions.reduce((total, session) => total + session.fills.onchain, 0);
  const totalSimulatedFills = sessions.reduce((total, session) => total + session.fills.simulated, 0);
  const enough = onchainSessions.length >= MIN_SESSIONS_FOR_RATE;

  const record = {
    entity: "GridKeeperTrackRecord",
    methodologyVersion: GRID_TRACK_RECORD_VERSION,
    sessionsRecorded: sessions.length,
    sessionsWithOnchainFills: onchainSessions.length,
    onchainFills: totalOnchainFills,
    simulatedFills: totalSimulatedFills,
    refusalCount: sessions.reduce((total, session) => total + session.refusalCount, 0),
    revocations: sessions.reduce((total, session) => total + session.revocations, 0),
    minimumSessionsForRate: MIN_SESSIONS_FOR_RATE,
    hasEnoughForRate: enough,
    // Null, not zero. Nothing measured these yet.
    realisedReturnBps: enough ? computeRealisedReturnBps(onchainSessions) : null,
    maxDrawdownBps: null,
    maxDrawdownNote: "Not published. Measuring drawdown honestly needs a priced time series per session, which Canned does not yet record.",
    summary: totalOnchainFills === 0
      ? "This agent has not executed a grid trade on chain. There is no track record to report."
      : enough
        ? `${totalOnchainFills} on-chain fills across ${onchainSessions.length} sessions.`
        : `${totalOnchainFills} on-chain fills across ${onchainSessions.length} session${onchainSessions.length === 1 ? "" : "s"}. Not enough sessions to report a rate.`,
    sessions,
    generatedAt: now,
  };
  return { ...record, hashes: contentHashes(record) };
}

/** Net quote across sessions over capital deployed, in basis points. */
function computeRealisedReturnBps(sessions) {
  const net = sum(sessions.map((session) => session.realised.netQuoteMinor));
  const deployed = sum(sessions.map((session) => session.realised.quoteSpentMinor));
  if (deployed === 0n) return null;
  return Number((net * 10_000n) / deployed);
}
