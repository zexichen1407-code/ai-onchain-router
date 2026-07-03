import type { AiRoutingPolicyId } from "./types.js";

export interface AiAdvisorRouteInput {
  routeId: string;
  route: string;
  expectedOut: string;
  aiScore: string;
  aiPenaltyBps: number;
  rawRiskPenaltyBps: number;
  hopCount: number;
  reserveImpactBps: number;
  dexRiskBps: number;
  reasons: string[];
}

export interface AiAdvisorRequest {
  userIntent: {
    from: string;
    to: string;
    amount: string;
    slippageBps: number;
    selectedPolicy: AiRoutingPolicyId;
  };
  selectedRouteId: string;
  routes: AiAdvisorRouteInput[];
}

export interface AiAdvisorRouteNote {
  routeId: string;
  verdict: "prefer" | "acceptable" | "avoid";
  reason: string;
}

export interface AiAdvisorResponse {
  recommendedPolicy: AiRoutingPolicyId;
  recommendedRouteId: string;
  confidence: number;
  thesis: string;
  routeNotes: AiAdvisorRouteNote[];
  warnings: string[];
  actionConstraints: string[];
}

export interface AiAdvisorError {
  error: string;
  setupHint?: string;
}

export function isAiAdvisorResponse(value: unknown): value is AiAdvisorResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AiAdvisorResponse>;
  return (
    isPolicy(candidate.recommendedPolicy) &&
    typeof candidate.recommendedRouteId === "string" &&
    typeof candidate.confidence === "number" &&
    typeof candidate.thesis === "string" &&
    Array.isArray(candidate.routeNotes) &&
    Array.isArray(candidate.warnings) &&
    Array.isArray(candidate.actionConstraints)
  );
}

export function isPolicy(value: unknown): value is AiRoutingPolicyId {
  return value === "max-output" || value === "balanced" || value === "conservative";
}
