export function Agent(value = {}) {
  return { entity: "Agent", ...value };
}

export function ServiceCapability(value = {}) {
  return { entity: "ServiceCapability", advertised: false, cannedVerified: false, successfullyUsed: false, ...value };
}

export function HireAttempt(value = {}) {
  return { entity: "HireAttempt", status: "pending", paymentProvenance: null, ...value };
}

export function BenchmarkRun(value = {}) {
  return { entity: "BenchmarkRun", ...value };
}

export function ControlRun(value = {}) {
  return { entity: "ControlRun", ...value };
}

export function Evidence(value = {}) {
  return { entity: "Evidence", ...value };
}

export function TrackRecord(value = {}) {
  return { entity: "TrackRecord", sampleSize: 0, status: "not_enough_data", ...value };
}

export function AgentStatus(value = {}) {
  return { entity: "AgentStatus", label: "LISTED - NOT YET TESTED", ...value };
}
