import test from "node:test";
import assert from "node:assert/strict";
import { canSchedule, isProviderCoolingDown, schedulerStatus } from "../src/scheduler/policy.mjs";

const policy = { paused: false, network: "bsc-testnet", chainId: 97, maxAggregateSpendU: 1, maxDailySpendU: 0.25, maxAttemptsPerProvider: 1, cooldownSeconds: 86400, retryAfterFailure: false };

test("scheduler is paused by default and reports the aggregate cap", () => {
  const status = schedulerStatus();
  assert.equal(status.paused, true);
  assert.equal(status.remainingAggregateSpendU, 1);
});

test("scheduler enforces testnet, spend, and provider limits", () => {
  const allowed = canSchedule({ policy, provider: "agent-a", requestedCostU: 0.1, chainId: 97 });
  assert.equal(allowed.allowed, true);
  const mainnet = canSchedule({ policy: { ...policy, network: "bsc-mainnet" }, provider: "agent-a", requestedCostU: 0.1, chainId: 56 });
  assert.equal(mainnet.reason, "chain_guard_failed");
  const overDaily = canSchedule({ policy, provider: "agent-a", requestedCostU: 0.1, chainId: 97, attempts: [{ provider: "other", costU: 0.2, createdAt: new Date().toISOString(), status: "completed" }] });
  assert.equal(overDaily.reason, "daily_spend_limit");
});

test("failed provider attempts enter cooldown and do not auto-retry", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");
  const attempts = [{ provider: "agent-a", costU: 0.05, createdAt: "2026-08-27T11:00:00Z", endedAt: "2026-08-27T11:30:00Z", status: "timeout" }];
  assert.equal(isProviderCoolingDown(attempts, "agent-a", { now, cooldownSeconds: 86400 }).active, true);
  const result = canSchedule({ policy, provider: "agent-a", requestedCostU: 0.05, chainId: 97, now, attempts });
  assert.equal(result.reason, "provider_attempt_limit");
});
