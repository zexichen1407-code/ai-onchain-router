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
  executionContext: {
    chain: string;
    tradeType: string;
    selectedByDeterministicScore: string;
    safetyGoal: string;
  };
  stressTests: Array<{
    scenario: string;
    question: string;
  }>;
  selectedRouteId: string;
  routes: AiAdvisorRouteInput[];
}

export interface AiAdvisorRouteNote {
  routeId: string;
  verdict: "prefer" | "acceptable" | "avoid";
  reason: string;
}

export interface AiAdvisorExecutionGate {
  decision: "execute" | "adjust" | "avoid";
  reason: string;
  suggestedSlippageBps: number;
  mustCheck: string[];
}

export interface AiAdvisorScenario {
  scenario: string;
  severity: "low" | "medium" | "high";
  preferredRouteId: string;
  impact: string;
  action: string;
}

export interface AiAdvisorResponse {
  recommendedPolicy: AiRoutingPolicyId;
  recommendedRouteId: string;
  confidence: number;
  thesis: string;
  aiContribution: string;
  executionGate: AiAdvisorExecutionGate;
  scenarios: AiAdvisorScenario[];
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
    typeof candidate.aiContribution === "string" &&
    isExecutionGate(candidate.executionGate) &&
    Array.isArray(candidate.scenarios) &&
    candidate.scenarios.length >= 4 &&
    Array.isArray(candidate.routeNotes) &&
    Array.isArray(candidate.warnings) &&
    Array.isArray(candidate.actionConstraints)
  );
}

export function isPolicy(value: unknown): value is AiRoutingPolicyId {
  return value === "max-output" || value === "balanced" || value === "conservative";
}

function isExecutionGate(value: unknown): value is AiAdvisorExecutionGate {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AiAdvisorExecutionGate>;
  return (
    (candidate.decision === "execute" || candidate.decision === "adjust" || candidate.decision === "avoid") &&
    typeof candidate.reason === "string" &&
    typeof candidate.suggestedSlippageBps === "number" &&
    Array.isArray(candidate.mustCheck)
  );
}
