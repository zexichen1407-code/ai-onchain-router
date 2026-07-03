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
    label: "最大输出",
    description: "路线选择优先最大化预期输出，忽略风险惩罚。",
    riskMultiplierBps: 0,
  },
  balanced: {
    id: "balanced",
    label: "平衡策略",
    description: "路线选择会同时权衡预期输出、交易场所、流动性和跳数风险。",
    riskMultiplierBps: 10_000,
  },
  conservative: {
    id: "conservative",
    label: "保守策略",
    description: "路线选择会更重地惩罚可见储备冲击和执行复杂度。",
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
    return ["AI 策略忽略风险惩罚，选择预期输出最高的路线。"];
  }

  const reasons = [
    `AI 在${params.policy.label}下应用 ${params.penaltyBps} 基点总惩罚。`,
  ];
  if ((params.risk.features.hopCount ?? params.route.hops.length) > 1) {
    reasons.push("多跳执行会被额外惩罚。");
  }
  if ((params.risk.features.maxTradePressureBps ?? 0) > 0) {
    reasons.push("可见储备冲击已计入路线效用。");
  }
  if ((params.risk.features.dexRiskBps ?? 0) > 0) {
    reasons.push("交易场所风险已计入路线效用。");
  }
  return reasons;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
