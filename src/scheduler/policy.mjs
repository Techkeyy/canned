export const DEFAULT_SCHEDULER_POLICY = Object.freeze({
  paused: true,
  network: "bsc-testnet",
  chainId: 97,
  intervalSeconds: 6 * 60 * 60,
  maxAggregateSpendU: 1,
  maxDailySpendU: 0.25,
  maxAttemptsPerProvider: 1,
  cooldownSeconds: 24 * 60 * 60,
  retryAfterFailure: false,
});

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timestamp(value, fallback) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function schedulerSpend(attempts = []) {
  return attempts.reduce((total, attempt) => total + Math.max(0, asNumber(attempt.costU ?? attempt.priceU, 0)), 0);
}

export function providerAttempts(attempts, provider) {
  return attempts.filter((attempt) => String(attempt.provider || attempt.agentIdentity || "") === String(provider));
}

export function isProviderCoolingDown(attempts, provider, { now = Date.now(), cooldownSeconds = DEFAULT_SCHEDULER_POLICY.cooldownSeconds } = {}) {
  const relevant = providerAttempts(attempts, provider).filter((attempt) => ["timeout", "expired", "rejected", "error", "failed"].includes(attempt.status));
  const last = relevant.map((attempt) => timestamp(attempt.endedAt || attempt.createdAt, 0)).sort((a, b) => b - a)[0] || 0;
  return { active: Boolean(last && now < last + cooldownSeconds * 1000), until: last ? new Date(last + cooldownSeconds * 1000).toISOString() : null };
}

export function canSchedule({ attempts = [], provider, policy = DEFAULT_SCHEDULER_POLICY, now = Date.now(), requestedCostU = 0, chainId = 97 } = {}) {
  const spend = schedulerSpend(attempts);
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const dailySpend = schedulerSpend(attempts.filter((attempt) => timestamp(attempt.createdAt, 0) >= todayStart.getTime()));
  const providerCount = providerAttempts(attempts, provider).length;
  const cooldown = isProviderCoolingDown(attempts, provider, { now, cooldownSeconds: policy.cooldownSeconds });
  const checks = [
    [policy.paused !== true, "scheduler_paused"],
    [policy.network === "bsc-testnet" && chainId === 97, "chain_guard_failed"],
    [spend + asNumber(requestedCostU) <= asNumber(policy.maxAggregateSpendU), "aggregate_spend_limit"],
    [dailySpend + asNumber(requestedCostU) <= asNumber(policy.maxDailySpendU), "daily_spend_limit"],
    [providerCount < asNumber(policy.maxAttemptsPerProvider), "provider_attempt_limit"],
    [!cooldown.active || policy.retryAfterFailure === true, "provider_cooldown"],
  ];
  const failed = checks.find(([pass]) => !pass);
  return { allowed: !failed, reason: failed ? failed[1] : null, spend, dailySpend, providerCount, cooldown, remainingAggregateSpendU: Math.max(0, asNumber(policy.maxAggregateSpendU) - spend) };
}

export function schedulerStatus({ attempts = [], policy = DEFAULT_SCHEDULER_POLICY, now = Date.now() } = {}) {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const spend = schedulerSpend(attempts);
  const dailySpend = schedulerSpend(attempts.filter((attempt) => timestamp(attempt.createdAt, 0) >= dayStart.getTime()));
  return {
    paused: policy.paused === true,
    policy,
    spendU: spend,
    dailySpendU: dailySpend,
    attempts: attempts.length,
    remainingAggregateSpendU: Math.max(0, asNumber(policy.maxAggregateSpendU) - spend),
  };
}
