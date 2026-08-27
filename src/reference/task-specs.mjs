import { CATEGORIES } from "../domain.mjs";

export const REFERENCE_TASK_SPECS = Object.freeze({
  [CATEGORIES.HEALTH_FACTOR_MONITORING]: {
    version: "1.0.0",
    mode: "authoritative_read_and_bounded_recommendation",
    inputs: ["Venus account", "pool type", "authoritative snapshot", "warning/critical threshold if available"],
    outputs: ["current protocol facts", "liquidation proximity", "changes", "bounded recommendation", "read evidence"],
    safety: ["read-only by default", "no automatic capital movement", "unknown when authoritative data is absent"],
  },
  [CATEGORIES.YIELD_OPTIMISATION]: {
    version: "0.1.0",
    mode: "compare_then_recommend",
    inputs: ["capital", "risk limits", "eligible venues", "observation window"],
    outputs: ["route table", "assumptions", "fees", "risk flags", "bounded recommendation"],
    safety: ["no route execution in first implementation", "all APY values carry as-of time and source"],
  },
  [CATEGORIES.REBALANCING]: {
    version: "0.1.0",
    mode: "observe_range_then_recommend",
    inputs: ["PancakeSwap position", "range policy", "slippage cap", "gas cap"],
    outputs: ["range state", "inventory drift", "fee state", "bounded rebalance proposal"],
    safety: ["read-only first", "no swap or liquidity write without a separate authority grant"],
  },
  [CATEGORIES.GRID_TRADING]: {
    version: "0.1.0",
    mode: "bounded_grid_execution",
    inputs: ["grid bounds", "rungs", "inventory cap", "price-impact cap", "expiry"],
    outputs: ["precommitted grid", "fills", "costs", "inventory", "stops"],
    safety: ["requires explicit session policy", "daily spend cap", "cooldown after failure", "kill switch"],
  },
});
