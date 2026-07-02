import type {
  AiRouteScore,
  AiRoutingPolicy,
  AiRoutingPolicyId,
  CandidateRoute,
  RiskScore,
} from "./types.js";

export const AI_ROUTING_POLICIES: Record<AiRoutingPolicyId, AiRoutingPolicy> = {
  "max-output": {
    id: "max-output",
    label: "Max Output",
    description: "Route selection optimizes expected output and ignores risk penalties.",
    riskMultiplierBps: 0,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Route selection balances expected output with venue, liquidity, and hop risk.",
    riskMultiplierBps: 10_000,
  },
  conservative: {
    id: "conservative",
    label: "Conservative",
    description: "Route selection heavily penalizes visible reserve impact and execution complexity.",
    riskMultiplierBps: 22_000,
  },
};

export function getAiRoutingPolicy(id: AiRoutingPolicyId | undefined): AiRoutingPolicy {
  return AI_ROUTING_POLICIES[id ?? "balanced"] ?? AI_ROUTING_POLICIES.balanced;
}

export function scoreRouteWithPolicy(params: {
  amountOut: bigint;
  policy: AiRoutingPolicy;
  risk: RiskScore;
  route: CandidateRoute;
}): AiRouteScore {
  const weightedPenalty = Math.round(
    (params.risk.penaltyBps * params.policy.riskMultiplierBps) / 10_000,
  );
  const penaltyBps = clamp(weightedPenalty, 0, 9_000);
  const scoreAmountOut = (params.amountOut * BigInt(10_000 - penaltyBps)) / 10_000n;
  const reasons = buildPolicyReasons({
    policy: params.policy,
    risk: params.risk,
    penaltyBps,
    route: params.route,
  });

  return {
    scoreAmountOut,
    penaltyBps,
    reasons,
  };
}

function buildPolicyReasons(params: {
  policy: AiRoutingPolicy;
  risk: RiskScore;
  penaltyBps: number;
  route: CandidateRoute;
}): string[] {
  if (params.policy.id === "max-output") {
    return ["AI policy ignores risk penalties and selects the highest expected output."];
  }

  const reasons = [
    `AI policy applies ${params.penaltyBps} bps total penalty under ${params.policy.label}.`,
  ];
  if ((params.risk.features.hopCount ?? params.route.hops.length) > 1) {
    reasons.push("Multi-hop execution is penalized.");
  }
  if ((params.risk.features.maxTradePressureBps ?? 0) > 0) {
    reasons.push("Visible reserve impact is included in route utility.");
  }
  if ((params.risk.features.dexRiskBps ?? 0) > 0) {
    reasons.push("Venue risk is included in route utility.");
  }
  return reasons;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
